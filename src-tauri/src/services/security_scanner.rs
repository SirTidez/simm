use crate::db;
use crate::types::{
    SecurityFindingSeverity, SecurityScanDisposition, SecurityScanDispositionClassification,
    SecurityScanFileReport, SecurityScanPolicy, SecurityScanReport, SecurityScanState,
    SecurityScanSummary, SecurityScannerStatus, Settings,
};
use crate::utils::http_identity;
use anyhow::{Context, Result};
use chrono::Utc;
use reqwest::StatusCode;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::fs;
use tokio::process::Command;
use unrar::Archive;
use uuid::Uuid;
use zip::ZipArchive;

const GITHUB_RELEASES_LATEST_URL: &str =
    "https://api.github.com/repos/ifBars/MLVScan.DevCLI/releases/latest";
const NUGET_PACKAGE_NAME: &str = "MLVScan.DevCLI";
const WINDOWS_ZIP_ASSET_NAME: &str = "mlvscan-win-x64.zip";
const WINDOWS_SHA256_ASSET_NAME: &str = "mlvscan-win-x64.sha256";

#[derive(Clone)]
pub struct SecurityScannerService {
    client: reqwest::Client,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubReleaseAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliInfo {
    platform_version: String,
    schema_version: String,
}

#[derive(Debug, Clone)]
struct ResolvedScannerExecutable {
    path: PathBuf,
    install_method: String,
}

impl SecurityScannerService {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .user_agent(http_identity::user_agent())
            .connect_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(300))
            .build()
            .expect("Failed to build security scanner HTTP client");

