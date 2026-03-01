use crate::types::DepotDownloaderInfo;
use tokio::process::Command;

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
        let output = Command::new("winget")
            .args([
                "install",
                "--exact",
                "--id",
                "SteamRE.DepotDownloader",
                "--accept-package-agreements",
                "--accept-source-agreements",
            ])
            .output()
            .await
            .map_err(|e| format!("Failed to launch winget: {}", e))?;

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
