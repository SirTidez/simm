//! Local, bounded Latest.log observation. Independent of the Logs workspace and upload telemetry.
use crate::services::melon_log::{header, is_level};
use crate::types::{
    NativeConsoleEntry, NativeConsoleMessage, NativeConsoleMessageOrigin, NativeConsoleMessages,
    NativeConsoleSourceCounts,
};
use std::{
    collections::{HashMap, VecDeque},
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

const READ_BUDGET: usize = 256 * 1024;
const RETAINED_MESSAGES: usize = 500;
const MAX_TEXT: usize = 16 * 1024;
const ANCHOR_SIZE: usize = 128;

#[derive(Default)]
pub(super) struct Diagnostics {
    process: Option<(u32, u64)>,
    created: Option<SystemTime>,
    offset: u64,
    anchor: Vec<u8>,
    pending: Vec<u8>,
    line_overflow: bool,
    line_bytes: usize,
    previous_byte: u8,
    utf16: Option<bool>, // Some(true) = little endian, Some(false) = big endian.
    lines: u64,
    generation: u64,
    errors: u64,
    warnings: u64,
    entries: VecDeque<NativeConsoleMessage>,
    continuing: bool,
    startup_notice: Option<NativeConsoleMessage>,
    source_counts: HashMap<Option<String>, (u64, u64)>,
}

impl Diagnostics {
    pub(super) fn update(
        &mut self,
        path: &Path,
        process: Option<(u32, u64)>,
        inventory: &[NativeConsoleEntry],
    ) -> NativeConsoleMessages {
        if process != self.process {
            let generation = self.generation + 1;
            *self = Self {
                process,
                generation,
                ..Self::default()
            };
        }
        let Some((_, started)) = process else {
            return self.view("waiting", None, inventory);
        };
        let result = self.read(path, started);
        match result {
            Ok(state) => self.view(state, None, inventory),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.view("waiting", None, inventory)
            }
            Err(error) => self.view(
                "unavailable",
                Some(format!("Latest.log: {error}")),
                inventory,
            ),
        }
    }

    fn view(
        &self,
        state: &str,
        diagnostic: Option<String>,
        inventory: &[NativeConsoleEntry],
    ) -> NativeConsoleMessages {
        let mut sources: Vec<_> = self
            .source_counts
            .iter()
            .map(|(source, (errors, warnings))| NativeConsoleSourceCounts {
                source: source.clone(),
                origin: source
                    .as_deref()
                    .and_then(|source| origin(source, inventory)),
                errors: *errors,
                warnings: *warnings,
            })
            .collect();
        sources.sort_by(|a, b| a.source.cmp(&b.source));
        NativeConsoleMessages {
            errors: self.errors,
            warnings: self.warnings,
            entries: self
                .entries
                .iter()
                .rev()
                .map(|entry| {
                    let mut entry = entry.clone();
                    entry.origin = entry
                        .source
                        .as_deref()
                        .and_then(|source| origin(source, inventory));
                    entry
                })
                .collect(),
            omitted: (self.errors + self.warnings).saturating_sub(self.entries.len() as u64),
            generation: self.generation,
            state: state.into(),
            diagnostic,
            sources,
        }
    }

    fn read(&mut self, path: &Path, started: u64) -> std::io::Result<&'static str> {
        let mut file = File::open(path)?;
        let metadata = file.metadata()?;
        // A previous launch's Latest.log must not be presented as this launch's messages.
        let modified = metadata
            .modified()?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        if modified < started {
            return Ok("waiting");
        }
        let created = metadata.created().ok();
        let mut replaced =
            metadata.len() < self.offset || (self.offset > 0 && created != self.created);
        if self.offset > 0 && !replaced {
            file.seek(SeekFrom::Start(self.offset - self.anchor.len() as u64))?;
            let mut anchor = vec![0; self.anchor.len()];
            file.read_exact(&mut anchor)?;
            replaced = anchor != self.anchor;
        }
        if replaced {
            *self = Self {
                process: self.process,
                generation: self.generation + 1,
                ..Self::default()
            };
        }
        self.created = created;
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes = Vec::new();
        std::io::Read::by_ref(&mut file)
            .take(READ_BUDGET as u64)
            .read_to_end(&mut bytes)?;
        if self.offset == 0 {
            // Wait for a complete BOM before deciding the encoding.
            if bytes.len() < 3 && metadata.len() < 3 {
                return Ok("reading");
            }
            self.utf16 = match bytes.get(..2) {
                Some([0xff, 0xfe]) => Some(true),
                Some([0xfe, 0xff]) => Some(false),
                _ => None,
            };
        }
        self.offset += bytes.len() as u64;
        if self.anchor.len() + bytes.len() > ANCHOR_SIZE {
            let mut tail = std::mem::take(&mut self.anchor);
            tail.extend_from_slice(&bytes);
            self.anchor = tail[tail.len().saturating_sub(ANCHOR_SIZE)..].to_vec();
        } else {
            self.anchor.extend_from_slice(&bytes);
        }
        self.consume(&bytes);
        Ok(if self.offset < metadata.len() {
            "reading"
        } else {
            "ready"
        })
    }

    fn consume(&mut self, bytes: &[u8]) {
        // Keep incomplete UTF-8 characters / UTF-16 units in the line buffer until newline.
        for byte in bytes {
            self.line_bytes += 1;
            if self.pending.len() < MAX_TEXT * 2 {
                self.pending.push(*byte);
            } else {
                self.line_overflow = true;
            }
            let newline = match self.utf16 {
                Some(little) => {
                    self.line_bytes % 2 == 0
                        && [self.previous_byte, *byte] == if little { [10, 0] } else { [0, 10] }
                }
                None => *byte == b'\n',
            };
            self.previous_byte = *byte;
            if newline {
                let text = if let Some(little) = self.utf16 {
                    let units: Vec<_> = self
                        .pending
                        .chunks_exact(2)
                        .map(|chunk| {
                            if little {
                                u16::from_le_bytes([chunk[0], chunk[1]])
                            } else {
                                u16::from_be_bytes([chunk[0], chunk[1]])
                            }
                        })
                        .collect();
                    String::from_utf16_lossy(&units)
                } else {
                    String::from_utf8_lossy(&self.pending).into_owned()
                };
                self.lines += 1;
                self.line(
                    text.trim_matches(['\u{feff}', '\r', '\n']),
                    self.line_overflow,
                );
                self.pending.clear();
                self.line_overflow = false;
                self.line_bytes = 0;
            }
        }
    }

    fn line(&mut self, line: &str, truncated: bool) {
        let (timestamp, tags, text) = header(line);
        let level = match crate::services::melon_log::severity(&tags) {
            "ERROR" => Some("error"),
            "WARN" => Some("warning"),
            _ => None,
        };
        if let Some(level) = level {
            self.startup_notice = None;
            let source = tags
                .iter()
                .find(|tag| !is_level(tag))
                .map(|tag| (*tag).to_owned());
            let (message, clipped) = clip(text, MAX_TEXT);
            let entry = NativeConsoleMessage {
                id: 0,
                line_number: self.lines,
                level: level.into(),
                timestamp: timestamp.map(str::to_owned),
                source,
                origin: None,
                message,
                truncated: truncated || clipped,
            };
            if is_expected_interop_startup_notice(&entry) {
                // Keep a candidate until the next header: additional nonempty
                // continuation text makes this a different warning and must surface.
                self.startup_notice = Some(entry);
                self.continuing = false;
                return;
            }
            self.push(entry);
            self.continuing = true;
        } else if timestamp.is_none() && tags.is_empty() {
            if let Some(mut notice) = self.startup_notice.take() {
                if line.trim().is_empty() && !truncated {
                    append_message(&mut notice, line, false);
                    self.startup_notice = Some(notice);
                    return;
                }
                self.push(notice);
                self.continuing = true;
            }
            if self.continuing {
                if let Some(entry) = self.entries.back_mut() {
                    append_message(entry, line, truncated);
                }
            }
        } else {
            self.startup_notice = None;
            self.continuing = false;
        }
    }

    fn push(&mut self, mut entry: NativeConsoleMessage) {
        let source_counts = self.source_counts.entry(entry.source.clone()).or_default();
        if entry.level == "error" {
            self.errors += 1;
            source_counts.0 += 1;
        } else {
            self.warnings += 1;
            source_counts.1 += 1;
        }
        entry.id = self.errors + self.warnings;
        self.entries.push_back(entry);
        if self.entries.len() > RETAINED_MESSAGES {
            self.entries.pop_front();
        }
    }
}

