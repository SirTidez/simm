use anyhow::{Context, Result};
use chrono::{DateTime, Duration as ChronoDuration, Local, NaiveTime, TimeZone, Utc};
use regex::Regex;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::fs;
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LogFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: Option<DateTime<Utc>>,
    pub is_latest: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub line_number: usize,
    pub content: String,
    pub level: Option<String>,
    pub timestamp: Option<String>,
    pub mod_tag: Option<String>,
    pub category: LogCategory,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogCategory {
    MelonLoader,
    Mod,
    General,
}

pub struct LogsService {
    watching: Arc<RwLock<bool>>,
    last_position: Arc<RwLock<u64>>,
    last_line_count: Arc<RwLock<usize>>,
    watch_session_id: Arc<RwLock<u64>>,
}

impl LogsService {
    pub fn new() -> Self {
        Self {
            watching: Arc::new(RwLock::new(false)),
            last_position: Arc::new(RwLock::new(0)),
            last_line_count: Arc::new(RwLock::new(0)),
            watch_session_id: Arc::new(RwLock::new(0)),
        }
    }

    fn parse_log_timestamp_local(
        timestamp: &str,
        reference_dt: DateTime<Local>,
        live_rollover: bool,
    ) -> Option<DateTime<Local>> {
        let parsed_time = NaiveTime::parse_from_str(timestamp, "%H:%M:%S%.3f").ok()?;
        let mut parsed = Local
            .from_local_datetime(&reference_dt.date_naive().and_time(parsed_time))
            .single()?;

        if live_rollover && parsed > reference_dt {
            parsed -= ChronoDuration::days(1);
        }

        Some(parsed)
    }

    pub fn get_melonloader_logs_dir(&self, game_dir: &str) -> PathBuf {
        Path::new(game_dir).join("MelonLoader")
    }

    pub fn get_latest_log_path(&self, game_dir: &str) -> PathBuf {
        self.get_melonloader_logs_dir(game_dir).join("Latest.log")
    }

    pub fn get_logs_dir(&self, game_dir: &str) -> PathBuf {
        self.get_melonloader_logs_dir(game_dir).join("Logs")
    }

    pub fn get_shared_player_log_dir(&self) -> Option<PathBuf> {
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let trimmed = user_profile.trim();
            if !trimmed.is_empty() {
                return Some(
                    PathBuf::from(trimmed)
                        .join("AppData")
                        .join("LocalLow")
                        .join("TVGS")
                        .join("Schedule I"),
                );
            }
        }

