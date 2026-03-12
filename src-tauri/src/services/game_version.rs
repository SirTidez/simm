use anyhow::{Context, Result};
use regex::Regex;
use std::path::Path;
use tokio::fs;

pub struct GameVersionService;

impl GameVersionService {
    pub fn new() -> Self {
        Self
    }

    fn is_unity_editor_version(&self, version: &str) -> bool {
        // Unity editor versions typically start with 4-digit years (2020, 2021, 2022, etc.)
        let unity_editor_pattern = Regex::new(r"^20\d{2}\.").unwrap();
        unity_editor_pattern.is_match(version)
    }

    fn is_game_version(&self, version: &str) -> bool {
        // Game versions typically start with 0 or 1, format like 0.4.2f9, 1.0.0, etc.
        if self.is_unity_editor_version(version) {
            eprintln!(
                "[GameVersion] Version {} is Unity editor version, rejecting",
                version
            );
            return false;
        }
        // Should match pattern: X.Y.ZfN or X.Y.Z where X is typically 0 or 1
        // But also allow versions like 0.4.2f9, 0.4.2, 1.0.0, etc.
        let game_version_pattern = Regex::new(r"^[01]\.[0-9]+\.[0-9]+[a-z]?[0-9]*$").unwrap();
        let matches = game_version_pattern.is_match(version);
        if !matches {
            eprintln!(
                "[GameVersion] Version {} does not match game version pattern",
                version
            );
        }
        matches
    }

    pub async fn extract_game_version(&self, game_dir: &str) -> Result<Option<String>> {
        eprintln!("[GameVersion] Extracting version from: {}", game_dir);
        let game_path = Path::new(game_dir);

        if !game_path.exists() {
            eprintln!("[GameVersion] Game directory does not exist: {}", game_dir);
            return Ok(None);
        }

        // Method 1: Check app.info file
        eprintln!("[GameVersion] Trying app.info file...");
        if let Some(version) = self.extract_version_from_app_info(game_path).await? {
            eprintln!("[GameVersion] Found version in app.info: {}", version);
            return Ok(Some(version));
        }

        // Method 2: Check for version.txt or similar text files
        eprintln!("[GameVersion] Trying version.txt files...");
        if let Some(version) = self.extract_version_from_text_file(game_path).await? {
            eprintln!("[GameVersion] Found version in text file: {}", version);
            return Ok(Some(version));
        }

        // Method 3: Extract from Unity binary assets (globalgamemanagers) - like Node.js version
        eprintln!("[GameVersion] Trying Unity binary assets (globalgamemanagers)...");
        if let Some(version) = self.extract_version_from_unity_assets(game_path).await? {
            eprintln!("[GameVersion] Found version in Unity assets: {}", version);
            return Ok(Some(version));
        }

        // Method 4: Extract from Unity game assemblies (like s1-codearchiver does)
        eprintln!("[GameVersion] Trying Unity game assemblies...");
        if let Some(version) = self.extract_version_from_assemblies(game_path).await? {
            eprintln!("[GameVersion] Found version in assemblies: {}", version);
            return Ok(Some(version));
        }

        // Method 5: Extract from executable metadata
        eprintln!("[GameVersion] Trying executable metadata...");
        if let Some(version) = self.extract_version_from_executable(game_path).await? {
            eprintln!("[GameVersion] Found version in executable: {}", version);
            return Ok(Some(version));
        }

        eprintln!("[GameVersion] No version found using any method");
        Ok(None)
    }