fn is_expected_interop_startup_notice(entry: &NativeConsoleMessage) -> bool {
    crate::services::melon_log::expected_interop_notice(
        &entry.level,
        entry.source.as_deref(),
        &entry.message,
        entry.truncated,
    )
}

fn append_message(entry: &mut NativeConsoleMessage, line: &str, truncated: bool) {
    let remaining = MAX_TEXT.saturating_sub(entry.message.len());
    let (text, clipped) = clip(line, remaining.saturating_sub(1));
    if remaining > 0 {
        entry.message.push('\n');
        entry.message.push_str(&text);
    }
    entry.truncated |= truncated || clipped;
}

fn clip(text: &str, max: usize) -> (String, bool) {
    let mut end = max.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].into(), end < text.len())
}

fn normalized(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn origin(source: &str, inventory: &[NativeConsoleEntry]) -> Option<NativeConsoleMessageOrigin> {
    let builtin = match source.to_ascii_lowercase().as_str() {
        "melonloader" | "melonloader.bootstrap" | "il2cppinterop" | "il2cppassemblygenerator" => {
            Some("Loader")
        }
        "unity" => Some("Game"),
        _ => None,
    };
    if let Some(kind) = builtin {
        return Some(NativeConsoleMessageOrigin {
            name: source.to_owned(),
            file_name: None,
            kind: kind.into(),
        });
    }
    let source = normalized(source);
    if source.is_empty() {
        return None;
    }
    let mut matches = inventory.iter().filter(|entry| {
        normalized(&entry.name) == source
            || entry.file_name.as_deref().is_some_and(|file| {
                let file = file
                    .rsplit(['/', '\\'])
                    .next()
                    .unwrap_or(file)
                    .to_lowercase();
                let file = file.strip_suffix(".disabled").unwrap_or(&file);
                normalized(file.strip_suffix(".dll").unwrap_or(file)) == source
            })
    });
    let entry = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(NativeConsoleMessageOrigin {
        name: entry.name.clone(),
        file_name: entry.file_name.clone(),
        kind: entry.kind.clone(),
    })
}

#[cfg(test)]
mod tests;