        Self { client }
    }

    pub async fn get_status(&self, settings: &Settings) -> Result<SecurityScannerStatus> {
        let enabled = settings.enable_security_scanner.unwrap_or(true);
        let auto_install = settings.auto_install_security_scanner.unwrap_or(true);

        let mut status = SecurityScannerStatus {
            enabled,
            auto_install,
            installed: false,
            install_method: None,
            installed_version: None,
            latest_version: None,
            schema_version: None,
            executable_path: None,
            update_available: None,
            last_error: None,
        };

        if let Some(executable) = self.resolve_executable().await? {
            status.executable_path = Some(executable.path.to_string_lossy().to_string());
            status.install_method = Some(executable.install_method.clone());
            match self.read_cli_info(&executable.path).await {
                Ok(info) => {
                    status.installed = true;
                    status.installed_version = Some(info.platform_version);
                    status.schema_version = Some(info.schema_version);
                }
                Err(error) => {
                    status.last_error = Some(error.to_string());
                }
            }
        }

        match self.fetch_latest_release().await {
            Ok(release) => {
                status.latest_version = Some(release.tag_name.clone());
                status.update_available = status.installed_version.as_ref().map(|installed| {
                    installed.trim_start_matches('v') != release.tag_name.trim_start_matches('v')
                });
            }
            Err(error) => {
                if status.last_error.is_none() {
                    status.last_error = Some(error.to_string());
                }
            }
        }

        Ok(status)
    }

    pub async fn install_latest(&self, settings: &Settings) -> Result<SecurityScannerStatus> {
        let installed = if self.has_dotnet_sdk_8().await? {
            match self.install_with_dotnet_tool().await {
                Ok(executable) => executable,
                Err(dotnet_error) => {
                    log::warn!(
                        "Failed to install MLVScan via dotnet tool, falling back to release binary: {}",
                        dotnet_error
                    );
                    self.install_with_binary_release().await?
                }
            }
        } else {
            self.install_with_binary_release().await?
        };

        let installed_info = self
            .read_cli_info(&installed.path)
            .await
            .context("Failed to read installed scanner metadata")?;
        let latest_release = self.fetch_latest_release().await.ok();

        Ok(SecurityScannerStatus {
            enabled: settings.enable_security_scanner.unwrap_or(true),
            auto_install: settings.auto_install_security_scanner.unwrap_or(true),
            installed: true,
            install_method: Some(installed.install_method),
            installed_version: Some(installed_info.platform_version),
            latest_version: latest_release.map(|release| release.tag_name),
            schema_version: Some(installed_info.schema_version),
            executable_path: Some(installed.path.to_string_lossy().to_string()),
            update_available: Some(false),
            last_error: None,
        })
    }

    pub async fn scan_artifact(
        &self,
        file_path: &Path,
        settings: &Settings,
    ) -> Result<SecurityScanReport> {
        if !settings.enable_security_scanner.unwrap_or(true) {
            return Ok(Self::disabled_report());
        }

        let executable = match self.ensure_executable(settings).await {
            Ok(path) => path,
            Err(error) => return Ok(Self::unavailable_report(error.to_string(), settings)),
        };

        let cli_info = match self.read_cli_info(&executable.path).await {
            Ok(info) => info,
            Err(error) => return Ok(Self::unavailable_report(error.to_string(), settings)),
        };

        let extension = file_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        let files = match extension.as_str() {
            "dll" => vec![
                self.scan_assembly_file(
                    &executable.path,
                    file_path,
                    file_path.to_string_lossy().as_ref(),
                )
                .await?,
            ],
            "zip" => {
                self.scan_archive(&executable.path, file_path, ArchiveKind::Zip)
                    .await?
            }
            "rar" => {
                self.scan_archive(&executable.path, file_path, ArchiveKind::Rar)
                    .await?
            }
            _ => Vec::new(),
        };

        if files.is_empty() {
            return Ok(Self::skipped_report(
                cli_info.platform_version,
                cli_info.schema_version,
                "No .dll files were detected in the downloaded archive.",
            ));
        }

        Ok(Self::build_report(files, cli_info, settings))
    }

    async fn ensure_executable(&self, settings: &Settings) -> Result<ResolvedScannerExecutable> {
        if let Some(path) = self.resolve_executable().await? {
            return Ok(path);
        }

        if !settings.auto_install_security_scanner.unwrap_or(true) {
            return Err(anyhow::anyhow!(
                "MLVScan Security Scanner is not installed and automatic setup is disabled"
            ));
        }

        let status = self.install_latest(settings).await?;
        match (status.executable_path, status.install_method) {
            (Some(path), Some(method)) => Ok(ResolvedScannerExecutable {
                path: PathBuf::from(path),
                install_method: method,
            }),
            _ => Err(anyhow::anyhow!(
                "Scanner installation completed without an executable path"
            )),
        }
    }

    async fn resolve_executable(&self) -> Result<Option<ResolvedScannerExecutable>> {
        let executable = self.binary_install_dir()?.join("mlvscan.exe");
        if executable.exists() {
            return Ok(Some(ResolvedScannerExecutable {
                path: executable,
                install_method: "managedBinary".to_string(),
            }));
        }

        let dotnet_tool_executable = self.dotnet_tool_install_dir()?.join("mlvscan.exe");
        if dotnet_tool_executable.exists() {
            return Ok(Some(ResolvedScannerExecutable {
                path: dotnet_tool_executable,
                install_method: "managedDotnetTool".to_string(),
            }));
        }

        if let Some(path_executable) = self.detect_global_mlvscan().await? {
            return Ok(Some(ResolvedScannerExecutable {
                path: path_executable,
                install_method: "globalTool".to_string(),
            }));
        }

        Ok(None)
    }

    fn tool_root_dir(&self) -> Result<PathBuf> {
        Ok(db::get_data_dir()?
            .join("tools")
            .join("mlvscan-security-scanner"))
    }

    fn binary_install_dir(&self) -> Result<PathBuf> {
        Ok(self.tool_root_dir()?.join("current"))
    }

    fn dotnet_tool_install_dir(&self) -> Result<PathBuf> {
        Ok(self.tool_root_dir()?.join("dotnet-tool"))
    }

    async fn has_dotnet_sdk_8(&self) -> Result<bool> {
        let mut command = Command::new("dotnet");
        command.arg("--list-sdks");
        Self::apply_windows_flags(&mut command);

        let output = match command.output().await {
            Ok(output) => output,
            Err(_) => return Ok(false),
        };

        if !output.status.success() {
            return Ok(false);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout
            .lines()
            .any(|line| line.trim_start().starts_with("8.")))
    }

    async fn detect_global_mlvscan(&self) -> Result<Option<PathBuf>> {
        let locator = if cfg!(target_os = "windows") {
            "where"
        } else {
            "which"
        };

        let mut command = Command::new(locator);
        command.arg("mlvscan");
        Self::apply_windows_flags(&mut command);

        let output = match command.output().await {
            Ok(output) => output,
            Err(_) => return Ok(None),
        };

        if !output.status.success() {
            return Ok(None);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let path = stdout
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(PathBuf::from)
            .filter(|path| path.exists());

        Ok(path)
    }

    async fn install_with_dotnet_tool(&self) -> Result<ResolvedScannerExecutable> {
        let install_dir = self.dotnet_tool_install_dir()?;
        fs::create_dir_all(&install_dir)
            .await
            .context("Failed to create dotnet tool installation directory")?;

        let executable_path = install_dir.join("mlvscan.exe");
        let mut command = Command::new("dotnet");
        command.arg("tool");
        if executable_path.exists() {
            command.arg("update");
        } else {
            command.arg("install");
        }
        command.arg(NUGET_PACKAGE_NAME);
        command.arg("--tool-path");
        command.arg(&install_dir);
        Self::apply_windows_flags(&mut command);

        let output = command
            .output()
            .await
            .context("Failed to execute dotnet tool installation for MLVScan")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(anyhow::anyhow!(
                "dotnet tool setup failed: {}{}{}",
                stdout.trim(),
                if stdout.trim().is_empty() || stderr.trim().is_empty() {
                    ""
                } else {
                    "\n"
                },
                stderr.trim()
            ));
        }

        if !executable_path.exists() {
            return Err(anyhow::anyhow!(
                "dotnet tool reported success but mlvscan.exe was not found"
            ));
        }

        Ok(ResolvedScannerExecutable {
            path: executable_path,
            install_method: "managedDotnetTool".to_string(),
        })
    }

    async fn install_with_binary_release(&self) -> Result<ResolvedScannerExecutable> {
        let release = self.fetch_latest_release().await?;
        let zip_asset = release
            .assets
            .iter()
            .find(|asset| asset.name.eq_ignore_ascii_case(WINDOWS_ZIP_ASSET_NAME))
            .cloned()
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Latest MLVScan release does not contain {}",
                    WINDOWS_ZIP_ASSET_NAME
                )
            })?;
        let checksum_asset = release
            .assets
            .iter()
            .find(|asset| asset.name.eq_ignore_ascii_case(WINDOWS_SHA256_ASSET_NAME))
            .cloned()
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Latest MLVScan release does not contain {}",
                    WINDOWS_SHA256_ASSET_NAME
                )
            })?;

        let zip_bytes = self
            .download_asset(&zip_asset.browser_download_url)
            .await
            .context("Failed to download MLVScan scanner archive")?;
        let checksum_bytes = self
            .download_asset(&checksum_asset.browser_download_url)
            .await
            .context("Failed to download MLVScan scanner checksum")?;

        let expected_checksum = String::from_utf8(checksum_bytes)
            .context("Scanner checksum file was not valid UTF-8")?
            .split_whitespace()
            .next()
            .map(|value| value.to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                anyhow::anyhow!("Scanner checksum file did not contain a SHA-256 hash")
            })?;

        let actual_checksum = Self::hash_bytes(&zip_bytes);
        if actual_checksum != expected_checksum {
            return Err(anyhow::anyhow!(
                "Scanner checksum verification failed (expected {}, got {})",
                expected_checksum,
                actual_checksum
            ));
        }

        let tool_root = self.tool_root_dir()?;
        let temp_root = tool_root
            .join("tmp")
            .join(format!("install-{}", Uuid::new_v4()));
        let staged_dir = temp_root.join("staged");
        fs::create_dir_all(&staged_dir)
            .await
            .context("Failed to create scanner staging directory")?;

        let archive_path = temp_root.join(&zip_asset.name);
        fs::write(&archive_path, &zip_bytes)
            .await
            .context("Failed to write scanner archive to disk")?;

        self.extract_zip_to_directory(&archive_path, &staged_dir)
            .await
            .context("Failed to extract scanner archive")?;

        let staged_executable = self
            .find_scanner_executable(&staged_dir)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Scanner archive did not contain mlvscan.exe"))?;
        self.read_cli_info(&staged_executable)
            .await
            .context("Failed to validate extracted scanner binary")?;

        let install_dir = self.binary_install_dir()?;
        if install_dir.exists() {
            let _ = fs::remove_dir_all(&install_dir).await;
        }
        if let Some(parent) = install_dir.parent() {
            fs::create_dir_all(parent)
                .await
                .context("Failed to create scanner installation directory")?;
        }

        fs::rename(&staged_dir, &install_dir)
            .await
            .context("Failed to move scanner into its installation directory")?;
        let _ = fs::remove_dir_all(&temp_root).await;

        let installed_executable = install_dir.join("mlvscan.exe");
        if !installed_executable.exists() {
            return Err(anyhow::anyhow!(
                "Scanner install completed but executable was not found"
            ));
        }

        Ok(ResolvedScannerExecutable {
            path: installed_executable,
            install_method: "managedBinary".to_string(),
        })
    }

    async fn fetch_latest_release(&self) -> Result<GithubRelease> {
        let response = self
            .client
            .get(GITHUB_RELEASES_LATEST_URL)
            .send()
            .await
            .context("Failed to fetch the latest MLVScan.DevCLI release")?;

        if response.status() == StatusCode::NOT_FOUND {
            return Err(anyhow::anyhow!(
                "The MLVScan.DevCLI GitHub repository did not return a latest release"
            ));
        }

        response
            .error_for_status_ref()
            .context("GitHub returned an error while fetching the latest MLVScan.DevCLI release")?;

        response
            .json::<GithubRelease>()
            .await
            .context("Failed to parse the latest MLVScan.DevCLI release")
    }

    async fn download_asset(&self, url: &str) -> Result<Vec<u8>> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .with_context(|| format!("Failed to download scanner asset from {}", url))?;

        response
            .error_for_status_ref()
            .context("GitHub returned an error while downloading a scanner asset")?;

        Ok(response
            .bytes()
            .await
            .context("Failed to read scanner asset bytes")?
            .to_vec())
    }

    async fn read_cli_info(&self, executable_path: &Path) -> Result<CliInfo> {
        let mut command = Command::new(executable_path);
        command.args(["info", "--format", "json"]);
        Self::apply_windows_flags(&mut command);

        let output = command
            .output()
            .await
            .context("Failed to execute the MLVScan scanner")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!(
                "Scanner info command failed: {}",
                stderr.trim()
            ));
        }

        let stdout =
            String::from_utf8(output.stdout).context("Scanner info output was not UTF-8")?;
        serde_json::from_str::<CliInfo>(&stdout).context("Failed to parse scanner info JSON output")
    }

    async fn scan_assembly_file(
        &self,
        executable_path: &Path,
        assembly_path: &Path,
        display_path: &str,
    ) -> Result<SecurityScanFileReport> {
        let mut command = Command::new(executable_path);
        command.arg(assembly_path);
        command.args(["--format", "schema"]);
        Self::apply_windows_flags(&mut command);

        let output = command
            .output()
            .await
            .with_context(|| format!("Failed to scan {}", assembly_path.display()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!(
                "Scanner failed for {}: {}",
                assembly_path.display(),
                stderr.trim()
            ));
        }

        let stdout = String::from_utf8(output.stdout).context("Scanner output was not UTF-8")?;
        let result = serde_json::from_str::<serde_json::Value>(&stdout)
            .context("Failed to parse MLVScan schema output")?;

        let file_name = assembly_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown.dll")
            .to_string();

        Ok(SecurityScanFileReport {
            file_name,
            display_path: display_path.to_string(),
            sha256_hash: Self::input_hash(&result),
            highest_severity: Self::highest_severity(&result),
            total_findings: Self::total_findings(&result),
            threat_family_count: Self::threat_family_count(&result),
            result,
        })
    }

    async fn scan_archive(
        &self,
        executable_path: &Path,
        archive_path: &Path,
        kind: ArchiveKind,
    ) -> Result<Vec<SecurityScanFileReport>> {
        let temp_root = std::env::temp_dir().join(format!("mlvscan-scan-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_root)
            .await
            .context("Failed to create archive scan temp directory")?;

        let extract_result = match kind {
            ArchiveKind::Zip => {
                self.extract_zip_to_directory(archive_path, &temp_root)
                    .await
            }
            ArchiveKind::Rar => {
                self.extract_rar_to_directory(archive_path, &temp_root)
                    .await
            }
        };

        if let Err(error) = extract_result {
            let _ = fs::remove_dir_all(&temp_root).await;
            return Err(error);
        }

        let dlls = self.collect_dll_files(&temp_root).await?;
        let mut reports = Vec::new();
        for dll in dlls {
            let relative = dll
                .strip_prefix(&temp_root)
                .unwrap_or(&dll)
                .to_string_lossy()
                .replace('\\', "/");
            reports.push(
                self.scan_assembly_file(executable_path, &dll, &relative)
                    .await?,
            );
        }

        let _ = fs::remove_dir_all(&temp_root).await;
        Ok(reports)
    }

    async fn extract_zip_to_directory(&self, archive_path: &Path, target_dir: &Path) -> Result<()> {
        let file = File::open(archive_path).context("Failed to open ZIP archive")?;
        let mut archive = ZipArchive::new(file).context("Failed to read ZIP archive")?;

        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .context("Failed to read ZIP entry")?;
            let relative_path = entry.name().to_string();
            let enclosed_path = entry.enclosed_name().ok_or_else(|| {
                anyhow::anyhow!("ZIP entry contains an unsafe path: {}", relative_path)
            })?;
            let output_path = target_dir.join(enclosed_path);

            if relative_path.ends_with('/') {
                std::fs::create_dir_all(&output_path).with_context(|| {
                    format!("Failed to create directory {}", output_path.display())
                })?;
                continue;
            }

            if let Some(parent) = output_path.parent() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("Failed to create directory {}", parent.display()))?;
            }

            let mut buffer = Vec::new();
            entry
                .read_to_end(&mut buffer)
                .context("Failed to read ZIP entry contents")?;
            std::fs::write(&output_path, buffer).with_context(|| {
                format!("Failed to write extracted file {}", output_path.display())
            })?;
        }

        Ok(())
    }

    async fn extract_rar_to_directory(&self, archive_path: &Path, target_dir: &Path) -> Result<()> {
        let mut archive = Archive::new(archive_path.to_str().unwrap())
            .open_for_processing()
            .context("Failed to open RAR archive")?;
        let target_dir_str = target_dir
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid archive extraction path"))?;

        while let Some(header) = archive.read_header().context("Failed to read RAR header")? {
            if header.entry().is_directory() {
                archive = header
                    .skip()
                    .context("Failed to skip RAR directory entry")?;
            } else {
                archive = header
                    .extract_with_base(target_dir_str)
                    .context("Failed to extract RAR file")?;
            }
        }

        Ok(())
    }

    async fn collect_dll_files(&self, root: &Path) -> Result<Vec<PathBuf>> {
        let mut collected = Vec::new();
        let mut stack = vec![root.to_path_buf()];

        while let Some(current) = stack.pop() {
            let mut entries = match fs::read_dir(&current).await {
                Ok(entries) => entries,
                Err(_) => continue,
            };

            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                let metadata = entry.metadata().await?;
                if metadata.is_dir() {
                    stack.push(path);
                    continue;
                }

                let file_name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if file_name.ends_with(".dll") {
                    collected.push(path);
                }
            }
        }

        collected.sort();
        Ok(collected)
    }

    async fn find_scanner_executable(&self, root: &Path) -> Result<Option<PathBuf>> {
        let mut stack = vec![root.to_path_buf()];
        while let Some(current) = stack.pop() {
            let mut entries = match fs::read_dir(&current).await {
                Ok(entries) => entries,
                Err(_) => continue,
            };

            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                let metadata = entry.metadata().await?;
                if metadata.is_dir() {
                    stack.push(path);
                    continue;
                }

                let file_name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default();
                if file_name.eq_ignore_ascii_case("mlvscan.exe") {
                    return Ok(Some(path));
                }
            }
        }

        Ok(None)
    }

    fn build_report(
        files: Vec<SecurityScanFileReport>,
        cli_info: CliInfo,
        settings: &Settings,
    ) -> SecurityScanReport {
        let highest_severity = files
            .iter()
            .filter_map(|file| file.highest_severity.clone())
            .max_by_key(Self::severity_rank);
        let total_findings = files.iter().map(|file| file.total_findings).sum::<usize>();
        let threat_family_count = files
            .iter()
            .map(|file| file.threat_family_count)
            .sum::<usize>();
        let disposition = Self::aggregate_disposition(&files);
        let exact_hash_match = files
            .iter()
            .any(|file| Self::has_exact_hash_match(&file.result));
        let known_threat = disposition.as_ref().is_some_and(|value| {
            value.classification == SecurityScanDispositionClassification::KnownThreat
        });
        let suspicious = disposition.as_ref().is_some_and(|value| {
            value.classification == SecurityScanDispositionClassification::Suspicious
        });
        let verified = disposition
            .as_ref()
            .map_or(total_findings == 0 && threat_family_count == 0, |value| {
                value.classification == SecurityScanDispositionClassification::Clean
            });

        let mut summary = SecurityScanSummary {
            state: if verified {
                SecurityScanState::Verified
            } else {
                SecurityScanState::Review
            },
            verified,
            disposition: disposition.clone(),
            highest_severity: highest_severity.clone(),
            total_findings,
            threat_family_count,
            scanned_at: Some(Utc::now()),
            scanner_version: Some(cli_info.platform_version.clone()),
            schema_version: Some(cli_info.schema_version.clone()),
            status_message: None,
        };

        let mut policy = SecurityScanPolicy {
            enabled: true,
            requires_confirmation: false,
            blocked: false,
            prompt_on_high_findings: settings.prompt_on_high_scans.unwrap_or(true),
            block_critical_findings: settings.block_critical_scans.unwrap_or(true),
            status_message: None,
        };

        if verified {
            let message = Self::clean_status_message(disposition.as_ref());
            summary.status_message = Some(message.clone());
            policy.status_message = Some(message);
        } else if known_threat && policy.block_critical_findings {
            let message = Self::known_threat_status_message(true);
            policy.blocked = true;
            summary.status_message = Some(message.clone());
            policy.status_message = Some(message);
        } else if known_threat {
            let message = Self::known_threat_status_message(false);
            policy.requires_confirmation = true;
            summary.status_message = Some(message.clone());
            policy.status_message = Some(message);
        } else if suspicious && policy.prompt_on_high_findings {
            let message = Self::suspicious_status_message(true);
            policy.requires_confirmation = true;
            summary.status_message = Some(message.clone());
            policy.status_message = Some(message);
        } else if suspicious {
            let message = Self::suspicious_status_message(false);
            summary.status_message = Some(message.clone());
            policy.status_message = Some(message);
        } else if exact_hash_match && policy.block_critical_findings {
            let message =
                "MLVScan blocked this download because it matched a known malicious sample."
                    .to_string();
            policy.blocked = true;
            summary.status_message = Some(message.clone());
            policy.status_message = Some(message);
        } else if highest_severity == Some(SecurityFindingSeverity::Critical)
            && policy.block_critical_findings
        {
            let message =
                "MLVScan blocked this download because critical security indicators were found."
                    .to_string();
            policy.blocked = true;
            summary.status_message = Some(message.clone());
            policy.status_message = Some(message);
        } else if highest_severity == Some(SecurityFindingSeverity::High)
            && policy.prompt_on_high_findings
        {
            let message =
                "MLVScan found high-risk indicators. Review the report before continuing."
                    .to_string();
            policy.requires_confirmation = true;
            summary.status_message = Some(message.clone());
            policy.status_message = Some(message);
        } else {
            let message = match highest_severity {
                Some(SecurityFindingSeverity::Medium) => {
                    "MLVScan found medium-risk indicators. Review is recommended.".to_string()
                }
                Some(SecurityFindingSeverity::Low) => {
                    "MLVScan found low-risk indicators. Review is optional.".to_string()
                }
                Some(SecurityFindingSeverity::High) => {
                    "MLVScan found high-risk indicators, but your settings allow installation without confirmation.".to_string()
                }
                Some(SecurityFindingSeverity::Critical) => {
                    "MLVScan found critical indicators, but critical blocking is disabled in settings.".to_string()
                }
                None => "MLVScan completed the scan.".to_string(),
            };
            summary.status_message = Some(message.clone());
            policy.status_message = Some(message);
        }

        SecurityScanReport {
            summary,
            policy,
            files,
        }
    }

    fn disabled_report() -> SecurityScanReport {
        SecurityScanReport {
            summary: SecurityScanSummary {
                state: SecurityScanState::Disabled,
                verified: false,
                disposition: None,
                highest_severity: None,
                total_findings: 0,
                threat_family_count: 0,
                scanned_at: None,
                scanner_version: None,
                schema_version: None,
                status_message: Some("Security scanning is disabled in settings.".to_string()),
            },
            policy: SecurityScanPolicy {
                enabled: false,
                requires_confirmation: false,
                blocked: false,
                prompt_on_high_findings: false,
                block_critical_findings: false,
                status_message: Some("Security scanning is disabled in settings.".to_string()),
            },
            files: Vec::new(),
        }
    }

    fn unavailable_report(error: String, settings: &Settings) -> SecurityScanReport {
        SecurityScanReport {
            summary: SecurityScanSummary {
                state: SecurityScanState::Unavailable,
                verified: false,
                disposition: None,
                highest_severity: None,
                total_findings: 0,
                threat_family_count: 0,
                scanned_at: Some(Utc::now()),
                scanner_version: None,
                schema_version: None,
                status_message: Some(error.clone()),
            },
            policy: SecurityScanPolicy {
                enabled: settings.enable_security_scanner.unwrap_or(true),
                requires_confirmation: false,
                blocked: false,
                prompt_on_high_findings: settings.prompt_on_high_scans.unwrap_or(true),
                block_critical_findings: settings.block_critical_scans.unwrap_or(true),
                status_message: Some(error),
            },
            files: Vec::new(),
        }
    }

    fn skipped_report(
        scanner_version: String,
        schema_version: String,
        message: &str,
    ) -> SecurityScanReport {
        SecurityScanReport {
            summary: SecurityScanSummary {
                state: SecurityScanState::Skipped,
                verified: false,
                disposition: None,
                highest_severity: None,
                total_findings: 0,
                threat_family_count: 0,
                scanned_at: Some(Utc::now()),
                scanner_version: Some(scanner_version),
                schema_version: Some(schema_version),
                status_message: Some(message.to_string()),
            },
            policy: SecurityScanPolicy {
                enabled: true,
                requires_confirmation: false,
                blocked: false,
                prompt_on_high_findings: false,
                block_critical_findings: false,
                status_message: Some(message.to_string()),
            },
            files: Vec::new(),
        }
    }

    fn aggregate_disposition(files: &[SecurityScanFileReport]) -> Option<SecurityScanDisposition> {
        files
            .iter()
            .filter_map(Self::file_disposition)
            .max_by_key(|value| {
                (
                    Self::disposition_rank(value.classification),
                    if value.blocking_recommended { 1 } else { 0 },
                )
            })
    }

    fn file_disposition(file: &SecurityScanFileReport) -> Option<SecurityScanDisposition> {
        Self::disposition(&file.result).or_else(|| Self::inferred_disposition(&file.result))
    }

    fn disposition(result: &serde_json::Value) -> Option<SecurityScanDisposition> {
        result
            .get("disposition")
            .cloned()
            .and_then(|value| serde_json::from_value::<SecurityScanDisposition>(value).ok())
    }

    fn inferred_disposition(result: &serde_json::Value) -> Option<SecurityScanDisposition> {
        let total_findings = Self::total_findings(result);
        let threat_family_count = Self::threat_family_count(result);
        let exact_hash_match = Self::has_exact_hash_match(result);
        let highest_severity = Self::highest_severity(result);
        let primary_threat_family_id = Self::primary_threat_family_id(result);

        let (classification, headline, summary, blocking_recommended) = if exact_hash_match {
            (
                SecurityScanDispositionClassification::KnownThreat,
                "Known threat detected".to_string(),
                "This file matched a known malicious sample.".to_string(),
                true,
            )
        } else if threat_family_count > 0 {
            (
                SecurityScanDispositionClassification::KnownThreat,
                "Known threat family match".to_string(),
                "This file matched known threat intelligence indicators.".to_string(),
                true,
            )
        } else if total_findings == 0 {
            (
                SecurityScanDispositionClassification::Clean,
                "No malicious indicators detected".to_string(),
                "MLVScan classified this file as safe.".to_string(),
                false,
            )
        } else {
            let severity = highest_severity
                .as_ref()
                .map(Self::severity_label)
                .unwrap_or("suspicious");
            (
                SecurityScanDispositionClassification::Suspicious,
                "Potentially malicious indicators detected".to_string(),
                format!(
                    "MLVScan identified {} risk indicators in this file.",
                    severity
                ),
                false,
            )
        };

        Some(SecurityScanDisposition {
            classification,
            headline,
            summary,
            blocking_recommended,
            primary_threat_family_id,
            related_finding_ids: Self::related_finding_ids(result),
        })
    }

    fn total_findings(result: &serde_json::Value) -> usize {
        result
            .get("summary")
            .and_then(|summary| summary.get("totalFindings"))
            .and_then(|value| value.as_u64())
            .unwrap_or(0) as usize
    }

    fn threat_family_count(result: &serde_json::Value) -> usize {
        result
            .get("threatFamilies")
            .and_then(|value| value.as_array())
            .map(|families| families.len())
            .unwrap_or(0)
    }

    fn input_hash(result: &serde_json::Value) -> Option<String> {
        result
            .get("input")
            .and_then(|input| input.get("sha256Hash"))
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
    }

    fn highest_severity(result: &serde_json::Value) -> Option<SecurityFindingSeverity> {
        let count_by_severity = result
            .get("summary")
            .and_then(|summary| summary.get("countBySeverity"))
            .and_then(|value| value.as_object())?;

        [
            ("Critical", SecurityFindingSeverity::Critical),
            ("High", SecurityFindingSeverity::High),
            ("Medium", SecurityFindingSeverity::Medium),
            ("Low", SecurityFindingSeverity::Low),
        ]
        .into_iter()
        .find_map(|(label, severity)| {
            let count = count_by_severity
                .get(label)
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            if count > 0 {
                Some(severity)
            } else {
                None
            }
        })
    }

    fn has_exact_hash_match(result: &serde_json::Value) -> bool {
        result
            .get("threatFamilies")
            .and_then(|value| value.as_array())
            .map(|families| {
                families.iter().any(|family| {
                    family
                        .get("exactHashMatch")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    }

    fn primary_threat_family_id(result: &serde_json::Value) -> Option<String> {
        result
            .get("threatFamilies")
            .and_then(|value| value.as_array())
            .and_then(|families| {
                families.iter().max_by(|left, right| {
                    let left_exact = left
                        .get("exactHashMatch")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false);
                    let right_exact = right
                        .get("exactHashMatch")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false);
                    let left_confidence = left
                        .get("confidence")
                        .and_then(|value| value.as_f64())
                        .unwrap_or_default();
                    let right_confidence = right
                        .get("confidence")
                        .and_then(|value| value.as_f64())
                        .unwrap_or_default();

                    left_exact
                        .cmp(&right_exact)
                        .then_with(|| left_confidence.total_cmp(&right_confidence))
                })
            })
            .and_then(|family| family.get("familyId"))
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
    }

    fn related_finding_ids(result: &serde_json::Value) -> Vec<String> {
        result
            .get("findings")
            .and_then(|value| value.as_array())
            .map(|findings| {
                findings
                    .iter()
                    .filter_map(|finding| {
                        finding
                            .get("id")
                            .and_then(|value| value.as_str())
                            .map(|value| value.to_string())
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn severity_rank(severity: &SecurityFindingSeverity) -> usize {
        match severity {
            SecurityFindingSeverity::Low => 1,
            SecurityFindingSeverity::Medium => 2,
            SecurityFindingSeverity::High => 3,
            SecurityFindingSeverity::Critical => 4,
        }
    }

    fn disposition_rank(classification: SecurityScanDispositionClassification) -> usize {
        match classification {
            SecurityScanDispositionClassification::Clean => 1,
            SecurityScanDispositionClassification::Suspicious => 2,
            SecurityScanDispositionClassification::KnownThreat => 3,
        }
    }

    fn severity_label(severity: &SecurityFindingSeverity) -> &'static str {
        match severity {
            SecurityFindingSeverity::Low => "low",
            SecurityFindingSeverity::Medium => "medium",
            SecurityFindingSeverity::High => "high",
            SecurityFindingSeverity::Critical => "critical",
        }
    }

    fn clean_status_message(disposition: Option<&SecurityScanDisposition>) -> String {
        disposition
            .and_then(|value| Self::non_empty_disposition_text(value))
            .unwrap_or_else(|| "MLVScan classified this download as safe.".to_string())
    }

    fn suspicious_status_message(requires_confirmation: bool) -> String {
        if requires_confirmation {
            "MLVScan classified this download as potentially malicious. Review the report before continuing.".to_string()
        } else {
            "MLVScan classified this download as potentially malicious, but your settings allow installation without confirmation.".to_string()
        }
    }

    fn known_threat_status_message(blocked: bool) -> String {
        if blocked {
            "MLVScan classified this download as a known threat. Current policy blocked installation.".to_string()
        } else {
            "MLVScan classified this download as a known threat. Critical blocking is disabled in settings, so review the report before continuing.".to_string()
        }
    }

    fn non_empty_disposition_text(disposition: &SecurityScanDisposition) -> Option<String> {
        let summary = disposition.summary.trim();
        if !summary.is_empty() {
            return Some(summary.to_string());
        }

        let headline = disposition.headline.trim();
        if !headline.is_empty() {
            return Some(headline.to_string());
        }

        None
    }

    fn hash_bytes(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hex::encode(hasher.finalize())
    }

    #[cfg(target_os = "windows")]
    fn apply_windows_flags(command: &mut Command) {
        command.creation_flags(0x08000000);
    }

    #[cfg(not(target_os = "windows"))]
    fn apply_windows_flags(_command: &mut Command) {}
}

impl Default for SecurityScannerService {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy)]
enum ArchiveKind {
    Zip,
    Rar,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Platform, Theme};
    use serde_json::json;
    use std::io::Write;
    use tempfile::tempdir;
    use zip::write::FileOptions;
    use zip::ZipWriter;

    fn test_cli_info() -> CliInfo {
        CliInfo {
            platform_version: "1.2.3".to_string(),
            schema_version: "2026-03".to_string(),
        }
    }

    fn test_settings() -> Settings {
        Settings {
            default_download_dir: "C:/mods".to_string(),
            depot_downloader_path: None,
            steam_username: None,
            max_concurrent_downloads: 1,
            platform: Platform::Windows,
            language: "en-US".to_string(),
            theme: Theme::Dark,
            melon_loader_version: None,
            auto_install_melon_loader: None,
            enable_security_scanner: Some(true),
            auto_install_security_scanner: Some(true),
            block_critical_scans: Some(true),
            prompt_on_high_scans: Some(true),
            show_security_scan_badges: Some(true),
            update_check_interval: None,
            auto_check_updates: None,
            log_level: None,
            nexus_mods_api_key: None,
            nexus_mods_rate_limits: None,
            nexus_mods_game_id: None,
            nexus_mods_app_slug: None,
            thunderstore_game_id: None,
            auto_update_mods: None,
            mod_update_check_interval: None,
            mod_icon_cache_limit_mb: None,
            database_backup_count: None,
            log_retention_days: None,
        }
    }

    fn file_report(result: serde_json::Value) -> SecurityScanFileReport {
        SecurityScanFileReport {
            file_name: "Example.dll".to_string(),
            display_path: "Example.dll".to_string(),
            sha256_hash: SecurityScannerService::input_hash(&result),
            highest_severity: SecurityScannerService::highest_severity(&result),
            total_findings: SecurityScannerService::total_findings(&result),
            threat_family_count: SecurityScannerService::threat_family_count(&result),
            result,
        }
    }

    #[test]
    fn build_report_uses_clean_disposition_for_verified_badges() {
        let report = SecurityScannerService::build_report(
            vec![file_report(json!({
                "schemaVersion": "1.0.0",
                "metadata": {
                    "platformVersion": "1.2.3",
                    "schemaVersion": "2026-03",
                    "timestamp": "2026-03-26T00:00:00Z"
                },
                "input": {
                    "fileName": "Example.dll",
                    "sizeBytes": 128,
                    "sha256Hash": "abc123"
                },
                "summary": {
                    "totalFindings": 0,
                    "countBySeverity": {}
                },
                "findings": [],
                "threatFamilies": [],
                "disposition": {
                    "classification": "Clean",
                    "headline": "Safe",
                    "summary": "No malicious indicators were identified.",
                    "blockingRecommended": false,
                    "relatedFindingIds": []
                }
            }))],
            test_cli_info(),
            &test_settings(),
        );

        assert_eq!(report.summary.state, SecurityScanState::Verified);
        assert!(report.summary.verified);
        assert_eq!(
            report
                .summary
                .disposition
                .as_ref()
                .map(|value| value.classification),
            Some(SecurityScanDispositionClassification::Clean)
        );
        assert_eq!(
            report.summary.status_message.as_deref(),
            Some("No malicious indicators were identified.")
        );
        assert!(!report.policy.blocked);
        assert!(!report.policy.requires_confirmation);
    }

    #[test]
    fn build_report_requires_confirmation_for_suspicious_disposition() {
        let report = SecurityScannerService::build_report(
            vec![file_report(json!({
                "schemaVersion": "1.0.0",
                "metadata": {
                    "platformVersion": "1.2.3",
                    "schemaVersion": "2026-03",
                    "timestamp": "2026-03-26T00:00:00Z"
                },
                "input": {
                    "fileName": "Example.dll",
                    "sizeBytes": 128,
                    "sha256Hash": "abc123"
                },
                "summary": {
                    "totalFindings": 1,
                    "countBySeverity": {
                        "High": 1
                    }
                },
                "findings": [
                    {
                        "id": "finding-1",
                        "description": "Downloads and runs external payloads",
                        "severity": "High",
                        "location": "Example::Run()"
                    }
                ],
                "threatFamilies": [],
                "disposition": {
                    "classification": "Suspicious",
                    "headline": "Potentially malicious",
                    "summary": "Heuristic checks identified suspicious behavior.",
                    "blockingRecommended": false,
                    "relatedFindingIds": ["finding-1"]
                }
            }))],
            test_cli_info(),
            &test_settings(),
        );

        assert_eq!(report.summary.state, SecurityScanState::Review);
        assert!(!report.summary.verified);
        assert_eq!(
            report
                .summary
                .disposition
                .as_ref()
                .map(|value| value.classification),
            Some(SecurityScanDispositionClassification::Suspicious)
        );
        assert!(!report.policy.blocked);
        assert!(report.policy.requires_confirmation);
        assert_eq!(
            report.summary.status_message.as_deref(),
            Some(
                "MLVScan classified this download as potentially malicious. Review the report before continuing."
            )
        );
    }

    #[test]
    fn build_report_aggregates_to_known_threat_and_blocks() {
        let report = SecurityScannerService::build_report(
            vec![
                file_report(json!({
                    "schemaVersion": "1.0.0",
                    "metadata": {
                        "platformVersion": "1.2.3",
                        "schemaVersion": "2026-03",
                        "timestamp": "2026-03-26T00:00:00Z"
                    },
                    "input": {
                        "fileName": "Safe.dll",
                        "sizeBytes": 128,
                        "sha256Hash": "safe"
                    },
                    "summary": {
                        "totalFindings": 0,
                        "countBySeverity": {}
                    },
                    "findings": [],
                    "threatFamilies": [],
                    "disposition": {
                        "classification": "Clean",
                        "headline": "Safe",
                        "summary": "No malicious indicators were identified.",
                        "blockingRecommended": false,
                        "relatedFindingIds": []
                    }
                })),
                file_report(json!({
                    "schemaVersion": "1.0.0",
                    "metadata": {
                        "platformVersion": "1.2.3",
                        "schemaVersion": "2026-03",
                        "timestamp": "2026-03-26T00:00:00Z"
                    },
                    "input": {
                        "fileName": "Threat.dll",
                        "sizeBytes": 128,
                        "sha256Hash": "threat"
                    },
                    "summary": {
                        "totalFindings": 1,
                        "countBySeverity": {
                            "Critical": 1
                        }
                    },
                    "findings": [
                        {
                            "id": "finding-9",
                            "description": "Matches known credential stealer",
                            "severity": "Critical",
                            "location": "Threat::Run()"
                        }
                    ],
                    "threatFamilies": [
                        {
                            "familyId": "stealer",
                            "variantId": "v1",
                            "displayName": "Credential Stealer",
                            "summary": "Known credential theft malware",
                            "matchKind": "heuristic",
                            "confidence": 0.97,
                            "exactHashMatch": false,
                            "matchedRules": ["RULE-1"],
                            "advisorySlugs": [],
                            "evidence": []
                        }
                    ],
                    "disposition": {
                        "classification": "KnownThreat",
                        "headline": "Known threat",
                        "summary": "Threat intelligence matched this file to a known malware family.",
                        "blockingRecommended": true,
                        "primaryThreatFamilyId": "stealer",
                        "relatedFindingIds": ["finding-9"]
                    }
                })),
            ],
            test_cli_info(),
            &test_settings(),
        );

        assert_eq!(
            report
                .summary
                .disposition
                .as_ref()
                .map(|value| value.classification),
            Some(SecurityScanDispositionClassification::KnownThreat)
        );
        assert!(!report.summary.verified);
        assert!(report.policy.blocked);
        assert!(!report.policy.requires_confirmation);
        assert_eq!(
            report.summary.status_message.as_deref(),
            Some("MLVScan classified this download as a known threat. Current policy blocked installation.")
        );
    }

    #[tokio::test]
    async fn extract_zip_to_directory_rejects_traversal_paths() -> Result<()> {
        let temp = tempdir()?;
        let archive_path = temp.path().join("scanner.zip");
        let target_dir = temp.path().join("extract");
        std::fs::create_dir_all(&target_dir)?;

        let archive_file = File::create(&archive_path)?;
        let mut archive = ZipWriter::new(archive_file);
        archive.start_file("../escape.txt", FileOptions::default())?;
        archive.write_all(b"unsafe")?;
        archive.finish()?;

        let service = SecurityScannerService::new();
        let err = service
            .extract_zip_to_directory(&archive_path, &target_dir)
            .await
            .expect_err("expected invalid ZIP entry path error");

        assert!(err.to_string().contains("unsafe path"));
        assert!(!temp.path().join("escape.txt").exists());
        assert!(!target_dir.join("escape.txt").exists());

        Ok(())
    }
}
