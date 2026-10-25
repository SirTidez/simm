//! Read installed assembly metadata without loading the DLL or resolving its dependencies.
use anyhow::{bail, ensure, Context, Result};
use clrmeta::{
    reader::Reader, CodedIndex, CodedIndexKind, ElementType, Metadata, MethodSig, TableId, TypeSig,
};
use portex::{
    clr::CliHeader,
    reader::{FileReader, ReadAt},
    PeHeaders,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InstalledAssemblyInfo {
    pub name: Option<String>,
    pub version: String,
    pub author: Option<String>,
    pub source: &'static str,
}

/// Scan only CLR metadata on a blocking worker; unreadable/non-managed files
/// retain their existing install metadata rather than failing the whole list.
pub(crate) async fn read_files(
    paths: Vec<PathBuf>,
) -> Result<HashMap<PathBuf, InstalledAssemblyInfo>> {
    tokio::task::spawn_blocking(move || {
        paths
            .into_iter()
            .filter_map(|path| match read(&path) {
                Ok(info) => Some((path, info)),
                Err(error) => {
                    log::debug!(
                        "Could not read local assembly metadata from {}: {error:#}",
                        path.display()
                    );
                    None
                }
            })
            .collect()
    })
    .await
    .context("Local assembly metadata scan stopped")
}

/// A bundle may carry dependencies, runtime variants, or several unrelated
/// mods. Prefer declared MelonInfo identities and require agreement instead of
/// borrowing the first dependency's version or author.
pub(crate) fn package_info(
    infos: impl IntoIterator<Item = InstalledAssemblyInfo>,
) -> Option<InstalledAssemblyInfo> {
    let infos: Vec<_> = infos.into_iter().collect();
    let declared: Vec<_> = infos
        .iter()
        .filter(|info| info.source == "melonInfo")
        .collect();
    if let Some(first) = declared.first() {
        declared
            .iter()
            .all(|info| *info == *first)
            .then(|| (**first).clone())
    } else if infos.len() == 1 {
        infos.into_iter().next()
    } else {
        None
    }
}

pub(crate) fn read(path: &Path) -> Result<InstalledAssemblyInfo> {
    let reader = FileReader::open(path)?;
    let headers = PeHeaders::read_from(&reader, 0)?;
    let cli = headers
        .optional_header
        .data_directories()
        .get(14)
        .context("No CLR directory")?;
    ensure!(
        cli.virtual_address != 0 && cli.size >= CliHeader::SIZE as u32,
        "No CLR header"
    );
    let cli_bytes = read_rva(&reader, &headers, cli.virtual_address, CliHeader::SIZE)?;
    let cli = CliHeader::parse(&cli_bytes)?;
    // Asset-heavy mods may be hundreds of MB. Read headers and metadata only,
    // never embedded Unity bundles, native resources, or executable code.
    ensure!(
        cli.metadata_size > 0 && cli.metadata_size <= 64 * 1024 * 1024,
        "CLR metadata exceeds the 64 MiB scan limit"
    );
    let bytes = read_rva(
        &reader,
        &headers,
        cli.metadata_rva,
        cli.metadata_size as usize,
    )?;
    from_metadata(&parse_metadata(&bytes)?)
}

fn read_rva(reader: &FileReader, headers: &PeHeaders, rva: u32, length: usize) -> Result<Vec<u8>> {
    ensure!(
        length > 0 && length <= u32::MAX as usize,
        "Invalid CLR range"
    );
    let start = headers
        .rva_to_offset(rva)
        .context("CLR RVA is outside file-backed sections")?;
    let last_rva = rva
        .checked_add(length as u32 - 1)
        .context("CLR range overflow")?;
    let last = headers
        .rva_to_offset(last_rva)
        .context("CLR range is outside file-backed sections")?;
    ensure!(
        u64::from(last) == u64::from(start) + length as u64 - 1
            && u64::from(last) < reader.file_size(),
        "CLR range exceeds the file"
    );
    Ok(reader.read_bytes_at(u64::from(start), length)?)
}

fn parse_metadata(bytes: &[u8]) -> Result<Metadata> {
    let root = clrmeta::MetadataRoot::parse(bytes)?;
    // clrmeta 0.1 slices stream ranges and preallocates table rows. Validate
    // those file-controlled bounds before invoking its high-level parser.
    for stream in &root.streams {
        ensure!(
            u64::from(stream.offset) + u64::from(stream.size) <= bytes.len() as u64,
            "CLR stream exceeds metadata"
        );
    }
    let tables = root.tables_stream().context("No CLR tables")?;
    let data = &bytes[tables.offset as usize..tables.offset as usize + tables.size as usize];
    let mut reader = Reader::new(data);
    let header = clrmeta::TablesHeader::parse(&mut reader, tables.name == "#-")?;
    let context = header.context();
    let mut required = 0u64;
    for (index, count) in header
        .row_counts
        .iter()
        .enumerate()
        .filter(|(_, count)| **count != 0)
    {
        let table = TableId::from_u8(index as u8).context("Unsupported CLR table")?;
        required += u64::from(*count) * context.row_size(table) as u64;
    }
    ensure!(
        required <= reader.remaining() as u64,
        "CLR table counts exceed metadata"
    );
    Ok(Metadata::parse(bytes)?)
}

fn from_metadata(metadata: &Metadata) -> Result<InstalledAssemblyInfo> {
    for attribute in &metadata.custom_attributes {
        if attribute.parent.table != Some(TableId::Assembly) || attribute.parent.row != 1 {
            continue;
        }
        let Some((declaring_type, name, signature)) = constructor(metadata, attribute.attr_type)
        else {
            continue;
        };
        if name != ".ctor"
            || !matches!(
                declaring_type.as_str(),
                "MelonLoader.MelonInfoAttribute"
                    | "MelonLoader.MelonModInfoAttribute"
                    | "MelonLoader.MelonPluginInfoAttribute"
            )
        {
            continue;
        }
        let decoded = (|| -> Result<InstalledAssemblyInfo> {
            let signature = metadata.blobs.get(signature)?;
            // These constructors have at most eight fixed arguments. Bound
            // the signature before MethodSig preallocates its parameter list.
            ensure!(
                signature.len() <= 128
                    && signature.first() == Some(&0x20)
                    && matches!(signature.get(1), Some(4..=8)),
                "Unsupported MelonInfo signature"
            );
            let signature = MethodSig::parse_blob(signature)?;
            decode_melon_info(
                metadata,
                &signature.params,
                metadata.blobs.get(attribute.value)?,
            )
        })();
        if let Ok(info) = decoded {
            return Ok(info);
        }
    }
    let assembly = metadata.assembly().context("No assembly version")?;
    Ok(InstalledAssemblyInfo {
        name: None,
        version: assembly.version_string(),
        author: None,
        source: "assembly",
    })
}

fn constructor(metadata: &Metadata, index: CodedIndex) -> Option<(String, &str, u32)> {
    match index.table? {
        TableId::MemberRef => {
            let member = metadata
                .member_refs
                .get(index.row.checked_sub(1)? as usize)?;
            Some((
                metadata.resolve_type(&member.class)?.full_name(),
                metadata.strings.get(member.name).ok()?,
                member.signature,
            ))
        }
        TableId::MethodDef => {
            let method = metadata
                .method_defs
                .get(index.row.checked_sub(1)? as usize)?;
            let (i, _) = metadata.type_defs.iter().enumerate().find(|(i, ty)| {
                let end = metadata
                    .type_defs
                    .get(i + 1)
                    .map(|ty| ty.method_list)
                    .unwrap_or(metadata.method_defs.len() as u32 + 1);
                index.row >= ty.method_list && index.row < end
            })?;
            let ty = CodedIndex {
                table: Some(TableId::TypeDef),
                row: i as u32 + 1,
            };
            Some((
                metadata.resolve_type(&ty)?.full_name(),
                metadata.strings.get(method.name).ok()?,
                method.signature,
            ))
        }
        _ => None,
    }
}

fn string(reader: &mut Reader<'_>) -> Result<Option<String>> {
    if reader.peek_u8()? == 0xff {
        reader.read_u8()?;
        return Ok(None);
    }
    let length = reader.read_compressed_uint()? as usize;
    ensure!(length <= 64 * 1024, "MelonInfo string exceeds scan limit");
    Ok(Some(
        std::str::from_utf8(reader.read_bytes(length)?)?.to_string(),
    ))
}

fn decode_melon_info(
    metadata: &Metadata,
    params: &[TypeSig],
    blob: &[u8],
) -> Result<InstalledAssemblyInfo> {
    let Some(TypeSig::Class(ty)) = params.first() else {
        bail!("Missing System.Type argument");
    };
    ensure!(
        metadata
            .resolve_type(&CodedIndex::decode(CodedIndexKind::TypeDefOrRef, *ty))
            .is_some_and(|ty| ty.full_name() == "System.Type"),
        "Invalid MelonInfo type argument"
    );
    let is_string = |ty: &TypeSig| matches!(ty, TypeSig::Primitive(ElementType::String));
    let mut reader = Reader::new(blob);
    ensure!(reader.read_u16()? == 1, "Invalid custom attribute prolog");
    string(&mut reader)?; // Serialized System.Type; never resolve/load it.
    ensure!(
        params.get(1).is_some_and(is_string),
        "Invalid MelonInfo name"
    );
    let name = string(&mut reader)?.filter(|value| !value.trim().is_empty());
    let (version, author) = if matches!(params.len(), 4 | 5) && params[2..].iter().all(is_string) {
        let version = string(&mut reader)?
            .filter(|value| !value.trim().is_empty())
            .context("Empty declared mod version")?;
        let author = string(&mut reader)?;
        if params.len() == 5 {
            string(&mut reader)?;
        }
        (version, author)
    } else {
        ensure!(
            matches!(params.len(), 7 | 8)
                && params[2..5]
                    .iter()
                    .all(|ty| matches!(ty, TypeSig::Primitive(ElementType::I4)))
                && params[5..].iter().all(is_string),
            "Unsupported MelonInfo constructor"
        );
        let major = reader.read_u32()? as i32;
        let minor = reader.read_u32()? as i32;
        let patch = reader.read_u32()? as i32;
        ensure!(
            major >= 0 && minor >= 0 && patch >= 0,
            "Invalid numeric mod version"
        );
        let identifier = if params.len() == 8 {
            string(&mut reader)?
        } else {
            None
        };
        let version = format!(
            "{major}.{minor}.{patch}{}",
            identifier
                .filter(|value| !value.is_empty())
                .map(|value| format!("-{value}"))
                .unwrap_or_default()
        );
        let author = string(&mut reader)?;
        string(&mut reader)?;
        (version, author)
    };
    // Current MelonInfo properties have no public setters. Reject unexpected
    // named overrides rather than showing a potentially different version.
    ensure!(
        reader.read_u16()? == 0 && reader.remaining() == 0,
        "Unsupported MelonInfo named arguments"
    );
    Ok(InstalledAssemblyInfo {
        name,
        version,
        author: author.filter(|value| !value.trim().is_empty()),
        source: "melonInfo",
    })
}

#[cfg(test)]
#[path = "melon_metadata/tests.rs"]
mod tests;