    async fn extract_version_from_app_info(&self, game_dir: &Path) -> Result<Option<String>> {
        let data_folders = vec![
            game_dir.join("Schedule I_Data"),
            game_dir.join("ScheduleI_Data"),
            game_dir.join("Schedule1_Data"),
            game_dir.join("Game_Data"),
            game_dir.join("Data"),
        ];

        for data_folder in &data_folders {
            if !data_folder.exists() {
                eprintln!(
                    "[GameVersion] Data folder does not exist: {:?}",
                    data_folder
                );
                continue;
            }

            eprintln!("[GameVersion] Checking data folder: {:?}", data_folder);
            let app_info_path = data_folder.join("app.info");
            if app_info_path.exists() {
                eprintln!("[GameVersion] Found app.info at: {:?}", app_info_path);

                // Try reading as text first
                if let Ok(content) = fs::read_to_string(&app_info_path).await {
                    eprintln!(
                        "[GameVersion] app.info content (first 500 chars): {}",
                        content.chars().take(500).collect::<String>()
                    );

                    // Try to find version pattern
                    let game_version_pattern = Regex::new(
                        r"(?:version|Version|VERSION)[:\s]*([01]\.[0-9]+\.[0-9]+[a-z]?[0-9]*)",
                    )
                    .context("Failed to compile regex")?;

                    if let Some(caps) = game_version_pattern.captures(&content) {
                        if let Some(version) = caps.get(1) {
                            let version_str = version.as_str();
                            eprintln!("[GameVersion] Found version pattern match: {}", version_str);
                            if self.is_game_version(version_str) {
                                return Ok(Some(version_str.to_string()));
                            } else {
                                eprintln!(
                                    "[GameVersion] Version {} did not pass is_game_version check",
                                    version_str
                                );
                            }
                        }
                    }

                    // Fallback to any version pattern
                    let version_pattern = Regex::new(r"([0-9]+\.[0-9]+\.[0-9]+[a-z]?[0-9]*)")
                        .context("Failed to compile regex")?;

                    for cap in version_pattern.captures_iter(&content) {
                        if let Some(version) = cap.get(1) {
                            let version_str = version.as_str();
                            eprintln!(
                                "[GameVersion] Found version pattern (fallback): {}",
                                version_str
                            );
                            if self.is_game_version(version_str) {
                                return Ok(Some(version_str.to_string()));
                            } else {
                                eprintln!(
                                    "[GameVersion] Version {} did not pass is_game_version check",
                                    version_str
                                );
                            }
                        }
                    }

                    // Check if entire content is a game version (like Node.js version does)
                    let trimmed = content.trim();
                    let simple_version_pattern =
                        Regex::new(r"^([0-9]+\.[0-9]+\.[0-9]+[a-z]?[0-9]*)$")
                            .context("Failed to compile regex")?;
                    if let Some(caps) = simple_version_pattern.captures(trimmed) {
                        if let Some(version) = caps.get(1) {
                            let version_str = version.as_str();
                            eprintln!(
                                "[GameVersion] Entire app.info content is version: {}",
                                version_str
                            );
                            if self.is_game_version(version_str) {
                                return Ok(Some(version_str.to_string()));
                            }
                        }
                    }
                } else {
                    eprintln!("[GameVersion] Failed to read app.info as text, trying binary...");
                    // Try reading as binary and searching for version strings
                    if let Ok(bytes) = fs::read(&app_info_path).await {
                        let text = String::from_utf8_lossy(&bytes);
                        eprintln!(
                            "[GameVersion] app.info binary content (first 500 chars): {}",
                            text.chars().take(500).collect::<String>()
                        );

                        // Search for version patterns in binary data
                        let version_pattern = Regex::new(r"([01]\.[0-9]+\.[0-9]+[a-z]?[0-9]*)")
                            .context("Failed to compile regex")?;

                        for cap in version_pattern.captures_iter(&text) {
                            if let Some(version) = cap.get(1) {
                                let version_str = version.as_str();
                                eprintln!(
                                    "[GameVersion] Found version pattern in binary: {}",
                                    version_str
                                );
                                if self.is_game_version(version_str) {
                                    return Ok(Some(version_str.to_string()));
                                }
                            }
                        }
                    }
                }
            } else {
                eprintln!(
                    "[GameVersion] app.info does not exist at: {:?}",
                    app_info_path
                );
            }
        }

        Ok(None)
    }

