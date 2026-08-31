use crate::db;
use crate::types::{
    SecurityFindingSeverity, SecurityScanDisposition, SecurityScanDispositionClassification,
    SecurityScanFileReport, SecurityScanPolicy, SecurityScanReport, SecurityScanState,
    SecurityScanSummary, SecurityScannerStatus, Settings,
};
use crate::utils::http_identity;
use anyhow::{Context, Result};
use chrono::Utc;
use flate2::read::GzDecoder;
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
#[cfg(target_os = "linux")]
const DOTNET_INSTALL_SCRIPT_URL: &str = "https://dot.net/v1/dotnet-install.sh";
#[cfg(target_os = "linux")]
const MANAGED_DOTNET_SDK_CHANNEL: &str = "8.0";

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
            match self.install_with_system_dotnet_tool().await {
                Ok(executable) => executable,
                Err(dotnet_error) => {
                    if Self::binary_release_supported_on_host() {
                        log::warn!(
                            "Failed to install MLVScan via dotnet tool, falling back to release binary: {}",
                            dotnet_error
                        );
                        self.install_with_binary_release().await?
                    } else if cfg!(target_os = "linux") {
                        log::warn!(
                            "Failed to install MLVScan via system dotnet, falling back to SIMM managed .NET SDK: {}",
                            dotnet_error
                        );
                        self.install_with_managed_dotnet_sdk()
                            .await
                            .with_context(|| {
                                format!("System dotnet tool install also failed: {}", dotnet_error)
                            })?
                    } else {
                        return Err(anyhow::anyhow!(
                            "Failed to install MLVScan.DevCLI with dotnet tool: {}. Install .NET SDK 8 and retry, or install the scanner manually with `dotnet tool install -g MLVScan.DevCLI`.",
                            dotnet_error
                        ));
                    }
                }
            }
        } else if cfg!(target_os = "linux") {
            self.install_with_managed_dotnet_sdk().await?
        } else if Self::binary_release_supported_on_host() {
            self.install_with_binary_release().await?
        } else {
            return Err(anyhow::anyhow!(
                "MLVScan Security Scanner requires .NET SDK 8 on this platform. Install .NET SDK 8 and retry, or install the scanner manually with `dotnet tool install -g MLVScan.DevCLI`."
            ));
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

        // A configured scanner is a security gate, not a best-effort annotation.  Preserve
        // scanner execution, parsing, collection, and archive-extraction failures as an
        // explicit unavailable result so callers block materialization rather than silently
        // proceeding unscanned. Users must restore successful scanning or disable the scanner
        // policy in settings.
        let files = match archive_kind_for_path_or_signature(file_path) {
            InputArchiveKind::Dll => self
                .scan_assembly_file(
                    &executable.path,
                    file_path,
                    file_path.to_string_lossy().as_ref(),
                )
                .await
                .map(|report| vec![report]),
            InputArchiveKind::Zip => {
                self.scan_archive(&executable.path, file_path, ArchiveKind::Zip)
                    .await
            }
            InputArchiveKind::Rar => {
                self.scan_archive(&executable.path, file_path, ArchiveKind::Rar)
                    .await
            }
            InputArchiveKind::SevenZ => {
                self.scan_archive(&executable.path, file_path, ArchiveKind::SevenZ)
                    .await
            }
            InputArchiveKind::TarGz => {
                self.scan_archive(&executable.path, file_path, ArchiveKind::TarGz)
                    .await
            }
            InputArchiveKind::Unsupported => Ok(Vec::new()),
        };

        let files = match files {
            Ok(files) => files,
            Err(error) => {
                return Ok(Self::unavailable_report(
                    format!("MLVScan could not complete the security scan: {error}"),
                    settings,
                ));
            }
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
        let executable = self.binary_install_executable_path()?;
        if executable.exists() {
            return Ok(Some(ResolvedScannerExecutable {
                path: executable,
                install_method: "managedBinary".to_string(),
            }));
        }

        let dotnet_tool_executable = self.dotnet_tool_executable_path()?;
        if dotnet_tool_executable.exists() {
            let install_method =
                if cfg!(target_os = "linux") && self.managed_dotnet_executable_path()?.exists() {
                    "managedDotnetSdkTool"
                } else {
                    "managedDotnetTool"
                };
            return Ok(Some(ResolvedScannerExecutable {
                path: dotnet_tool_executable,
                install_method: install_method.to_string(),
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

    fn managed_dotnet_sdk_dir(&self) -> Result<PathBuf> {
        Ok(self.tool_root_dir()?.join("dotnet-sdk-8"))
    }

    fn managed_dotnet_executable_path(&self) -> Result<PathBuf> {
        Ok(self.managed_dotnet_sdk_dir()?.join("dotnet"))
    }

    fn scanner_executable_name() -> &'static str {
        if cfg!(target_os = "windows") {
            "mlvscan.exe"
        } else {
            "mlvscan"
        }
    }

    fn binary_install_executable_path(&self) -> Result<PathBuf> {
        Ok(self
            .binary_install_dir()?
            .join(Self::scanner_executable_name()))
    }

    fn dotnet_tool_executable_path(&self) -> Result<PathBuf> {
        Ok(self
            .dotnet_tool_install_dir()?
            .join(Self::scanner_executable_name()))
    }

    fn binary_release_supported_on_host() -> bool {
        cfg!(target_os = "windows")
    }

    fn binary_release_asset_names() -> Option<(&'static str, &'static str)> {
        if cfg!(target_os = "windows") {
            Some((WINDOWS_ZIP_ASSET_NAME, WINDOWS_SHA256_ASSET_NAME))
        } else {
            None
        }
    }

    async fn has_dotnet_sdk_8(&self) -> Result<bool> {
        Ok(self
            .dotnet_sdk_8_version(Path::new("dotnet"), None)
            .await?
            .is_some())
    }

    async fn dotnet_sdk_8_version(
        &self,
        dotnet_program: &Path,
        dotnet_root: Option<&Path>,
    ) -> Result<Option<String>> {
        let mut command = Command::new(dotnet_program);
        command.arg("--list-sdks");
        if let Some(dotnet_root) = dotnet_root {
            Self::apply_dotnet_root_env(&mut command, dotnet_root)?;
        }
        Self::apply_windows_flags(&mut command);

        let output = match command.output().await {
            Ok(output) => output,
            Err(_) => return Ok(None),
        };

        if !output.status.success() {
            return Ok(None);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(Self::first_dotnet_sdk_8_version(&stdout))
    }

    fn first_dotnet_sdk_8_version(output: &str) -> Option<String> {
        output.lines().find_map(|line| {
            let version = line.split_whitespace().next()?.trim();
            let major = version.split('.').next()?.parse::<u32>().ok()?;
            (major >= 8).then(|| version.to_string())
        })
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

    async fn install_with_system_dotnet_tool(&self) -> Result<ResolvedScannerExecutable> {
        self.install_with_dotnet_tool_command(
            Path::new("dotnet"),
            None,
            "managedDotnetTool",
            "dotnet",
        )
        .await
    }

    async fn install_with_dotnet_tool_command(
        &self,
        dotnet_program: &Path,
        dotnet_root: Option<&Path>,
        install_method: &str,
        display_name: &str,
    ) -> Result<ResolvedScannerExecutable> {
        let install_dir = self.dotnet_tool_install_dir()?;
        fs::create_dir_all(&install_dir)
            .await
            .context("Failed to create dotnet tool installation directory")?;

        let executable_path = self.dotnet_tool_executable_path()?;
        let mut command = Command::new(dotnet_program);
        command.arg("tool");
        if executable_path.exists() {
            command.arg("update");
        } else {
            command.arg("install");
        }
        command.arg(NUGET_PACKAGE_NAME);
        command.arg("--tool-path");
        command.arg(&install_dir);
        if let Some(dotnet_root) = dotnet_root {
            Self::apply_dotnet_root_env(&mut command, dotnet_root)?;
        }
        Self::apply_windows_flags(&mut command);

        let output = command.output().await.with_context(|| {
            format!("Failed to execute {display_name} tool installation for MLVScan")
        })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(anyhow::anyhow!(
                "{} tool setup failed: {}{}{}",
                display_name,
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
                "dotnet tool reported success but {} was not found",
                Self::scanner_executable_name()
            ));
        }

        Ok(ResolvedScannerExecutable {
            path: executable_path,
            install_method: install_method.to_string(),
        })
    }

    #[cfg(target_os = "linux")]
    async fn install_with_managed_dotnet_sdk(&self) -> Result<ResolvedScannerExecutable> {
        let dotnet_program = self.ensure_managed_dotnet_sdk().await?;
        let dotnet_root = self.managed_dotnet_sdk_dir()?;
        self.install_with_dotnet_tool_command(
            &dotnet_program,
            Some(&dotnet_root),
            "managedDotnetSdkTool",
            "managed dotnet",
        )
        .await
    }

    #[cfg(not(target_os = "linux"))]
    async fn install_with_managed_dotnet_sdk(&self) -> Result<ResolvedScannerExecutable> {
        Err(anyhow::anyhow!(
            "Managed .NET SDK bootstrap is only supported on Linux"
        ))
    }

    #[cfg(target_os = "linux")]
    async fn ensure_managed_dotnet_sdk(&self) -> Result<PathBuf> {
        let install_dir = self.managed_dotnet_sdk_dir()?;
        let dotnet_program = self.managed_dotnet_executable_path()?;
        if dotnet_program.exists()
            && self
                .dotnet_sdk_8_version(&dotnet_program, Some(&install_dir))
                .await?
                .is_some()
        {
            return Ok(dotnet_program);
        }

        fs::create_dir_all(&install_dir)
            .await
            .context("Failed to create managed .NET SDK directory")?;

        let temp_root = self
            .tool_root_dir()?
            .join("tmp")
            .join(format!("dotnet-sdk-install-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_root)
            .await
            .context("Failed to create managed .NET SDK staging directory")?;
        let script_path = temp_root.join("dotnet-install.sh");
        let script = self
            .download_asset(DOTNET_INSTALL_SCRIPT_URL)
            .await
            .context("Failed to download the .NET install script")?;
        fs::write(&script_path, script)
            .await
            .context("Failed to stage the .NET install script")?;

        let mut command = Command::new("bash");
        command
            .arg(&script_path)
            .arg("--channel")
            .arg(MANAGED_DOTNET_SDK_CHANNEL)
            .arg("--install-dir")
            .arg(&install_dir)
            .arg("--no-path");

        let output = command
            .output()
            .await
            .context("Failed to execute the .NET install script")?;
        let _ = fs::remove_dir_all(&temp_root).await;

        if !output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!(
                "Managed .NET SDK install failed: {}{}{}",
                stdout.trim(),
                if stdout.trim().is_empty() || stderr.trim().is_empty() {
                    ""
                } else {
                    "\n"
                },
                stderr.trim()
            ));
        }

        let version = self
            .dotnet_sdk_8_version(&dotnet_program, Some(&install_dir))
            .await?
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Managed .NET SDK install completed but no SDK 8 or newer was detected"
                )
            })?;
        log::info!(
            "Installed managed .NET SDK {} for MLVScan at {}",
            version,
            install_dir.display()
        );

        Ok(dotnet_program)
    }

    async fn install_with_binary_release(&self) -> Result<ResolvedScannerExecutable> {
        let release = self.fetch_latest_release().await?;
        let (zip_asset_name, checksum_asset_name) = Self::binary_release_asset_names().ok_or_else(|| {
            anyhow::anyhow!(
                "No standalone MLVScan.DevCLI binary release is configured for this platform. Install .NET SDK 8 and use the MLVScan.DevCLI dotnet tool."
            )
        })?;
        let zip_asset = release
            .assets
            .iter()
            .find(|asset| asset.name.eq_ignore_ascii_case(zip_asset_name))
            .cloned()
            .ok_or_else(|| {
                anyhow::anyhow!("Latest MLVScan release does not contain {}", zip_asset_name)
            })?;
        let checksum_asset = release
            .assets
            .iter()
            .find(|asset| asset.name.eq_ignore_ascii_case(checksum_asset_name))
            .cloned()
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Latest MLVScan release does not contain {}",
                    checksum_asset_name
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
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Scanner archive did not contain {}",
                    Self::scanner_executable_name()
                )
            })?;
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

        let installed_executable = self.binary_install_executable_path()?;
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
        self.apply_managed_dotnet_env_if_available(&mut command)?;
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
        self.apply_managed_dotnet_env_if_available(&mut command)?;
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
        self.scan_archive_in_temp_parent(executable_path, archive_path, kind, &std::env::temp_dir())
            .await
    }

    async fn scan_archive_in_temp_parent(
        &self,
        executable_path: &Path,
        archive_path: &Path,
        kind: ArchiveKind,
        temp_parent: &Path,
    ) -> Result<Vec<SecurityScanFileReport>> {
        // TempDir removes the extraction tree when this scope exits, including every error
        // path below.  Keeping the guard alive throughout scanning closes the former leaks on
        // collection, execution, and output-parsing failures.
        let temp_root = tempfile::Builder::new()
            .prefix("mlvscan-scan-")
            .tempdir_in(temp_parent)
            .context("Failed to create archive scan temp directory")?;
        let temp_root_path = temp_root.path();

        match kind {
            ArchiveKind::Zip => {
                self.extract_zip_to_directory(archive_path, temp_root_path)
                    .await
            }
            ArchiveKind::Rar => {
                self.extract_rar_to_directory(archive_path, temp_root_path)
                    .await
            }
            ArchiveKind::SevenZ => {
                self.extract_7z_to_directory(archive_path, temp_root_path)
                    .await
            }
            ArchiveKind::TarGz => {
                self.extract_tar_gz_to_directory(archive_path, temp_root_path)
                    .await
            }
        }?;

        let dlls = self.collect_dll_files(temp_root_path).await?;
        let mut reports = Vec::new();
        for dll in dlls {
            let relative = dll
                .strip_prefix(temp_root_path)
                .unwrap_or(&dll)
                .to_string_lossy()
                .replace('\\', "/");
            reports.push(
                self.scan_assembly_file(executable_path, &dll, &relative)
                    .await?,
            );
        }

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
            let entry = header.entry();
            let is_directory = entry.is_directory();
            validate_rar_entry_path(&entry.filename)?;

            if is_directory {
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

    async fn extract_7z_to_directory(&self, archive_path: &Path, target_dir: &Path) -> Result<()> {
        let archive_path = archive_path.to_path_buf();
        let target_dir = target_dir.to_path_buf();
        tokio::task::spawn_blocking(move || {
            sevenz_rust::decompress_file_with_extract_fn(
                &archive_path,
                &target_dir,
                |entry, reader, _dest| {
                    if entry.name().is_empty() && entry.is_directory() {
                        return Ok(true);
                    }
                    let relative_path = safe_archive_relative_path(entry.name())
                        .map_err(sevenz_rust::Error::other)?;
                    let output_path = target_dir.join(relative_path);

                    if entry.is_directory() {
                        std::fs::create_dir_all(&output_path).map_err(sevenz_rust::Error::io)?;
                    } else {
                        if let Some(parent) = output_path.parent() {
                            std::fs::create_dir_all(parent).map_err(sevenz_rust::Error::io)?;
                        }
                        let mut output =
                            File::create(&output_path).map_err(sevenz_rust::Error::io)?;
                        std::io::copy(reader, &mut output).map_err(sevenz_rust::Error::io)?;
                    }

                    Ok(true)
                },
            )
            .context("Failed to extract 7z archive")
        })
        .await?
    }

    async fn extract_tar_gz_to_directory(
        &self,
        archive_path: &Path,
        target_dir: &Path,
    ) -> Result<()> {
        let archive_path = archive_path.to_path_buf();
        let target_dir = target_dir.to_path_buf();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let file = File::open(&archive_path).context("Failed to open tar.gz archive")?;
            let decoder = GzDecoder::new(file);
            let mut archive = tar::Archive::new(decoder);

            for entry in archive.entries().context("Failed to read tar.gz archive")? {
                let mut entry = entry.context("Failed to read tar.gz entry")?;
                let entry_path = entry.path().context("Failed to read tar.gz entry path")?;
                let entry_name = entry_path.to_string_lossy().replace('\\', "/");
                let relative_path = safe_archive_relative_path(&entry_name)
                    .map_err(|error| anyhow::anyhow!(error))?;
                let output_path = target_dir.join(relative_path);

                let entry_type = entry.header().entry_type();
                if entry_type.is_dir() {
                    std::fs::create_dir_all(&output_path).with_context(|| {
                        format!("Failed to create directory {}", output_path.display())
                    })?;
                } else if entry_type.is_file() {
                    if let Some(parent) = output_path.parent() {
                        std::fs::create_dir_all(parent).with_context(|| {
                            format!("Failed to create directory {}", parent.display())
                        })?;
                    }
                    entry.unpack(&output_path).with_context(|| {
                        format!("Failed to extract tar.gz file {}", output_path.display())
                    })?;
                }
            }

            Ok(())
        })
        .await?
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
                if file_name.eq_ignore_ascii_case(Self::scanner_executable_name()) {
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
        let message = format!(
            "Security scanning is enabled but unavailable: {error}. Installation remains blocked until scanning succeeds or security scanning is disabled in settings."
        );

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
                status_message: Some(message.clone()),
            },
            policy: SecurityScanPolicy {
                enabled: settings.enable_security_scanner.unwrap_or(true),
                requires_confirmation: false,
                blocked: true,
                prompt_on_high_findings: settings.prompt_on_high_scans.unwrap_or(true),
                block_critical_findings: settings.block_critical_scans.unwrap_or(true),
                status_message: Some(message),
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

    fn apply_managed_dotnet_env_if_available(&self, command: &mut Command) -> Result<()> {
        if cfg!(target_os = "linux") {
            let dotnet_root = self.managed_dotnet_sdk_dir()?;
            if self.managed_dotnet_executable_path()?.exists() {
                Self::apply_dotnet_root_env(command, &dotnet_root)?;
            }
        }
        Ok(())
    }

    fn apply_dotnet_root_env(command: &mut Command, dotnet_root: &Path) -> Result<()> {
        command.env("DOTNET_ROOT", dotnet_root);

        let mut paths = vec![dotnet_root.to_path_buf()];
        if let Some(existing_path) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing_path));
        }
        let joined_path = std::env::join_paths(paths).context("Failed to build .NET PATH")?;
        command.env("PATH", joined_path);
        Ok(())
    }
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
    SevenZ,
    TarGz,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InputArchiveKind {
    Dll,
    Zip,
    Rar,
    SevenZ,
    TarGz,
    Unsupported,
}

