use crate::types::DepotDownloaderInfo;
#[cfg(target_os = "windows")]
use std::path::PathBuf;
use tokio::process::Command;

#[cfg(target_os = "windows")]
const DEPOTDOWNLOADER_WINGET_ID: &str = "SteamRE.DepotDownloader";
#[cfg(target_os = "linux")]
const DEPOTDOWNLOADER_LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/SteamRE/DepotDownloader/releases/latest";
#[cfg(target_os = "linux")]
const DEPOTDOWNLOADER_LINUX_ASSET_NAME: &str = "DepotDownloader-linux-x64.zip";

#[cfg(target_os = "linux")]
#[derive(Debug, serde::Deserialize)]
struct DepotDownloaderGithubRelease {
    assets: Vec<DepotDownloaderGithubAsset>,
}

#[cfg(target_os = "linux")]
#[derive(Debug, serde::Deserialize)]
struct DepotDownloaderGithubAsset {
    name: String,
    browser_download_url: String,
}

#[cfg(target_os = "windows")]
fn apply_windows_flags(command: &mut Command) {
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
fn apply_windows_flags(_command: &mut Command) {}

#[cfg(target_os = "windows")]
fn winget_alias_path() -> Option<PathBuf> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")?;
    let candidate = PathBuf::from(local_app_data)
        .join("Microsoft")
        .join("WindowsApps")
        .join("winget.exe");

    candidate.exists().then_some(candidate)
}

#[cfg(target_os = "windows")]
fn first_existing_path_from_lines(output: &[u8]) -> Option<PathBuf> {
    String::from_utf8_lossy(output)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|path| path.exists())
}

#[cfg(target_os = "windows")]
async fn resolve_winget_path() -> Result<PathBuf, String> {
    if let Some(path) = winget_alias_path() {
        return Ok(path);
    }

    let mut command = Command::new("where");
    command.arg("winget.exe");
    apply_windows_flags(&mut command);

    let output = command
        .output()
        .await
        .map_err(|e| format!("Failed to locate winget: {}", e))?;

    if let Some(path) = first_existing_path_from_lines(&output.stdout) {
        return Ok(path);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = [stdout.trim(), stderr.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    let mut message = format!(
        "winget was not found. Install DepotDownloader manually with: winget install --exact --id {}",
        DEPOTDOWNLOADER_WINGET_ID
    );

    if !detail.is_empty() {
        message.push_str("\n");
        message.push_str(&detail);
    }

    Err(message)
}

#[cfg(target_os = "linux")]
fn linux_install_dir() -> Result<std::path::PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".local").join("bin"))
        .ok_or_else(|| "Could not determine home directory for DepotDownloader install".to_string())
}

#[cfg(target_os = "linux")]
fn linux_installed_executable_path() -> Result<std::path::PathBuf, String> {
    Ok(linux_install_dir()?.join("DepotDownloader"))
}

#[cfg(target_os = "linux")]
fn find_depot_downloader_in_zip(archive: &mut zip::ZipArchive<std::fs::File>) -> Option<usize> {
    let expected_names = ["DepotDownloader", "depotdownloader"];

    (0..archive.len()).find(|index| {
        archive
            .by_index(*index)
            .ok()
            .filter(|file| !file.is_dir())
            .and_then(|file| {
                file.enclosed_name()
                    .and_then(|path| path.file_name().map(|name| name.to_owned()))
            })
            .and_then(|name| name.to_str().map(|value| value.to_string()))
            .is_some_and(|name| expected_names.iter().any(|expected| name == *expected))
    })
}

#[cfg(target_os = "linux")]
fn make_executable(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("Failed to read DepotDownloader permissions: {}", e))?;
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(path, permissions)
        .map_err(|e| format!("Failed to mark DepotDownloader executable: {}", e))
}