    async fn extract_version_from_text_file(&self, game_dir: &Path) -> Result<Option<String>> {
        let version_files = vec![
            game_dir.join("version.txt"),
            game_dir.join("Version.txt"),
            game_dir.join("VERSION.txt"),
            game_dir.join("version"),
            game_dir.join("Version"),
        ];

        for version_file in &version_files {
            if version_file.exists() {
                eprintln!("[GameVersion] Found version file: {:?}", version_file);
                if let Ok(content) = fs::read_to_string(version_file).await {
                    let version = content.trim().to_string();
                    eprintln!("[GameVersion] Read version from file: {}", version);
                    if self.is_game_version(&version) {
                        return Ok(Some(version));
                    }
                } else {
                    eprintln!(
                        "[GameVersion] Failed to read version file: {:?}",
                        version_file
                    );
                }
            }
        }

        Ok(None)
    }

    /// Extract version from Unity binary assets (globalgamemanagers) - matches Node.js implementation
    async fn extract_version_from_unity_assets(&self, game_dir: &Path) -> Result<Option<String>> {
        let data_folders = vec![
            game_dir.join("Schedule I_Data"),
            game_dir.join("ScheduleI_Data"),
            game_dir.join("Schedule1_Data"),
            game_dir.join("Game_Data"),
            game_dir.join("Data"),
        ];

        for data_folder in &data_folders {
            if !data_folder.exists() {
                continue;
            }

            eprintln!(
                "[GameVersion] Checking Unity assets in data folder: {:?}",
                data_folder
            );

            // Try globalgamemanagers file
            let globalgamemanagers_path = data_folder.join("globalgamemanagers");
            if globalgamemanagers_path.exists() {
                eprintln!(
                    "[GameVersion] Found globalgamemanagers: {:?}",
                    globalgamemanagers_path
                );
                if let Ok(bytes) = fs::read(&globalgamemanagers_path).await {
                    let search_len = std::cmp::min(bytes.len(), 2 * 1024 * 1024); // First 2MB
                    let text = String::from_utf8_lossy(&bytes[..search_len]);

                    // Look for game version patterns first (prioritize game versions)
                    let game_version_pattern =
                        Regex::new(r"\b([01]\.[0-9]+\.[0-9]+[a-z]?[0-9]*)\b")
                            .context("Failed to compile regex")?;

                    for cap in game_version_pattern.captures_iter(&text) {
                        if let Some(version) = cap.get(1) {
                            let version_str = version.as_str();
                            eprintln!("[GameVersion] Found game version pattern in globalgamemanagers: {}", version_str);
                            if self.is_game_version(version_str) {
                                return Ok(Some(version_str.to_string()));
                            }
                        }
                    }

                    // Fallback: look for any version pattern but exclude Unity editor versions
                    let all_version_pattern =
                        Regex::new(r"\b([0-9]+\.[0-9]+\.[0-9]+[a-z]?[0-9]*)\b")
                            .context("Failed to compile regex")?;

                    for cap in all_version_pattern.captures_iter(&text) {
                        if let Some(version) = cap.get(1) {
                            let version_str = version.as_str();
                            eprintln!(
                                "[GameVersion] Found version pattern in globalgamemanagers: {}",
                                version_str
                            );
                            if !self.is_unity_editor_version(version_str)
                                && self.is_game_version(version_str)
                            {
                                return Ok(Some(version_str.to_string()));
                            }
                        }
                    }
                }
            }

            // Try globalgamemanagers.assets
            let globalgamemanagers_assets_path = data_folder.join("globalgamemanagers.assets");
            if globalgamemanagers_assets_path.exists() {
                eprintln!(
                    "[GameVersion] Found globalgamemanagers.assets: {:?}",
                    globalgamemanagers_assets_path
                );
                if let Ok(bytes) = fs::read(&globalgamemanagers_assets_path).await {
                    let search_len = std::cmp::min(bytes.len(), 2 * 1024 * 1024); // First 2MB
                    let text = String::from_utf8_lossy(&bytes[..search_len]);

                    // Look for game version patterns first
                    let game_version_pattern =
                        Regex::new(r"\b([01]\.[0-9]+\.[0-9]+[a-z]?[0-9]*)\b")
                            .context("Failed to compile regex")?;

                    for cap in game_version_pattern.captures_iter(&text) {
                        if let Some(version) = cap.get(1) {
                            let version_str = version.as_str();
                            eprintln!("[GameVersion] Found game version pattern in globalgamemanagers.assets: {}", version_str);
                            if self.is_game_version(version_str) {
                                return Ok(Some(version_str.to_string()));
                            }
                        }
                    }

                    // Fallback
                    let all_version_pattern =
                        Regex::new(r"\b([0-9]+\.[0-9]+\.[0-9]+[a-z]?[0-9]*)\b")
                            .context("Failed to compile regex")?;

                    for cap in all_version_pattern.captures_iter(&text) {
                        if let Some(version) = cap.get(1) {
                            let version_str = version.as_str();
                            eprintln!("[GameVersion] Found version pattern in globalgamemanagers.assets: {}", version_str);
                            if !self.is_unity_editor_version(version_str)
                                && self.is_game_version(version_str)
                            {
                                return Ok(Some(version_str.to_string()));
                            }
                        }
                    }
                }
            }
        }

        Ok(None)
    }

