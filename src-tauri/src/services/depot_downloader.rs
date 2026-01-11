use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Command, Child};
use tokio::sync::RwLock;
use anyhow::{Context, Result};
use regex::Regex;
use crate::types::{DepotDownloadOptions, DownloadProgress, DownloadStatus};
use crate::utils::depot_downloader_detector::detect_depot_downloader;
use tauri::AppHandle;

pub struct DepotDownloaderService {
    active_downloads: Arc<RwLock<HashMap<String, Child>>>,
    download_progress: Arc<RwLock<HashMap<String, DownloadProgress>>>,
}

impl DepotDownloaderService {
    pub fn new() -> Self {
        Self {
            active_downloads: Arc::new(RwLock::new(HashMap::new())),
            download_progress: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    fn build_command_args(&self, options: &DepotDownloadOptions) -> Vec<String> {
        let mut args = Vec::new();

        args.push("-app".to_string());
        args.push(options.app_id.clone());
        args.push("-branch".to_string());
        args.push(options.branch.clone());
        args.push("-dir".to_string());
        args.push(options.output_dir.clone());

        if let Some(ref username) = options.username {
            args.push("-username".to_string());
            args.push(username.clone());
            if cfg!(target_os = "windows") {
                args.push("-remember-password".to_string());
            }
        }

        if let Some(ref steam_guard) = options.steam_guard {
            args.push("-steamguard".to_string());
            args.push(steam_guard.clone());
        }

        if options.validate.unwrap_or(false) {
            args.push("-validate".to_string());
        }

        if let Some(ref os) = options.os {
            args.push("-os".to_string());
            let os_str = match os {
                crate::types::Platform::Windows => "windows",
                crate::types::Platform::Macos => "macos",
                crate::types::Platform::Linux => "linux",
            };
            args.push(os_str.to_string());
        }

        if let Some(ref language) = options.language {
            args.push("-language".to_string());
            args.push(language.clone());
        }

        if let Some(max_downloads) = options.max_downloads {
            args.push("-max-downloads".to_string());
            args.push(max_downloads.to_string());
        }

        args
    }

    async fn parse_progress(
        &self,
        line: &str,
        download_id: &str,
        app: &AppHandle,
    ) -> Result<()> {
        let mut progress = {
            let map = self.download_progress.write().await;
            map.get(download_id)
                .cloned()
                .unwrap_or_else(|| DownloadProgress {
                    download_id: download_id.to_string(),
                    status: DownloadStatus::Downloading,
                    progress: 0.0,
                    downloaded_files: None,
                    total_files: None,
                    speed: None,
                    eta: None,
                    message: None,
                    error: None,
                    manifest_id: None,
                })
        };

        let lower_line = line.to_lowercase();

        // Check for password prompts
        if lower_line.contains("enter account password") 
            || lower_line.contains("password for")
            || (lower_line.contains("password") && (lower_line.contains(':') || lower_line.contains('>'))) {
            progress.message = Some(line.trim().to_string());
            self.download_progress.write().await.insert(download_id.to_string(), progress.clone());
            crate::events::emit_progress(app, progress.clone())?;
            crate::events::emit_auth_error(
                app,
                download_id.to_string(),
                "Password prompt detected. Please provide credentials in the authentication modal.".to_string(),
            )?;
            return Ok(());
        }

        // Steam Guard / 2FA waiting
        if lower_line.contains("steam guard") 
            || lower_line.contains("two-factor")
            || lower_line.contains("2fa")
            || lower_line.contains("mobile authenticator")
            || lower_line.contains("approve") {
            progress.message = Some("Waiting for Steam Guard approval...".to_string());
            self.download_progress.write().await.insert(download_id.to_string(), progress.clone());
            crate::events::emit_progress(app, progress.clone())?;
            crate::events::emit_auth_waiting(
                app,
                download_id.to_string(),
                "Please approve the login request on your Steam Mobile App".to_string(),
            )?;
            return Ok(());
        }

        // Authentication errors
        if lower_line.contains("password") 
            && (lower_line.contains("incorrect") 
                || lower_line.contains("invalid") 
                || lower_line.contains("wrong")) {
            progress.status = DownloadStatus::Error;
            progress.error = Some("Invalid password".to_string());
            self.download_progress.write().await.insert(download_id.to_string(), progress.clone());
            crate::events::emit_progress(app, progress.clone())?;
            crate::events::emit_auth_error(
                app,
                download_id.to_string(),
                "Invalid password. Please check your credentials.".to_string(),
            )?;
            return Ok(());
        }

        // Rate limiting / suspicious activity
        if lower_line.contains("rate limit")
            || lower_line.contains("too many")
            || lower_line.contains("suspicious")
            || lower_line.contains("blocked")
            || lower_line.contains("temporarily") {
            progress.status = DownloadStatus::Error;
            progress.error = Some("Steam rate limit or suspicious activity detected".to_string());
            self.download_progress.write().await.insert(download_id.to_string(), progress.clone());
            crate::events::emit_progress(app, progress.clone())?;
            crate::events::emit_auth_error(
                app,
                download_id.to_string(),
                "Steam has temporarily blocked this login attempt. Please wait a few minutes and try again, or use DepotDownloader directly to authenticate first.".to_string(),
            )?;
            return Ok(());
        }

        // Authentication success
        if lower_line.contains("logged in")
            || lower_line.contains("authentication successful")
            || lower_line.contains("login successful")
            || lower_line.contains("authenticated") {
            progress.message = Some("Authentication successful, starting download...".to_string());
            self.download_progress.write().await.insert(download_id.to_string(), progress.clone());
            crate::events::emit_progress(app, progress.clone())?;
            crate::events::emit_auth_success(app, download_id.to_string())?;
        }

        // Parse percentage: "Downloading depot 3164501 (45%)" or "05.30% filepath"
        // Try format with parentheses first: (45%)
        let percent_re_paren = Regex::new(r"\((\d+)%\)").unwrap();
        let mut found_percent = false;
        if let Some(caps) = percent_re_paren.captures(line) {
            if let Ok(percent) = caps[1].parse::<f64>() {
                progress.progress = percent.min(100.0).max(0.0);
                found_percent = true;
            }
        }
        
        // If not found in parentheses format, try plain format: 05.30% (match anywhere in line)
        // This will match percentages like "05.30%", "5.30%", "45%", etc.
        if !found_percent {
            let percent_re_plain = Regex::new(r"(\d+\.?\d*)%").unwrap();
            if let Some(caps) = percent_re_plain.captures(line) {
                if let Ok(percent) = caps[1].parse::<f64>() {
                    // Only update if we found a valid percentage (0-100)
                    if percent >= 0.0 && percent <= 100.0 {
                        progress.progress = percent;
                    }
                }
            }
        }

        // Parse file counts: "Downloaded 123 of 456 files"
        let file_re = Regex::new(r"(?i)Downloaded\s+(\d+)\s+of\s+(\d+)\s+files").unwrap();
        if let Some(caps) = file_re.captures(line) {
            if let (Ok(downloaded), Ok(total)) = (caps[1].parse::<u64>(), caps[2].parse::<u64>()) {
                progress.downloaded_files = Some(downloaded);
                progress.total_files = Some(total);
                
                // Calculate progress from file counts if percentage wasn't found
                // This ensures we always have a progress value
                if progress.progress == 0.0 && total > 0 {
                    progress.progress = ((downloaded as f64 / total as f64) * 100.0).min(100.0).max(0.0);
                }
            }
        }

        // Parse speed: "Speed: 5.2 MB/s"
        let speed_re = Regex::new(r"(?i)Speed:\s+([\d.]+)\s*(MB/s|KB/s)").unwrap();
        if let Some(caps) = speed_re.captures(line) {
            progress.speed = Some(format!("{} {}", &caps[1], &caps[2]));
        }

        // Parse manifest ID from output
        // DepotDownloader outputs manifest IDs in various formats:
        // - "Manifest: 1234567890"
        // - "Manifest ID: 1234567890"
        // - "Using manifest 1234567890"
        if progress.manifest_id.is_none() {
            let manifest_pattern = Regex::new(r"(?i)(?:manifest|manifestid)[:\s]+(\d{10,})").unwrap();
            if let Some(caps) = manifest_pattern.captures(line) {
                if let Some(manifest_id) = caps.get(1) {
                    progress.manifest_id = Some(manifest_id.as_str().to_string());
                    eprintln!("[DepotDownloader] Captured manifest ID: {}", manifest_id.as_str());
                }
            }
        }

        // Check for completion
        if line.contains("Download complete") || line.contains("All files downloaded") {
            progress.status = DownloadStatus::Completed;
            progress.progress = 100.0;
        }

        // Check for validation
        if line.contains("Validating") {
            progress.status = DownloadStatus::Validating;
        }

        // Update message - strip percentage patterns to avoid duplication
        if progress.message.is_none() || !progress.message.as_ref().unwrap().contains("Waiting") {
            let mut clean_message = line.trim().to_string();
            
            // Remove percentage patterns from message to avoid duplication
            // Remove format: (45%)
            clean_message = Regex::new(r"\s*\(\d+%\)\s*").unwrap()
                .replace_all(&clean_message, " ")
                .to_string();
            // Remove format: 05.30% or 45% at start of line
            clean_message = Regex::new(r"^\d+\.?\d*%\s*").unwrap()
                .replace_all(&clean_message, "")
                .to_string();
            // Remove any remaining standalone percentages
            clean_message = Regex::new(r"\s+\d+\.?\d*%\s+").unwrap()
                .replace_all(&clean_message, " ")
                .to_string();
            
            clean_message = clean_message.trim().to_string();
            if !clean_message.is_empty() {
                progress.message = Some(clean_message);
            }
        }

        self.download_progress.write().await.insert(download_id.to_string(), progress.clone());
        crate::events::emit_progress(app, progress)?;

        Ok(())
    }

    pub async fn start_download(
        &self,
        download_id: String,
        options: DepotDownloadOptions,
        app: AppHandle,
    ) -> Result<()> {
        // Check if download already exists
        {
            let map = self.active_downloads.read().await;
            if map.contains_key(&download_id) {
                return Err(anyhow::anyhow!("Download {} is already in progress", download_id));
            }
        }

        // Detect DepotDownloader
        let detector_info = detect_depot_downloader().await?;
        if !detector_info.installed || detector_info.path.is_none() {
            return Err(anyhow::anyhow!("DepotDownloader is not installed. Please install it first."));
        }

        let executable_path = detector_info.path.unwrap();

        // Initialize progress
        {
            let mut map = self.download_progress.write().await;
            map.insert(download_id.clone(), DownloadProgress {
                download_id: download_id.clone(),
                status: DownloadStatus::Downloading,
                progress: 0.0,
                downloaded_files: None,
                total_files: None,
                speed: None,
                eta: None,
                message: None,
                error: None,
                manifest_id: None,
            });
        }

        // Build command
        let args = self.build_command_args(&options);

        // Get depots directory from SIMM folder
        let depots_dir = crate::utils::directory_init::get_depots_dir()
            .context("Failed to get depots directory")?;

        // Spawn process with working directory set to depots folder
        let mut child = Command::new(&executable_path)
            .args(&args)
            .current_dir(&depots_dir) // Set working directory to SIMM/depots
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Failed to spawn DepotDownloader process")?;

        let _app_clone = app.clone();
        let _download_id_clone = download_id.clone();
        let service_clone = Arc::new(self.clone());

        // Handle stdout
        if let Some(stdout) = child.stdout.take() {
            let app_stdout = app.clone();
            let download_id_stdout = download_id.clone();
            let service_stdout = service_clone.clone();
            tokio::spawn(async move {
                let reader = BufReader::new(stdout);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.trim().is_empty() {
                        if let Err(e) = service_stdout.parse_progress(&line, &download_id_stdout, &app_stdout).await {
                            eprintln!("Error parsing progress: {}", e);
                        }
                    }
                }
            });
        }

        // Handle stderr
        if let Some(stderr) = child.stderr.take() {
            let app_stderr = app.clone();
            let download_id_stderr = download_id.clone();
            let service_stderr = service_clone.clone();
            tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.trim().is_empty() {
                        if let Err(e) = service_stderr.parse_progress(&line, &download_id_stderr, &app_stderr).await {
                            eprintln!("Error parsing progress: {}", e);
                        }
                    }
                }
            });
        }

        // Store child process
        self.active_downloads.write().await.insert(download_id.clone(), child);

        // Handle process completion
        let app_complete = app.clone();
        let download_id_complete = download_id.clone();
        let service_complete = service_clone.clone();
        tokio::spawn(async move {
            // Poll for process completion
            loop {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                let mut map = service_complete.active_downloads.write().await;
                if let Some(child) = map.get_mut(&download_id_complete) {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            map.remove(&download_id_complete);
                            drop(map);
                            
                            if status.success() {
                                let mut progress_map = service_complete.download_progress.write().await;
                                let manifest_id = if let Some(progress) = progress_map.get(&download_id_complete) {
                                    progress.manifest_id.clone()
                                } else {
                                    None
                                };
                                
                                if let Some(progress) = progress_map.get_mut(&download_id_complete) {
                                    progress.status = DownloadStatus::Completed;
                                    progress.progress = 100.0;
                                    let progress_clone = progress.clone();
                                    drop(progress_map);
                                    let _ = crate::events::emit_progress(&app_complete, progress_clone);
                                } else {
                                    drop(progress_map);
                                }
                                
                                // Emit complete event with manifest ID
                                let _ = crate::events::emit_complete(&app_complete, download_id_complete.clone(), manifest_id);
                            } else {
                                let mut progress_map = service_complete.download_progress.write().await;
                                if let Some(progress) = progress_map.get_mut(&download_id_complete) {
                                    progress.status = DownloadStatus::Error;
                                    progress.error = Some(format!("Process exited with code {:?}", status.code()));
                                    let progress_clone = progress.clone();
                                    drop(progress_map);
                                    let _ = crate::events::emit_progress(&app_complete, progress_clone);
                                }
                                let _ = crate::events::emit_error(
                                    &app_complete,
                                    download_id_complete.clone(),
                                    format!("DepotDownloader exited with code {:?}", status.code()),
                                );
                            }
                            break;
                        }
                        Ok(None) => {
                            // Process still running
                            drop(map);
                            continue;
                        }
                        Err(e) => {
                            // Error checking status
                            map.remove(&download_id_complete);
                            drop(map);
                            let mut progress_map = service_complete.download_progress.write().await;
                            if let Some(progress) = progress_map.get_mut(&download_id_complete) {
                                progress.status = DownloadStatus::Error;
                                progress.error = Some(format!("Error checking process status: {}", e));
                                let progress_clone = progress.clone();
                                drop(progress_map);
                                let _ = crate::events::emit_progress(&app_complete, progress_clone);
                            }
                            let _ = crate::events::emit_error(
                                &app_complete,
                                download_id_complete.clone(),
                                format!("Error checking process status: {}", e),
                            );
                            break;
                        }
                    }
                } else {
                    // Process already removed
                    break;
                }
            }
        });

        Ok(())
    }

    pub async fn cancel_download(&self, download_id: &str) -> Result<bool> {
        let mut map = self.active_downloads.write().await;
        if let Some(mut child) = map.remove(download_id) {
            child.kill().await?;
            
            let mut progress_map = self.download_progress.write().await;
            if let Some(progress) = progress_map.get_mut(download_id) {
                progress.status = DownloadStatus::Cancelled;
            }
            
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub async fn get_progress(&self, download_id: &str) -> Option<DownloadProgress> {
        let map = self.download_progress.read().await;
        map.get(download_id).cloned()
    }

    pub async fn get_active_downloads(&self) -> Vec<String> {
        let map = self.active_downloads.read().await;
        map.keys().cloned().collect()
    }
}

impl Clone for DepotDownloaderService {
    fn clone(&self) -> Self {
        Self {
            active_downloads: Arc::clone(&self.active_downloads),
            download_progress: Arc::clone(&self.download_progress),
        }
    }
}

impl Default for DepotDownloaderService {
    fn default() -> Self {
        Self::new()
    }
}