#[cfg(target_os = "linux")]
async fn install_depot_downloader_linux() -> Result<DepotDownloaderInfo, String> {
    let client = reqwest::Client::builder()
        .user_agent(crate::utils::http_identity::user_agent())
        .build()
        .map_err(|e| format!("Failed to build GitHub HTTP client: {}", e))?;

    let release = client
        .get(DEPOTDOWNLOADER_LATEST_RELEASE_URL)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch latest DepotDownloader release: {}", e))?
        .error_for_status()
        .map_err(|e| {
            format!(
                "GitHub returned an error for DepotDownloader release: {}",
                e
            )
        })?
        .json::<DepotDownloaderGithubRelease>()
        .await
        .map_err(|e| format!("Failed to parse latest DepotDownloader release: {}", e))?;

    let asset = release
        .assets
        .into_iter()
        .find(|asset| {
            asset
                .name
                .eq_ignore_ascii_case(DEPOTDOWNLOADER_LINUX_ASSET_NAME)
        })
        .ok_or_else(|| {
            format!(
                "Latest DepotDownloader release does not contain {}",
                DEPOTDOWNLOADER_LINUX_ASSET_NAME
            )
        })?;

    let archive_bytes = client
        .get(&asset.browser_download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download {}: {}", asset.name, e))?
        .error_for_status()
        .map_err(|e| {
            format!(
                "GitHub returned an error while downloading {}: {}",
                asset.name, e
            )
        })?
        .bytes()
        .await
        .map_err(|e| format!("Failed to read {} download bytes: {}", asset.name, e))?;

    let temp_root = std::env::temp_dir().join(format!(
        "simm-depotdownloader-install-{}",
        uuid::Uuid::new_v4()
    ));
    tokio::fs::create_dir_all(&temp_root).await.map_err(|e| {
        format!(
            "Failed to create DepotDownloader install staging dir: {}",
            e
        )
    })?;
    let archive_path = temp_root.join(&asset.name);
    tokio::fs::write(&archive_path, &archive_bytes)
        .await
        .map_err(|e| format!("Failed to stage DepotDownloader archive: {}", e))?;

    let target_path = linux_installed_executable_path()?;
    if let Some(parent) = target_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }

    {
        let archive_file = std::fs::File::open(&archive_path)
            .map_err(|e| format!("Failed to open staged DepotDownloader archive: {}", e))?;
        let mut archive = zip::ZipArchive::new(archive_file)
            .map_err(|e| format!("Failed to read DepotDownloader ZIP archive: {}", e))?;
        let executable_index = find_depot_downloader_in_zip(&mut archive).ok_or_else(|| {
            "DepotDownloader Linux archive did not contain a DepotDownloader executable".to_string()
        })?;
        let mut executable = archive
            .by_index(executable_index)
            .map_err(|e| format!("Failed to read DepotDownloader executable from ZIP: {}", e))?;
        let mut output = std::fs::File::create(&target_path)
            .map_err(|e| format!("Failed to create {}: {}", target_path.display(), e))?;
        std::io::copy(&mut executable, &mut output)
            .map_err(|e| format!("Failed to extract DepotDownloader executable: {}", e))?;
    }
    make_executable(&target_path)?;

    let _ = tokio::fs::remove_dir_all(&temp_root).await;

    let info = crate::utils::depot_downloader_detector::detect_depot_downloader()
        .await
        .map_err(|e| format!("Install finished but detection failed: {}", e))?;

    if !info.installed {
        return Err(format!(
            "Install completed but DepotDownloader is still not detected at {}",
            target_path.display()
        ));
    }

    Ok(info)
}