fn archive_kind_for_path(path: &Path) -> InputArchiveKind {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if file_name.ends_with(".tar.gz") || file_name.ends_with(".tgz") {
        return InputArchiveKind::TarGz;
    }
    if file_name.ends_with(".dll.disabled") {
        return InputArchiveKind::Dll;
    }

    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "dll" => InputArchiveKind::Dll,
        "zip" => InputArchiveKind::Zip,
        "rar" => InputArchiveKind::Rar,
        "7z" => InputArchiveKind::SevenZ,
        _ => InputArchiveKind::Unsupported,
    }
}

fn archive_kind_for_path_or_signature(path: &Path) -> InputArchiveKind {
    let extension_kind = archive_kind_for_path(path);
    if extension_kind != InputArchiveKind::Unsupported {
        return extension_kind;
    }

    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return InputArchiveKind::Unsupported,
    };
    let mut header = [0u8; 8];
    let bytes_read = match file.read(&mut header) {
        Ok(bytes_read) => bytes_read,
        Err(_) => return InputArchiveKind::Unsupported,
    };
    let header = &header[..bytes_read];

    if header.starts_with(&[0x50, 0x4b, 0x03, 0x04])
        || header.starts_with(&[0x50, 0x4b, 0x05, 0x06])
        || header.starts_with(&[0x50, 0x4b, 0x07, 0x08])
    {
        return InputArchiveKind::Zip;
    }

    if header.starts_with(b"Rar!\x1A\x07\x00") || header.starts_with(b"Rar!\x1A\x07\x01\x00") {
        return InputArchiveKind::Rar;
    }

    if header.starts_with(&[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) {
        return InputArchiveKind::SevenZ;
    }

    if header.starts_with(&[0x1f, 0x8b]) {
        return InputArchiveKind::TarGz;
    }

    InputArchiveKind::Unsupported
}