    /// Extract version from Unity game assemblies (similar to s1-codearchiver approach)
    /// Looks for version in Assembly-CSharp.dll and other game assemblies
    async fn extract_version_from_assemblies(&self, game_dir: &Path) -> Result<Option<String>> {
        let data_folders = vec![
            game_dir.join("Schedule I_Data"),
            game_dir.join("ScheduleI_Data"),
            game_dir.join("Schedule1_Data"),
            game_dir.join("Game_Data"),
            game_dir.join("Data"),
        ];

        // Common Unity assembly locations
        let assembly_paths = vec![
            "Managed/Assembly-CSharp.dll",
            "Managed/Assembly-CSharp-firstpass.dll",
            "Managed/UnityEngine.dll",
            "Managed/UnityEngine.CoreModule.dll",
        ];

        for data_folder in &data_folders {
            if !data_folder.exists() {
                continue;
            }

            eprintln!(
                "[GameVersion] Checking assemblies in data folder: {:?}",
                data_folder
            );

            for assembly_rel_path in &assembly_paths {
                let assembly_path = data_folder.join(assembly_rel_path);
                if assembly_path.exists() {
                    eprintln!("[GameVersion] Found assembly: {:?}", assembly_path);

                    // Try PowerShell first (Windows) to get ProductVersion
                    #[cfg(target_os = "windows")]
                    {
                        #[allow(unused_imports)] // Required for CommandExt trait methods
                        use std::os::windows::process::CommandExt;
                        use tokio::process::Command;
                        let path_str = assembly_path.to_string_lossy().replace('\'', "''");
                        let output = Command::new("powershell")
                            .arg("-Command")
                            .arg(&format!(
                                "(Get-Item '{}').VersionInfo.ProductVersion",
                                path_str
                            ))
                            .creation_flags(0x08000000) // CREATE_NO_WINDOW flag
                            .output()
                            .await;

                        if let Ok(output) = output {
                            if output.status.success() {
                                let version =
                                    String::from_utf8_lossy(&output.stdout).trim().to_string();
                                eprintln!("[GameVersion] Assembly ProductVersion: '{}'", version);
                                if !version.is_empty()
                                    && version != "null"
                                    && self.is_game_version(&version)
                                {
                                    return Ok(Some(version));
                                }
                            }
                        }
                    }

                    // Search assembly binary for version strings (like s1-codearchiver does)
                    if let Ok(bytes) = fs::read(&assembly_path).await {
                        let search_len = std::cmp::min(bytes.len(), 5 * 1024 * 1024); // Search first 5MB
                        let text = String::from_utf8_lossy(&bytes[..search_len]);

                        // Look for AssemblyVersion or AssemblyFileVersion attributes
                        let assembly_version_re = Regex::new(
                            r#"AssemblyVersion[^\x00]*?([01]\.[0-9]+\.[0-9]+[a-z]?[0-9]*)"#,
                        )
                        .context("Failed to compile regex")?;

                        if let Some(caps) = assembly_version_re.captures(&text) {
                            if let Some(version) = caps.get(1) {
                                let version_str = version.as_str();
                                eprintln!(
                                    "[GameVersion] Found AssemblyVersion in binary: {}",
                                    version_str
                                );
                                if self.is_game_version(version_str) {
                                    return Ok(Some(version_str.to_string()));
                                }
                            }
                        }

                        // Try AssemblyFileVersion
                        let file_version_re = Regex::new(
                            r#"AssemblyFileVersion[^\x00]*?([01]\.[0-9]+\.[0-9]+[a-z]?[0-9]*)"#,
                        )
                        .context("Failed to compile regex")?;

                        if let Some(caps) = file_version_re.captures(&text) {
                            if let Some(version) = caps.get(1) {
                                let version_str = version.as_str();
                                eprintln!(
                                    "[GameVersion] Found AssemblyFileVersion in binary: {}",
                                    version_str
                                );
                                if self.is_game_version(version_str) {
                                    return Ok(Some(version_str.to_string()));
                                }
                            }
                        }

                        // Fallback: search for game version patterns in the binary
                        let version_pattern = Regex::new(r"([01]\.[0-9]+\.[0-9]+[a-z]?[0-9]*)")
                            .context("Failed to compile regex")?;

                        for cap in version_pattern.captures_iter(&text) {
                            if let Some(version) = cap.get(1) {
                                let version_str = version.as_str();
                                eprintln!(
                                    "[GameVersion] Found version pattern in assembly binary: {}",
                                    version_str
                                );
                                if self.is_game_version(version_str) {
                                    return Ok(Some(version_str.to_string()));
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(None)
    }

    async fn extract_version_from_executable(&self, game_dir: &Path) -> Result<Option<String>> {
        #[cfg(target_os = "windows")]
        {
            let executable_name = "Schedule I.exe";
            let executable_path = game_dir.join(executable_name);

            if executable_path.exists() {
                eprintln!("[GameVersion] Found executable: {:?}", executable_path);
                use tokio::process::Command;

                // Try ProductVersion instead of FileVersion - ProductVersion often contains the game version
                let path_str = executable_path.to_string_lossy().replace('\'', "''");
                eprintln!("[GameVersion] Running PowerShell command to get ProductVersion...");
                #[allow(unused_imports)] // Required for CommandExt trait methods
                use std::os::windows::process::CommandExt;
                let output = Command::new("powershell")
                    .arg("-Command")
                    .arg(&format!(
                        "(Get-Item '{}').VersionInfo.ProductVersion",
                        path_str
                    ))
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW flag
                    .output()
                    .await
                    .context("Failed to execute PowerShell command")?;

                if output.status.success() {
                    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    eprintln!(
                        "[GameVersion] PowerShell returned ProductVersion: '{}'",
                        version
                    );
                    if !version.is_empty() && version != "null" {
                        if self.is_game_version(&version) {
                            return Ok(Some(version));
                        } else {
                            eprintln!("[GameVersion] ProductVersion '{}' did not pass is_game_version check", version);
                        }
                    }
                }

                // Also try searching the executable binary for version strings
                eprintln!("[GameVersion] Searching executable binary for version strings...");
                if let Ok(bytes) = fs::read(&executable_path).await {
                    // Read first 2MB to search for version strings
                    let search_len = std::cmp::min(bytes.len(), 2 * 1024 * 1024);
                    let text = String::from_utf8_lossy(&bytes[..search_len]);

                    // Look for game version patterns in the binary
                    let version_pattern = Regex::new(r"([01]\.[0-9]+\.[0-9]+[a-z]?[0-9]*)")
                        .context("Failed to compile regex")?;

                    for cap in version_pattern.captures_iter(&text) {
                        if let Some(version) = cap.get(1) {
                            let version_str = version.as_str();
                            eprintln!(
                                "[GameVersion] Found version pattern in executable binary: {}",
                                version_str
                            );
                            if self.is_game_version(version_str) {
                                return Ok(Some(version_str.to_string()));
                            }
                        }
                    }
                }
            } else {
                eprintln!(
                    "[GameVersion] Executable does not exist: {:?}",
                    executable_path
                );
            }
        }

        Ok(None)
    }
}

impl Default for GameVersionService {
    fn default() -> Self {
        Self::new()
    }
}