        None
    }
    pub async fn list_log_files(&self, game_dir: &str) -> Result<Vec<LogFile>> {
        let mut log_files = Vec::new();

        // Check for environment-specific Latest.log
        let latest_log = self.get_latest_log_path(game_dir);
        if latest_log.exists() {
            if let Ok(metadata) = fs::metadata(&latest_log).await {
                let modified = metadata.modified().ok().and_then(|t| {
                    DateTime::<Utc>::from_timestamp(
                        t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64,
                        0,
                    )
                });

                log_files.push(LogFile {
                    name: "Latest.log".to_string(),
                    path: latest_log.to_string_lossy().to_string(),
                    size: metadata.len(),
                    modified,
                    is_latest: true,
                });
            }
        }

        // Check for environment-specific archived logs in MelonLoader/Logs
        let logs_dir = self.get_logs_dir(game_dir);
        if logs_dir.exists() {
            let mut entries = fs::read_dir(&logs_dir)
                .await
                .context("Failed to read Logs directory")?;

            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("log") {
                    if let Ok(metadata) = entry.metadata().await {
                        let file_name = path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("unknown.log")
                            .to_string();

                        let modified = metadata.modified().ok().and_then(|t| {
                            DateTime::<Utc>::from_timestamp(
                                t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64,
                                0,
                            )
                        });

                        log_files.push(LogFile {
                            name: file_name,
                            path: path.to_string_lossy().to_string(),
                            size: metadata.len(),
                            modified,
                            is_latest: false,
                        });
                    }
                }
            }
        }

        // Check for shared Unity player logs in LocalLow/TVGS/Schedule I
        if let Some(shared_dir) = self.get_shared_player_log_dir() {
            let shared_logs: [(&str, &str); 2] = [
                ("Player.log", "Player.log (Shared)"),
                ("Player-prev.log", "Player-prev.log (Shared)"),
            ];

            for (file_name, display_name) in shared_logs {
                let shared_path = shared_dir.join(file_name);
                if shared_path.exists() {
                    if let Ok(metadata) = fs::metadata(&shared_path).await {
                        let modified = metadata.modified().ok().and_then(|t| {
                            DateTime::<Utc>::from_timestamp(
                                t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64,
                                0,
                            )
                        });

                        log_files.push(LogFile {
                            name: display_name.to_string(),
                            path: shared_path.to_string_lossy().to_string(),
                            size: metadata.len(),
                            modified,
                            is_latest: false,
                        });
                    }
                }
            }
        }

        // Sort so live logs are first, then newest historical logs.
        log_files.sort_by(|a, b| {
            let rank = |file: &LogFile| -> u8 {
                if file.is_latest {
                    return 0;
                }

                let lower_name = file.name.to_ascii_lowercase();
                if lower_name.starts_with("player.log") {
                    return 1;
                }
                if lower_name.starts_with("player-prev.log") {
                    return 2;
                }

                3
            };

            let a_rank = rank(a);
            let b_rank = rank(b);
            if a_rank != b_rank {
                return a_rank.cmp(&b_rank);
            }

            match (a.modified, b.modified) {
                (Some(a_time), Some(b_time)) => b_time.cmp(&a_time),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => a.name.cmp(&b.name),
            }
        });

        Ok(log_files)
    }

    pub async fn read_log_file(
        &self,
        log_path: &str,
        max_lines: Option<usize>,
    ) -> Result<Vec<LogLine>> {
        let path = Path::new(log_path);

        if !path.exists() {
            return Err(anyhow::anyhow!("Log file does not exist: {}", log_path));
        }

        let file_bytes = fs::read(path).await.context("Failed to read log file")?;
        let content = Self::decode_log_content(&file_bytes);

        let lines: Vec<&str> = content.lines().collect();
        let total_lines = lines.len();
        let start_line = if let Some(max) = max_lines {
            total_lines.saturating_sub(max)
        } else {
            0
        };

        let mut log_lines = Vec::new();
        for (idx, line) in lines.iter().enumerate().skip(start_line) {
            let line_number = idx + 1;
            let raw_content = line.to_string();

            // Parse MelonLoader log format
            let timestamp = Self::extract_melonloader_timestamp(&raw_content);
            let mod_tag = Self::extract_mod_tag(&raw_content);
            let level = Self::extract_log_level(&raw_content);
            let category = Self::categorize_log(&raw_content, &mod_tag);

            // Strip timestamp and mod tag from content
            let content = Self::strip_timestamp_and_tag(&raw_content, &timestamp, &mod_tag);

            log_lines.push(LogLine {
                line_number,
                content,
                level,
                timestamp,
                mod_tag,
                category,
            });
        }

        Ok(log_lines)
    }

    fn decode_log_content(bytes: &[u8]) -> String {
        // UTF-16 LE with BOM
        if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
            let utf16: Vec<u16> = bytes[2..]
                .chunks_exact(2)
                .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                .collect();
            return String::from_utf16_lossy(&utf16);
        }

        // UTF-16 BE with BOM
        if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
            let utf16: Vec<u16> = bytes[2..]
                .chunks_exact(2)
                .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
                .collect();
            return String::from_utf16_lossy(&utf16);
        }

        // UTF-8 first, then lossy fallback for ANSI/non-UTF content.
        match std::str::from_utf8(bytes) {
            Ok(text) => text.to_string(),
            Err(_) => String::from_utf8_lossy(bytes).into_owned(),
        }
    }

    fn extract_log_level(line: &str) -> Option<String> {
        // Try to match [LEVEL] pattern
        if let Some(start) = line.find('[') {
            if let Some(end) = line[start + 1..].find(']') {
                let level = &line[start + 1..start + 1 + end];
                if ["INFO", "WARN", "ERROR", "DEBUG", "FATAL", "TRACE"].contains(&level) {
                    return Some(level.to_string());
                }
            }
        }
        None
    }

    fn extract_melonloader_timestamp(line: &str) -> Option<String> {
        // Extract MelonLoader timestamp format: [HH:MM:SS.mmm]
        let pattern = r"^\[(\d{2}:\d{2}:\d{2}\.\d{3})\]";
        if let Ok(re) = Regex::new(pattern) {
            if let Some(captures) = re.captures(line) {
                return captures.get(1).map(|m| m.as_str().to_string());
            }
        }
        None
    }

    fn extract_mod_tag(line: &str) -> Option<String> {
        // Extract mod tag from format: [timestamp] [ModTag] message
        // or just [ModTag] message
        // Skip after timestamp if present
        let mut search_line = line;
        if let Some(timestamp_end) = line.find(']') {
            if line.starts_with('[') && line[1..timestamp_end].contains(':') {
                search_line = &line[timestamp_end + 1..];
            }
        }

        let pattern = r"^\s*\[([^\]]+)\]";
        if let Ok(re) = Regex::new(pattern) {
            if let Some(captures) = re.captures(search_line) {
                if let Some(tag) = captures.get(1) {
                    let tag_str = tag.as_str().trim();

                    // Skip if it's a log level or timestamp
                    if ["INFO", "WARN", "ERROR", "DEBUG", "FATAL", "TRACE"].contains(&tag_str)
                        || tag_str.contains(':')
                    {
                        return None;
                    }

                    // Skip MelonLoader system tags
                    let melonloader_system_tags =
                        ["Il2CppAssemblyGenerator", "Il2CppInterop", "StoragePatches"];

                    if melonloader_system_tags
                        .iter()
                        .any(|&sys_tag| tag_str == sys_tag)
                    {
                        return None;
                    }

                    return Some(tag_str.to_string());
                }
            }
        }
        None
    }

    fn strip_timestamp_and_tag(
        line: &str,
        timestamp: &Option<String>,
        mod_tag: &Option<String>,
    ) -> String {
        let mut cleaned = line.to_string();

        // Remove timestamp if present
        if timestamp.is_some() {
            let pattern = r"^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s*";
            if let Ok(re) = Regex::new(pattern) {
                cleaned = re.replace(&cleaned, "").to_string();
            }
        }

        // Remove mod tag if present
        if let Some(tag) = mod_tag {
            let pattern_str = format!(r"^\s*\[{}\]\s*", regex::escape(tag));
            if let Ok(re) = Regex::new(&pattern_str) {
                cleaned = re.replace(&cleaned, "").to_string();
            }
        }

        cleaned
    }

    fn categorize_log(line: &str, mod_tag: &Option<String>) -> LogCategory {
        // MelonLoader system logs
        let melonloader_tags = [
            "Il2CppAssemblyGenerator",
            "Il2CppInterop",
            "StoragePatches",
            "PhoneApp",
        ];

        if let Some(tag) = mod_tag {
            if melonloader_tags.iter().any(|&ml_tag| tag.contains(ml_tag)) {
                return LogCategory::MelonLoader;
            }
            return LogCategory::Mod;
        }

        // Check if line contains MelonLoader-specific text
        if line.contains("MelonLoader")
            || line.contains("Unity")
            || line.contains("Game Name:")
            || line.contains("Game Developer:")
            || line.contains("Loading Plugins...")
            || line.contains("Loading Mods...")
            || line.contains("Melon Assembly loaded:")
            || line.contains("SHA256 Hash:")
            || line.contains("Support Module Loaded:")
            || line.contains("Scene loaded:")
        {
            return LogCategory::MelonLoader;
        }

        LogCategory::General
    }

    pub async fn export_logs(
        &self,
        log_path: &str,
        filter_level: Option<&str>,
        filter_category: Option<&str>,
        search_query: Option<&str>,
        filter_mod_tag: Option<&str>,
        time_period: Option<&str>,
        custom_time_start: Option<&str>,
        custom_time_end: Option<&str>,
        output_path: &str,
    ) -> Result<()> {
        let log_lines = self.read_log_file(log_path, None).await?;

        // Normalize mod tag for comparison (removes spaces and converts to lowercase)
        let normalize_mod_tag = |tag: &str| -> String {
            tag.chars()
                .filter(|c| !c.is_whitespace())
                .collect::<String>()
                .to_lowercase()
        };

        let normalized_filter_tag = filter_mod_tag.map(normalize_mod_tag);
        let normalized_filter_category = filter_category.map(|value| value.to_ascii_lowercase());
        let reference_dt = fs::metadata(Path::new(log_path))
            .await
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .map(|modified| DateTime::<Utc>::from(modified).with_timezone(&Local))
            .unwrap_or_else(Local::now);
        let live_rollover = Path::new(log_path)
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| {
                matches!(
                    name.to_ascii_lowercase().as_str(),
                    "latest.log" | "player.log"
                )
            })
            .unwrap_or(false);
        let custom_start = custom_time_start
            .and_then(|value| Self::parse_log_timestamp_local(value, reference_dt, false));
        let custom_end = custom_time_end
            .and_then(|value| Self::parse_log_timestamp_local(value, reference_dt, false));

        let filtered_lines = log_lines
            .iter()
            .filter(|line| {
                // Filter by level
                if let Some(level) = filter_level {
                    if let Some(line_level) = &line.level {
                        if !line_level.eq_ignore_ascii_case(level) {
                            return false;
                        }
                    } else {
                        return false;
                    }
                }

                if let Some(ref category) = normalized_filter_category {
                    let category_matches = match category.as_str() {
                        "melonloader" => matches!(line.category, LogCategory::MelonLoader),
                        "mod" => matches!(line.category, LogCategory::Mod),
                        "general" => matches!(line.category, LogCategory::General),
                        _ => true,
                    };

                    if !category_matches {
                        return false;
                    }
                }

                // Filter by mod tag (normalized comparison)
                if let Some(ref filter_tag_normalized) = normalized_filter_tag {
                    if let Some(ref line_tag) = line.mod_tag {
                        if normalize_mod_tag(line_tag) != *filter_tag_normalized {
                            return false;
                        }
                    } else {
                        return false;
                    }
                }

                // Filter by search query
                if let Some(query) = search_query {
                    if !query.is_empty()
                        && !line.content.to_lowercase().contains(&query.to_lowercase())
                    {
                        return false;
                    }
                }

                if let Some(period) = time_period {
                    if !period.eq_ignore_ascii_case("all") {
                        if let Some(timestamp) = line.timestamp.as_deref() {
                            if let Some(log_time) = Self::parse_log_timestamp_local(
                                timestamp,
                                reference_dt,
                                live_rollover,
                            ) {
                                let matches_period = match period {
                                    "last5min" => {
                                        log_time >= reference_dt - ChronoDuration::minutes(5)
                                    }
                                    "last15min" => {
                                        log_time >= reference_dt - ChronoDuration::minutes(15)
                                    }
                                    "last1hour" => {
                                        log_time >= reference_dt - ChronoDuration::hours(1)
                                    }
                                    "custom" => {
                                        if custom_start.is_none() && custom_end.is_none() {
                                            true
                                        } else {
                                            if let Some(start) = custom_start.as_ref() {
                                                if log_time < start.clone() {
                                                    return false;
                                                }
                                            }
                                            if let Some(end) = custom_end.as_ref() {
                                                if log_time > end.clone() {
                                                    return false;
                                                }
                                            }
                                            true
                                        }
                                    }
                                    _ => true,
                                };

                                if !matches_period {
                                    return false;
                                }
                            } else {
                                return false;
                            }
                        } else {
                            return false;
                        }
                    }
                }

                true
            })
            .map(|line| {
                // Reconstruct the full log line with timestamp and mod tag
                let mut full_line = String::new();

                // Add timestamp if present
                if let Some(ref timestamp) = line.timestamp {
                    full_line.push_str(&format!("[{}] ", timestamp));
                }

                // Add mod tag if present
                if let Some(ref mod_tag) = line.mod_tag {
                    full_line.push_str(&format!("[{}] ", mod_tag));
                }

                // Add level if present
                if let Some(ref level) = line.level {
                    full_line.push_str(&format!("[{}] ", level));
                }

                // Add content
                full_line.push_str(&line.content);

                full_line
            })
            .collect::<Vec<_>>();

        // Add header with filter/search info
        let mut output = String::new();
        output.push_str(&format!("MelonLoader Log Export\n"));
        output.push_str(&format!("Source: {}\n", log_path));
        output.push_str(&format!("Exported: {}\n", Utc::now().to_rfc3339()));
        if let Some(level) = filter_level {
            output.push_str(&format!("Filter Level: {}\n", level));
        }
        if let Some(mod_tag) = filter_mod_tag {
            output.push_str(&format!("Filter Mod: {}\n", mod_tag));
        }
        if let Some(query) = search_query {
            output.push_str(&format!("Search Query: {}\n", query));
        }
        output.push_str(&format!("Total Lines: {}\n", filtered_lines.len()));
        output.push_str(&format!("{}\n", "=".repeat(80)));
        output.push_str("\n");

        output.push_str(&filtered_lines.join("\n"));

        fs::write(output_path, output)
            .await
            .context("Failed to write export file")?;

        Ok(())
    }

    pub async fn watch_log_file(&self, log_path: &str, app_handle: AppHandle) -> Result<()> {
        let path = Path::new(log_path).to_path_buf();

        if !path.exists() {
            return Err(anyhow::anyhow!("Log file does not exist: {}", log_path));
        }

        // Set watching flag
        *self.watching.write().await = true;
        let current_session = {
            let mut session = self.watch_session_id.write().await;
            *session += 1;
            *session
        };

        // Get initial file size and line count
        let metadata = fs::metadata(&path).await?;
        *self.last_position.write().await = metadata.len();
        let initial_bytes = fs::read(&path).await.unwrap_or_default();
        let initial_content = Self::decode_log_content(&initial_bytes);
        *self.last_line_count.write().await = initial_content.lines().count();

        let watching = Arc::clone(&self.watching);
        let last_position = Arc::clone(&self.last_position);
        let last_line_count = Arc::clone(&self.last_line_count);
        let watch_session_id = Arc::clone(&self.watch_session_id);

        // Watch loop
        while *watching.read().await && *watch_session_id.read().await == current_session {
            sleep(Duration::from_millis(500)).await;

            let metadata = match fs::metadata(&path).await {
                Ok(m) => m,
                Err(_) => continue,
            };

            let current_size = metadata.len();
            let last_pos = *last_position.read().await;

            // Check if file has new content
            if current_size > last_pos {
                if let Ok(file_bytes) = fs::read(&path).await {
                    let file_content = Self::decode_log_content(&file_bytes);
                    let lines: Vec<&str> = file_content.lines().collect();
                    let previous_line_count = *last_line_count.read().await;
                    let new_lines: Vec<_> = lines.iter().skip(previous_line_count).collect();

                    if !new_lines.is_empty() {
                        let mut log_lines = Vec::new();
                        for (idx, line) in new_lines.iter().enumerate() {
                            let line_number = previous_line_count + idx + 1;
                            let raw_content = line.to_string();

                            let timestamp = Self::extract_melonloader_timestamp(&raw_content);
                            let mod_tag = Self::extract_mod_tag(&raw_content);
                            let level = Self::extract_log_level(&raw_content);
                            let category = Self::categorize_log(&raw_content, &mod_tag);

                            // Strip timestamp and mod tag from content
                            let content =
                                Self::strip_timestamp_and_tag(&raw_content, &timestamp, &mod_tag);

                            log_lines.push(LogLine {
                                line_number,
                                content,
                                level,
                                timestamp,
                                mod_tag,
                                category,
                            });
                        }

                        // Emit event with new log lines
                        let _ = app_handle.emit(
                            "log-update",
                            serde_json::json!({
                                "lines": log_lines,
                            }),
                        );
                    }

                    *last_line_count.write().await = lines.len();
                }

                *last_position.write().await = current_size;
            } else if current_size < last_pos {
                // File was truncated or replaced, reset position and line counter
                *last_position.write().await = 0;
                *last_line_count.write().await = 0;
            }
        }

        Ok(())
    }
    pub async fn stop_watching(&self) {
        *self.watching.write().await = false;
        *self.last_position.write().await = 0;
        *self.last_line_count.write().await = 0;
        let mut session = self.watch_session_id.write().await;
        *session += 1;
    }
}

impl Default for LogsService {
    fn default() -> Self {
        Self::new()
    }
}