fn safe_archive_relative_path(entry_name: &str) -> std::result::Result<PathBuf, String> {
    let normalized_entry_name = entry_name.replace('\\', "/");
    if normalized_entry_name.contains(':') {
        return Err(format!(
            "Archive entry contains an unsafe path: {}",
            entry_name
        ));
    }

    let path = Path::new(&normalized_entry_name);
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(format!(
            "Archive entry contains an unsafe path: {}",
            entry_name
        ));
    }

    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(value) => relative.push(value),
            std::path::Component::CurDir => {}
            _ => {
                return Err(format!(
                    "Archive entry contains an unsafe path: {}",
                    entry_name
                ))
            }
        }
    }

    if relative.as_os_str().is_empty() {
        Err(format!(
            "Archive entry contains an unsafe path: {}",
            entry_name
        ))
    } else {
        Ok(relative)
    }
}

fn validate_rar_entry_path(entry_path: &Path) -> Result<()> {
    let entry_name = entry_path.to_string_lossy();
    safe_archive_relative_path(entry_name.as_ref())
        .map(|_| ())
        .map_err(|error| anyhow::anyhow!(error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Platform;
    use serde_json::json;
    use serial_test::serial;
    use std::io::Write;
    use tempfile::tempdir;
    use zip::write::FileOptions;
    use zip::ZipWriter;

    struct EnvVarGuard {
        key: &'static str,
        original: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let original = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, original }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.original {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

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
            depot_downloader_remembered_session: Some(false),
            max_concurrent_downloads: 1,
            platform: Platform::Windows,
            language: "en-US".to_string(),
            theme: "dark".to_string(),
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
            app_update: None,
            experience_mode: None,
            show_advanced_game_tools: None,
            window_close_behavior: None,
            setup_guide_completed: None,
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

    fn write_zip_with_file(path: &Path, entry_name: &str, contents: &[u8]) -> Result<()> {
        let archive_file = File::create(path)?;
        let mut archive = ZipWriter::new(archive_file);
        archive.start_file(entry_name, FileOptions::default())?;
        archive.write_all(contents)?;
        archive.finish()?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn live_scan_opted_in() -> bool {
        std::env::var("SIMM_MLVSCAN_LIVE_SCAN")
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    }

    #[cfg(target_os = "linux")]
    async fn run_dotnet_command(
        dotnet_program: &Path,
        dotnet_root: Option<&Path>,
        args: Vec<String>,
        description: &str,
    ) -> Result<()> {
        let mut command = Command::new(dotnet_program);
        command.args(&args);
        if let Some(dotnet_root) = dotnet_root {
            SecurityScannerService::apply_dotnet_root_env(&mut command, dotnet_root)?;
        }

        let output = command.output().await.with_context(|| {
            format!(
                "Failed to run {} while {description}",
                dotnet_program.display()
            )
        })?;

        if output.status.success() {
            return Ok(());
        }

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = [stdout.as_str(), stderr.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        let command = std::iter::once(dotnet_program.to_string_lossy().to_string())
            .chain(args)
            .collect::<Vec<_>>()
            .join(" ");

        Err(anyhow::anyhow!(
            "Command `{}` failed while {} (code {:?}).{}{}",
            command,
            description,
            output.status.code(),
            if detail.is_empty() { "" } else { "\n" },
            detail
        ))
    }

    #[cfg(target_os = "linux")]
    async fn build_live_scan_fixture(
        temp_root: &Path,
        dotnet_program: &Path,
        dotnet_root: Option<&Path>,
    ) -> Result<PathBuf> {
        let project_dir = temp_root.join("SimmMlvScanFixture");
        let project_dir_str = project_dir.to_string_lossy().to_string();

        run_dotnet_command(
            dotnet_program,
            dotnet_root,
            vec![
                "new".to_string(),
                "classlib".to_string(),
                "--framework".to_string(),
                "net8.0".to_string(),
                "--name".to_string(),
                "SimmMlvScanFixture".to_string(),
                "--output".to_string(),
                project_dir_str.clone(),
            ],
            "creating the MLVScan live scan fixture",
        )
        .await?;

        run_dotnet_command(
            dotnet_program,
            dotnet_root,
            vec![
                "build".to_string(),
                project_dir_str,
                "--configuration".to_string(),
                "Release".to_string(),
                "--nologo".to_string(),
            ],
            "building the MLVScan live scan fixture",
        )
        .await?;

        let dll_path = project_dir
            .join("bin")
            .join("Release")
            .join("net8.0")
            .join("SimmMlvScanFixture.dll");
        if !dll_path.exists() {
            return Err(anyhow::anyhow!(
                "Dotnet build completed but fixture DLL was not found at {}",
                dll_path.display()
            ));
        }

        Ok(dll_path)
    }

    #[test]
    fn scanner_executable_name_matches_host() {
        if cfg!(target_os = "windows") {
            assert_eq!(
                SecurityScannerService::scanner_executable_name(),
                "mlvscan.exe"
            );
        } else {
            assert_eq!(SecurityScannerService::scanner_executable_name(), "mlvscan");
        }
    }

    #[test]
    fn binary_release_fallback_is_windows_only() {
        assert_eq!(
            SecurityScannerService::binary_release_supported_on_host(),
            cfg!(target_os = "windows")
        );
        if cfg!(target_os = "windows") {
            assert_eq!(
                SecurityScannerService::binary_release_asset_names(),
                Some((WINDOWS_ZIP_ASSET_NAME, WINDOWS_SHA256_ASSET_NAME))
            );
        } else {
            assert_eq!(SecurityScannerService::binary_release_asset_names(), None);
        }
    }

    #[test]
    fn dotnet_sdk_detection_accepts_sdk_8_or_newer() {
        assert_eq!(
            SecurityScannerService::first_dotnet_sdk_8_version(
                "7.0.410 [/usr/lib/dotnet/sdk]\n8.0.100 [/usr/lib/dotnet/sdk]\n"
            ),
            Some("8.0.100".to_string())
        );
        assert_eq!(
            SecurityScannerService::first_dotnet_sdk_8_version("9.0.200 [/opt/dotnet/sdk]\n"),
            Some("9.0.200".to_string())
        );
        assert_eq!(
            SecurityScannerService::first_dotnet_sdk_8_version("7.0.410 [/sdk]\n"),
            None
        );
    }

    #[test]
    #[serial]
    fn managed_dotnet_paths_live_under_scanner_tool_root() -> Result<()> {
        let temp = tempdir()?;
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", temp.path().to_string_lossy().as_ref());
        let service = SecurityScannerService::new();

        assert_eq!(
            service.managed_dotnet_sdk_dir()?,
            temp.path()
                .join("tools")
                .join("mlvscan-security-scanner")
                .join("dotnet-sdk-8")
        );
        assert_eq!(
            service.managed_dotnet_executable_path()?,
            service.managed_dotnet_sdk_dir()?.join("dotnet")
        );
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn resolve_executable_detects_managed_dotnet_tool_host_executable() -> Result<()> {
        let temp = tempdir()?;
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", temp.path().to_string_lossy().as_ref());
        let service = SecurityScannerService::new();
        let executable_path = service.dotnet_tool_executable_path()?;
        let parent = executable_path.parent().expect("tool executable parent");
        fs::create_dir_all(parent).await?;
        fs::write(&executable_path, b"scanner").await?;

        let resolved = service
            .resolve_executable()
            .await?
            .expect("managed dotnet tool executable should resolve");

        assert_eq!(resolved.path, executable_path);
        assert_eq!(resolved.install_method, "managedDotnetTool");
        Ok(())
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[serial]
    async fn resolve_executable_reports_private_sdk_tool_when_managed_dotnet_exists() -> Result<()>
    {
        let temp = tempdir()?;
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", temp.path().to_string_lossy().as_ref());
        let service = SecurityScannerService::new();

        let executable_path = service.dotnet_tool_executable_path()?;
        fs::create_dir_all(executable_path.parent().expect("tool executable parent")).await?;
        fs::write(&executable_path, b"scanner").await?;

        let dotnet_path = service.managed_dotnet_executable_path()?;
        fs::create_dir_all(dotnet_path.parent().expect("dotnet executable parent")).await?;
        fs::write(&dotnet_path, b"dotnet").await?;

        let resolved = service
            .resolve_executable()
            .await?
            .expect("managed dotnet sdk tool executable should resolve");

        assert_eq!(resolved.path, executable_path);
        assert_eq!(resolved.install_method, "managedDotnetSdkTool");
        Ok(())
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[serial]
    #[ignore = "Downloads or updates MLVScan.DevCLI and bootstraps a private .NET SDK 8 on Linux when needed"]
    async fn live_linux_install_latest_uses_dotnet_tool_or_private_sdk() -> Result<()> {
        let temp = tempdir()?;
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", temp.path().to_string_lossy().as_ref());
        let service = SecurityScannerService::new();
        let settings = test_settings();

        let status = service.install_latest(&settings).await?;
        let executable_path = service.dotnet_tool_executable_path()?;

        assert!(status.installed);
        assert!(
            matches!(
                status.install_method.as_deref(),
                Some("managedDotnetTool") | Some("managedDotnetSdkTool")
            ),
            "unexpected install method: {:?}",
            status.install_method
        );
        assert_eq!(
            status.executable_path.as_deref(),
            Some(executable_path.to_string_lossy().as_ref())
        );
        assert!(executable_path.exists());
        assert!(status.installed_version.is_some());
        assert!(status.schema_version.is_some());

        Ok(())
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[serial]
    #[ignore = "Opt-in live smoke that installs MLVScan and scans a real .NET assembly when SIMM_MLVSCAN_LIVE_SCAN=1"]
    async fn live_linux_scan_executes_against_real_dotnet_assembly() -> Result<()> {
        if !live_scan_opted_in() {
            eprintln!(
                "Skipping MLVScan live scan smoke: set SIMM_MLVSCAN_LIVE_SCAN=1 to install/run MLVScan against a real .NET assembly."
            );
            return Ok(());
        }

        let temp = tempdir()?;
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", temp.path().to_string_lossy().as_ref());
        let service = SecurityScannerService::new();
        let settings = test_settings();

        let dll_path = match std::env::var("SIMM_MLVSCAN_LIVE_SCAN_DLL") {
            Ok(path) if !path.trim().is_empty() => {
                let configured = PathBuf::from(path);
                if !configured.exists() {
                    return Err(anyhow::anyhow!(
                        "SIMM_MLVSCAN_LIVE_SCAN_DLL does not exist: {}",
                        configured.display()
                    ));
                }
                configured
            }
            _ => {
                let status = service.install_latest(&settings).await?;
                assert!(status.installed);
                let managed_dotnet = service.managed_dotnet_executable_path()?;
                if managed_dotnet.exists() {
                    let managed_root = service.managed_dotnet_sdk_dir()?;
                    build_live_scan_fixture(temp.path(), &managed_dotnet, Some(&managed_root))
                        .await?
                } else {
                    build_live_scan_fixture(temp.path(), Path::new("dotnet"), None).await?
                }
            }
        };

        let report = service.scan_artifact(&dll_path, &settings).await?;

        assert!(
            matches!(
                report.summary.state,
                SecurityScanState::Verified | SecurityScanState::Review
            ),
            "expected MLVScan to execute a real scan, got {:?}: {:?}",
            report.summary.state,
            report.summary.status_message
        );
        assert!(
            !report.files.is_empty(),
            "expected at least one scanned file report"
        );
        assert!(
            report.summary.scanner_version.is_some(),
            "expected scanner version metadata from MLVScan"
        );
        assert!(
            report.summary.schema_version.is_some(),
            "expected schema version metadata from MLVScan"
        );

        Ok(())
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

    #[test]
    fn unavailable_report_blocks_when_configured_scanner_errors() {
        let report = SecurityScannerService::unavailable_report(
            "scanner executable exited before producing a report".to_string(),
            &test_settings(),
        );

        assert_eq!(report.summary.state, SecurityScanState::Unavailable);
        assert!(!report.summary.verified);
        assert!(report.policy.enabled);
        assert!(report.policy.blocked);
        assert!(!report.policy.requires_confirmation);
        assert!(report
            .policy
            .status_message
            .as_deref()
            .is_some_and(|message| message.contains(
                "Installation remains blocked until scanning succeeds or security scanning is disabled in settings."
            )));
    }

    #[test]
    fn archive_kind_falls_back_to_zip_signature_when_path_has_no_extension() -> Result<()> {
        let temp = tempdir()?;
        let archive_path = temp.path().join("downloaded-artifact");
        write_zip_with_file(&archive_path, "RootMod.dll", b"fake assembly bytes")?;

        assert_eq!(
            archive_kind_for_path(&archive_path),
            InputArchiveKind::Unsupported
        );
        assert_eq!(
            archive_kind_for_path_or_signature(&archive_path),
            InputArchiveKind::Zip
        );

        Ok(())
    }

    #[tokio::test]
    async fn extract_zip_to_directory_collects_single_root_dll() -> Result<()> {
        let temp = tempdir()?;
        let archive_path = temp.path().join("single-dll.zip");
        let target_dir = temp.path().join("extract");
        std::fs::create_dir_all(&target_dir)?;
        write_zip_with_file(&archive_path, "RootMod.dll", b"fake assembly bytes")?;

        let service = SecurityScannerService::new();
        service
            .extract_zip_to_directory(&archive_path, &target_dir)
            .await?;
        let dlls = service.collect_dll_files(&target_dir).await?;

        assert_eq!(dlls, vec![target_dir.join("RootMod.dll")]);

        Ok(())
    }

    #[tokio::test]
    async fn extract_zip_to_directory_rejects_traversal_paths() -> Result<()> {
        let temp = tempdir()?;
        let archive_path = temp.path().join("scanner.zip");
        let target_dir = temp.path().join("extract");
        std::fs::create_dir_all(&target_dir)?;

        write_zip_with_file(&archive_path, "../escape.txt", b"unsafe")?;

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

    #[tokio::test]
    async fn scan_archive_cleans_extracted_tree_when_scanner_execution_fails() -> Result<()> {
        let temp = tempdir()?;
        let archive_path = temp.path().join("scanner.zip");
        let temp_parent = temp.path().join("scan-temp-parent");
        std::fs::create_dir_all(&temp_parent)?;
        write_zip_with_file(&archive_path, "RootMod.dll", b"fake assembly bytes")?;

        let service = SecurityScannerService::new();
        let error = service
            .scan_archive_in_temp_parent(
                Path::new("definitely-not-an-mlvscan-executable"),
                &archive_path,
                ArchiveKind::Zip,
                &temp_parent,
            )
            .await
            .expect_err("a missing scanner executable should fail the scan");

        assert!(error.to_string().contains("Failed to scan"));
        assert!(
            std::fs::read_dir(&temp_parent)?.next().is_none(),
            "temporary extraction tree should be removed after scanner execution failure"
        );

        Ok(())
    }

    #[tokio::test]
    async fn scan_archive_cleans_extracted_tree_when_extraction_fails() -> Result<()> {
        let temp = tempdir()?;
        let archive_path = temp.path().join("unsafe-scanner.zip");
        let temp_parent = temp.path().join("scan-temp-parent");
        std::fs::create_dir_all(&temp_parent)?;
        write_zip_with_file(&archive_path, "../escape.dll", b"unsafe")?;

        let service = SecurityScannerService::new();
        let error = service
            .scan_archive_in_temp_parent(
                Path::new("not-used-when-extraction-fails"),
                &archive_path,
                ArchiveKind::Zip,
                &temp_parent,
            )
            .await
            .expect_err("unsafe archive entry should fail extraction");

        assert!(error.to_string().contains("unsafe path"));
        assert!(
            std::fs::read_dir(&temp_parent)?.next().is_none(),
            "temporary extraction tree should be removed after extraction failure"
        );

        Ok(())
    }

    #[test]
    fn validate_rar_entry_path_rejects_unsafe_paths() {
        for entry_name in [
            "../escape.dll",
            r"..\escape.dll",
            "/tmp/escape.dll",
            r"C:\Users\Public\escape.dll",
            "",
        ] {
            let err = validate_rar_entry_path(Path::new(entry_name))
                .expect_err("expected unsafe RAR entry path to be rejected");
            assert!(
                err.to_string().contains("unsafe path"),
                "unexpected error for {entry_name:?}: {err}"
            );
        }
    }

    #[test]
    fn validate_rar_entry_path_allows_safe_nested_paths() -> Result<()> {
        validate_rar_entry_path(Path::new("Mods/Example.dll"))?;
        validate_rar_entry_path(Path::new(r"Plugins\Nested\Example.dll"))?;
        Ok(())
    }
}