#[tauri::command]
pub async fn detect_depot_downloader() -> Result<DepotDownloaderInfo, String> {
    crate::utils::depot_downloader_detector::detect_depot_downloader()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn install_depot_downloader() -> Result<DepotDownloaderInfo, String> {
    #[cfg(target_os = "windows")]
    {
        let winget_path = resolve_winget_path().await?;

        let mut command = Command::new(&winget_path);
        command.args([
            "install",
            "--exact",
            "--id",
            DEPOTDOWNLOADER_WINGET_ID,
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--disable-interactivity",
        ]);
        apply_windows_flags(&mut command);

        let output = command.output().await.map_err(|e| {
            format!(
                "Failed to launch winget at {}: {}",
                winget_path.display(),
                e
            )
        })?;

        if !output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Winget install failed (code {:?}).\n{}\n{}",
                output.status.code(),
                stdout.trim(),
                stderr.trim()
            ));
        }

        let info = crate::utils::depot_downloader_detector::detect_depot_downloader()
            .await
            .map_err(|e| format!("Install finished but detection failed: {}", e))?;

        if !info.installed {
            return Err("Install command completed but DepotDownloader is still not detected. Please try manual install.".to_string());
        }

        Ok(info)
    }

    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(target_os = "linux")]
        {
            install_depot_downloader_linux().await
        }

        #[cfg(not(target_os = "linux"))]
        {
            Err("Automatic DepotDownloader installation is only supported on Windows and Linux. Please install manually from the DepotDownloader project page.".to_string())
        }
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use serial_test::serial;
    use tempfile::tempdir;

    struct EnvVarGuard {
        key: &'static str,
        original: Option<std::ffi::OsString>,
    }

    impl EnvVarGuard {
        fn set_os(key: &'static str, value: impl Into<std::ffi::OsString>) -> Self {
            let original = std::env::var_os(key);
            std::env::set_var(key, value.into());
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

    #[test]
    fn first_existing_path_from_lines_returns_first_existing_result() {
        let temp = tempdir().expect("tempdir");
        let first = temp.path().join("missing-winget.exe");
        let second = temp.path().join("winget.exe");
        std::fs::write(&second, b"").expect("create winget alias");

        let output = format!("{}\r\n{}\r\n", first.display(), second.display());
        let resolved = first_existing_path_from_lines(output.as_bytes());

        assert_eq!(resolved, Some(second));
    }

    #[tokio::test]
    #[serial]
    async fn resolve_winget_path_prefers_windows_apps_alias() {
        let temp = tempdir().expect("tempdir");
        let alias_dir = temp.path().join("Microsoft").join("WindowsApps");
        std::fs::create_dir_all(&alias_dir).expect("create alias dir");
        let alias_path = alias_dir.join("winget.exe");
        std::fs::write(&alias_path, b"").expect("create winget alias");

        let _local_app_data_guard = EnvVarGuard::set_os("LOCALAPPDATA", temp.path().as_os_str());
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        let system32 = PathBuf::from(system_root).join("System32");
        let _path_guard = EnvVarGuard::set_os("PATH", system32.into_os_string());

        let resolved = resolve_winget_path().await.expect("resolve winget");

        assert_eq!(resolved, alias_path);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::*;
    use serial_test::serial;
    use std::io::Write;
    use tempfile::tempdir;
    use zip::write::FileOptions;

    struct EnvVarGuard {
        key: &'static str,
        original: Option<std::ffi::OsString>,
    }

    impl EnvVarGuard {
        fn set_os(key: &'static str, value: impl Into<std::ffi::OsString>) -> Self {
            let original = std::env::var_os(key);
            std::env::set_var(key, value.into());
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

    #[test]
    #[serial]
    fn linux_installed_executable_path_uses_user_local_bin() {
        let temp = tempdir().expect("tempdir");
        let _home_guard = EnvVarGuard::set_os("HOME", temp.path().as_os_str());

        let path = linux_installed_executable_path().expect("linux install path");

        assert_eq!(path, temp.path().join(".local/bin/DepotDownloader"));
    }

    #[test]
    fn find_depot_downloader_in_zip_finds_nested_binary() {
        let temp = tempdir().expect("tempdir");
        let archive_path = temp.path().join("DepotDownloader-linux-x64.zip");
        let file = std::fs::File::create(&archive_path).expect("create archive");
        let mut writer = zip::ZipWriter::new(file);
        writer
            .start_file(
                "DepotDownloader-linux-x64/readme.txt",
                FileOptions::default(),
            )
            .expect("start readme");
        writer.write_all(b"readme").expect("write readme");
        writer
            .start_file(
                "DepotDownloader-linux-x64/DepotDownloader",
                FileOptions::default(),
            )
            .expect("start executable");
        writer.write_all(b"#!/bin/sh\n").expect("write executable");
        writer.finish().expect("finish archive");

        let file = std::fs::File::open(&archive_path).expect("open archive");
        let mut archive = zip::ZipArchive::new(file).expect("read archive");
        let index = find_depot_downloader_in_zip(&mut archive).expect("executable index");
        let file = archive.by_index(index).expect("read executable");

        assert_eq!(
            file.enclosed_name().unwrap().file_name().unwrap(),
            "DepotDownloader"
        );
    }

    #[test]
    fn make_executable_sets_execute_bits() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("DepotDownloader");
        std::fs::write(&path, b"#!/bin/sh\n").expect("write executable");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .expect("set initial permissions");

        make_executable(&path).expect("mark executable");

        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o755);
    }

    #[tokio::test]
    #[serial]
    #[ignore = "Downloads the latest DepotDownloader Linux release from GitHub"]
    async fn live_linux_installer_downloads_release_and_detects_temp_home_binary() {
        let temp = tempdir().expect("tempdir");
        let empty_path_dir = temp.path().join("empty-path");
        std::fs::create_dir_all(&empty_path_dir).expect("create empty path dir");
        let _home_guard = EnvVarGuard::set_os("HOME", temp.path().as_os_str());
        let _path_guard = EnvVarGuard::set_os("PATH", empty_path_dir.as_os_str());

        let info = install_depot_downloader_linux()
            .await
            .expect("install DepotDownloader from GitHub release");
        let expected_path = temp.path().join(".local/bin/DepotDownloader");

        assert!(info.installed);
        assert_eq!(
            info.path.as_deref(),
            Some(expected_path.to_string_lossy().as_ref())
        );
        assert!(expected_path.exists());
    }
}
