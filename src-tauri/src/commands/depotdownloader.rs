use crate::types::DepotDownloaderInfo;
#[cfg(target_os = "windows")]
use std::path::PathBuf;
use tokio::process::Command;

#[cfg(target_os = "windows")]
const DEPOTDOWNLOADER_WINGET_ID: &str = "SteamRE.DepotDownloader";

#[cfg(target_os = "windows")]
fn apply_windows_flags(command: &mut Command) {
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
}

#[cfg(not(target_os = "windows"))]
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

        let output = command
            .output()
            .await
            .map_err(|e| format!("Failed to launch winget at {}: {}", winget_path.display(), e))?;

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
        Err("Automatic DepotDownloader installation is only supported on Windows. Please install manually from the DepotDownloader project page.".to_string())
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
