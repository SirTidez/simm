use anyhow::{Context, Result};
use chrono::{DateTime, Duration as ChronoDuration, Local, NaiveTime, TimeZone, Utc};
use regex::Regex;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};

use crate::services::logger::LoggerService;

const LOG_READ_CHUNK_SIZE: usize = 64 * 1024;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LogEncoding {
    Utf8,
    Utf16Le,
    Utf16Be,
}

#[derive(Debug, Clone)]
struct LogModCandidate {
    display_name: String,
    normalized_name: String,
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
        let sanitized_path = LoggerService::sanitize_log_text(log_path);

        if !path.exists() {
            log::warn!("Requested log file does not exist: {}", sanitized_path);
            return Err(anyhow::anyhow!("Log file does not exist: {}", log_path));
        }

        let (content, start_line) = Self::read_log_content(path, max_lines).await?;
        let mod_candidates = Self::load_mod_candidates_for_log(path).await;

        Ok(Self::parse_log_lines(&content, start_line, &mod_candidates))
    }

    async fn read_log_content(path: &Path, max_lines: Option<usize>) -> Result<(String, usize)> {
        match max_lines {
            Some(0) => Ok((String::new(), 0)),
            Some(max) => Self::read_log_tail_content(path, max).await,
            None => {
                let file_bytes = fs::read(path).await.context("Failed to read log file")?;
                Ok((Self::decode_log_content(&file_bytes), 0))
            }
        }
    }

    async fn read_log_tail_content(path: &Path, max_lines: usize) -> Result<(String, usize)> {
        let mut file = fs::File::open(path)
            .await
            .context("Failed to open log file")?;
        let file_size = file
            .metadata()
            .await
            .context("Failed to inspect log file")?
            .len();

        if file_size == 0 {
            return Ok((String::new(), 0));
        }

        let (encoding, data_start) = Self::detect_log_encoding(&mut file).await?;
        let (start_offset, start_line) = if encoding == LogEncoding::Utf8 {
            let start_offset =
                Self::find_utf8_tail_start_offset(&mut file, file_size, data_start, max_lines)
                    .await?;
            let start_line =
                Self::count_line_feeds(&mut file, start_offset, data_start, encoding).await?;
            (start_offset, start_line)
        } else {
            let line_count = Self::count_lines(&mut file, file_size, data_start, encoding).await?;
            let start_line = line_count.saturating_sub(max_lines);
            let start_offset = Self::find_line_start_offset(
                &mut file, file_size, data_start, encoding, start_line,
            )
            .await?;
            (start_offset, start_line)
        };

        file.seek(SeekFrom::Start(start_offset))
            .await
            .context("Failed to seek log file")?;
        let mut bytes = Vec::with_capacity(file_size.saturating_sub(start_offset) as usize);
        file.read_to_end(&mut bytes)
            .await
            .context("Failed to read log file tail")?;

        Ok((
            Self::decode_log_content_with_encoding(&bytes, encoding),
            start_line,
        ))
    }

    async fn detect_log_encoding(file: &mut fs::File) -> Result<(LogEncoding, u64)> {
        file.seek(SeekFrom::Start(0))
            .await
            .context("Failed to seek log file")?;

        let mut bom = [0u8; 2];
        let bytes_read = file
            .read(&mut bom)
            .await
            .context("Failed to read log file encoding")?;

        if bytes_read >= 2 && bom == [0xFF, 0xFE] {
            return Ok((LogEncoding::Utf16Le, 2));
        }
        if bytes_read >= 2 && bom == [0xFE, 0xFF] {
            return Ok((LogEncoding::Utf16Be, 2));
        }

        Ok((LogEncoding::Utf8, 0))
    }

    async fn count_lines(
        file: &mut fs::File,
        file_size: u64,
        data_start: u64,
        encoding: LogEncoding,
    ) -> Result<usize> {
        if file_size <= data_start {
            return Ok(0);
        }

        let newline_count = Self::count_line_feeds(file, file_size, data_start, encoding).await?;
        let ends_with_newline =
            Self::ends_with_newline(file, file_size, data_start, encoding).await?;

        Ok(if ends_with_newline {
            newline_count
        } else {
            newline_count + 1
        })
    }

    async fn count_line_feeds(
        file: &mut fs::File,
        file_size: u64,
        data_start: u64,
        encoding: LogEncoding,
    ) -> Result<usize> {
        let mut count = 0usize;
        let mut offset = data_start;
        let mut carry: Option<u8> = None;
        let mut buffer = vec![0u8; LOG_READ_CHUNK_SIZE];

        while offset < file_size {
            let chunk_len = (file_size - offset).min(LOG_READ_CHUNK_SIZE as u64) as usize;
            file.seek(SeekFrom::Start(offset))
                .await
                .context("Failed to seek log file")?;
            let read_len = file
                .read(&mut buffer[..chunk_len])
                .await
                .context("Failed to read log file")?;
            if read_len == 0 {
                break;
            }

            count += Self::count_newlines_in_chunk(&buffer[..read_len], encoding, &mut carry);
            offset += read_len as u64;
        }

        Ok(count)
    }

    async fn find_utf8_tail_start_offset(
        file: &mut fs::File,
        file_size: u64,
        data_start: u64,
        max_lines: usize,
    ) -> Result<u64> {
        let ends_with_newline =
            Self::ends_with_newline(file, file_size, data_start, LogEncoding::Utf8).await?;
        let target_line_feeds = if ends_with_newline {
            max_lines.saturating_add(1)
        } else {
            max_lines
        };

        let mut seen_line_feeds = 0usize;
        let mut chunk_end = file_size;
        let mut buffer = vec![0u8; LOG_READ_CHUNK_SIZE];

        while chunk_end > data_start {
            let chunk_start = chunk_end
                .saturating_sub(LOG_READ_CHUNK_SIZE as u64)
                .max(data_start);
            let chunk_len = (chunk_end - chunk_start) as usize;

            file.seek(SeekFrom::Start(chunk_start))
                .await
                .context("Failed to seek log file")?;
            file.read_exact(&mut buffer[..chunk_len])
                .await
                .context("Failed to read log file")?;

            for index in (0..chunk_len).rev() {
                if buffer[index] == b'\n' {
                    seen_line_feeds += 1;
                    if seen_line_feeds == target_line_feeds {
                        return Ok(chunk_start + index as u64 + 1);
                    }
                }
            }

            chunk_end = chunk_start;
        }

        Ok(data_start)
    }

    async fn find_line_start_offset(
        file: &mut fs::File,
        file_size: u64,
        data_start: u64,
        encoding: LogEncoding,
        start_line: usize,
    ) -> Result<u64> {
        if start_line == 0 {
            return Ok(data_start);
        }

        let mut seen_line_feeds = 0usize;
        let mut offset = data_start;
        let mut carry: Option<u8> = None;
        let mut buffer = vec![0u8; LOG_READ_CHUNK_SIZE];

        while offset < file_size {
            let chunk_len = (file_size - offset).min(LOG_READ_CHUNK_SIZE as u64) as usize;
            file.seek(SeekFrom::Start(offset))
                .await
                .context("Failed to seek log file")?;
            let read_len = file
                .read(&mut buffer[..chunk_len])
                .await
                .context("Failed to read log file")?;
            if read_len == 0 {
                break;
            }

            let (chunk_line_feeds, line_start_offset) = Self::scan_newlines_in_chunk(
                &buffer[..read_len],
                encoding,
                &mut carry,
                start_line - seen_line_feeds,
            );
            if let Some(relative_offset) = line_start_offset {
                return Ok(offset + relative_offset as u64);
            }

            seen_line_feeds += chunk_line_feeds;
            offset += read_len as u64;
        }

        Ok(file_size)
    }

    fn count_newlines_in_chunk(
        chunk: &[u8],
        encoding: LogEncoding,
        carry: &mut Option<u8>,
    ) -> usize {
        Self::scan_newlines_in_chunk(chunk, encoding, carry, usize::MAX).0
    }

    fn scan_newlines_in_chunk(
        chunk: &[u8],
        encoding: LogEncoding,
        carry: &mut Option<u8>,
        target_count: usize,
    ) -> (usize, Option<usize>) {
        if encoding == LogEncoding::Utf8 {
            let mut count = 0usize;
            for (index, byte) in chunk.iter().enumerate() {
                if *byte == b'\n' {
                    count += 1;
                    if count == target_count {
                        return (count, Some(index + 1));
                    }
                }
            }
            return (count, None);
        }

        let mut count = 0usize;
        let mut index = 0usize;
        while index < chunk.len() {
            let first = if let Some(previous) = carry.take() {
                previous
            } else {
                let byte = chunk[index];
                index += 1;
                byte
            };

            if index >= chunk.len() {
                *carry = Some(first);
                break;
            }

            let second = chunk[index];
            index += 1;
            let is_newline = match encoding {
                LogEncoding::Utf16Le => first == 0x0A && second == 0x00,
                LogEncoding::Utf16Be => first == 0x00 && second == 0x0A,
                LogEncoding::Utf8 => false,
            };

            if is_newline {
                count += 1;
                if count == target_count {
                    return (count, Some(index));
                }
            }
        }

        (count, None)
    }

    async fn ends_with_newline(
        file: &mut fs::File,
        file_size: u64,
        data_start: u64,
        encoding: LogEncoding,
    ) -> Result<bool> {
        if file_size <= data_start {
            return Ok(false);
        }

        match encoding {
            LogEncoding::Utf8 => {
                file.seek(SeekFrom::Start(file_size - 1))
                    .await
                    .context("Failed to seek log file")?;
                let mut byte = [0u8; 1];
                file.read_exact(&mut byte)
                    .await
                    .context("Failed to read log file ending")?;
                Ok(byte[0] == b'\n')
            }
            LogEncoding::Utf16Le | LogEncoding::Utf16Be => {
                if file_size.saturating_sub(data_start) < 2 {
                    return Ok(false);
                }

                file.seek(SeekFrom::Start(file_size - 2))
                    .await
                    .context("Failed to seek log file")?;
                let mut bytes = [0u8; 2];
                file.read_exact(&mut bytes)
                    .await
                    .context("Failed to read log file ending")?;

                Ok(match encoding {
                    LogEncoding::Utf16Le => bytes == [0x0A, 0x00],
                    LogEncoding::Utf16Be => bytes == [0x00, 0x0A],
                    LogEncoding::Utf8 => false,
                })
            }
        }
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

    fn decode_log_content_with_encoding(bytes: &[u8], encoding: LogEncoding) -> String {
        match encoding {
            LogEncoding::Utf8 => Self::decode_log_content(bytes),
            LogEncoding::Utf16Le => {
                let utf16: Vec<u16> = bytes
                    .chunks_exact(2)
                    .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                    .collect();
                String::from_utf16_lossy(&utf16)
            }
            LogEncoding::Utf16Be => {
                let utf16: Vec<u16> = bytes
                    .chunks_exact(2)
                    .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
                    .collect();
                String::from_utf16_lossy(&utf16)
            }
        }
    }

    fn split_complete_log_bytes(bytes: &[u8], encoding: LogEncoding) -> (Vec<u8>, Vec<u8>) {
        let newline_end = match encoding {
            LogEncoding::Utf8 => bytes
                .iter()
                .rposition(|byte| *byte == b'\n')
                .map(|index| index + 1),
            LogEncoding::Utf16Le | LogEncoding::Utf16Be => bytes
                .chunks_exact(2)
                .enumerate()
                .filter_map(|(index, chunk)| {
                    let is_newline = match encoding {
                        LogEncoding::Utf16Le => chunk == [0x0A, 0x00],
                        LogEncoding::Utf16Be => chunk == [0x00, 0x0A],
                        LogEncoding::Utf8 => false,
                    };
                    is_newline.then_some((index + 1) * 2)
                })
                .last(),
        };

        match newline_end {
            Some(split_at) => (bytes[..split_at].to_vec(), bytes[split_at..].to_vec()),
            None => (Vec::new(), bytes.to_vec()),
        }
    }

    fn parse_log_lines(
        content: &str,
        start_line: usize,
        mod_candidates: &[LogModCandidate],
    ) -> Vec<LogLine> {
        let mut log_lines = Vec::new();
        let mut current_line: Option<LogLine> = None;

        for (idx, line) in content.lines().enumerate() {
            let line_number = start_line + idx + 1;
            let raw_content = line.to_string();

            if Self::starts_log_entry(&raw_content) || current_line.is_none() {
                if let Some(line) = current_line.take() {
                    log_lines.push(line);
                }
                current_line = Some(Self::parse_single_log_line(
                    &raw_content,
                    line_number,
                    mod_candidates,
                ));
                continue;
            }

            if let Some(line) = current_line.as_mut() {
                if !line.content.is_empty() {
                    line.content.push('\n');
                }
                line.content.push_str(&raw_content);
                line.level = Self::stronger_log_level(
                    line.level.take(),
                    Self::infer_log_level(&raw_content),
                );
                if line.mod_tag.is_none() {
                    line.mod_tag = Self::infer_installed_mod_tag(&raw_content, mod_candidates);
                }
            }
        }

        if let Some(line) = current_line {
            log_lines.push(line);
        }

        log_lines
    }

    fn parse_single_log_line(
        raw_content: &str,
        line_number: usize,
        mod_candidates: &[LogModCandidate],
    ) -> LogLine {
        let timestamp = Self::extract_melonloader_timestamp(raw_content);
        let mod_tag = Self::extract_mod_tag(raw_content)
            .or_else(|| Self::infer_installed_mod_tag(raw_content, mod_candidates));
        let explicit_level = Self::extract_explicit_log_level(raw_content);
        let level = Self::stronger_log_level(explicit_level, Self::infer_log_level(raw_content));
        let category = Self::categorize_log(raw_content, &mod_tag);
        let content = Self::strip_timestamp_and_tag(raw_content, &timestamp, &mod_tag);

        LogLine {
            line_number,
            content,
            level,
            timestamp,
            mod_tag,
            category,
        }
    }

    fn starts_log_entry(line: &str) -> bool {
        Self::extract_melonloader_timestamp(line).is_some()
    }

    fn log_level_rank(level: &str) -> u8 {
        match level.to_ascii_uppercase().as_str() {
            "FATAL" | "ERROR" => 4,
            "WARN" | "WARNING" => 3,
            "INFO" => 2,
            "DEBUG" => 1,
            "TRACE" => 0,
            _ => 2,
        }
    }

    fn stronger_log_level(left: Option<String>, right: Option<String>) -> Option<String> {
        match (left, right) {
            (Some(left), Some(right)) => {
                if Self::log_level_rank(&right) > Self::log_level_rank(&left) {
                    Some(right)
                } else {
                    Some(left)
                }
            }
            (Some(level), None) | (None, Some(level)) => Some(level),
            (None, None) => None,
        }
    }

    fn infer_log_level(line: &str) -> Option<String> {
        let lower = line.to_ascii_lowercase();

        let warning_markers = [
            "unsupported return type",
            "unsupported parameter",
            "signatures have been exhausted",
            "using a substitute",
            "using normal patch handlers",
            "will retry",
            "might run before",
            "warning",
        ];

        if warning_markers.iter().any(|marker| lower.contains(marker)) {
            return Some("WARN".to_string());
        }

        let error_markers = [
            "exception",
            "failed to load",
            "failed",
            "fatal",
            "error",
            "could not load",
            "failure has occurred",
            "unable to load",
            "stack trace",
        ];

        if error_markers.iter().any(|marker| lower.contains(marker)) {
            return Some("ERROR".to_string());
        }

        None
    }

    fn extract_explicit_log_level(line: &str) -> Option<String> {
        let Ok(re) = Regex::new(r"\[([A-Za-z]+)\]") else {
            return None;
        };

        for captures in re.captures_iter(line) {
            let Some(level) = captures.get(1).map(|m| m.as_str().to_ascii_uppercase()) else {
                continue;
            };

            if [
                "INFO", "WARN", "WARNING", "ERROR", "DEBUG", "FATAL", "TRACE",
            ]
            .contains(&level.as_str())
            {
                return Some(if level == "WARNING" {
                    "WARN".to_string()
                } else {
                    level
                });
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
                    let melonloader_system_tags = [
                        "Il2CppAssemblyGenerator",
                        "Il2CppInterop",
                        "StoragePatches",
                        "UnityExceptionTrace",
                    ];

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

    fn infer_installed_mod_tag(line: &str, mod_candidates: &[LogModCandidate]) -> Option<String> {
        let normalized_line = Self::normalize_mod_candidate_text(line);
        if normalized_line.is_empty() {
            return None;
        }

        mod_candidates
            .iter()
            .find(|candidate| normalized_line.contains(&candidate.normalized_name))
            .map(|candidate| candidate.display_name.clone())
    }

    fn normalize_mod_candidate_text(value: &str) -> String {
        value
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric())
            .map(|ch| ch.to_ascii_lowercase())
            .collect()
    }

    fn should_skip_mod_candidate(name: &str) -> bool {
        let normalized = Self::normalize_mod_candidate_text(name);

        if normalized.len() < 3 {
            return true;
        }

        matches!(
            normalized.as_str(),
            "0harmony"
                | "assemblycsharp"
                | "il2cppinterop"
                | "melonloader"
                | "mscorlib"
                | "s1api"
                | "unityengine"
                | "unityenginecoremodule"
        )
    }

    fn infer_game_dir_from_log_path(log_path: &Path) -> Option<PathBuf> {
        let file_name = log_path.file_name()?.to_str()?;
        if !file_name.eq_ignore_ascii_case("latest.log") && !file_name.ends_with(".log") {
            return None;
        }

        let parent = log_path.parent()?;
        let parent_name = parent.file_name()?.to_str()?;

        if parent_name.eq_ignore_ascii_case("melonloader") {
            return parent.parent().map(Path::to_path_buf);
        }

        if parent_name.eq_ignore_ascii_case("logs") {
            let melonloader_dir = parent.parent()?;
            let melonloader_name = melonloader_dir.file_name()?.to_str()?;
            if melonloader_name.eq_ignore_ascii_case("melonloader") {
                return melonloader_dir.parent().map(Path::to_path_buf);
            }
        }

        None
    }

    async fn load_mod_candidates_for_log(log_path: &Path) -> Vec<LogModCandidate> {
        let Some(game_dir) = Self::infer_game_dir_from_log_path(log_path) else {
            return Vec::new();
        };

        let mut candidates = Vec::new();
        for folder_name in ["Mods", "mods", "Plugins", "plugins"] {
            Self::collect_mod_candidates_from_dir(game_dir.join(folder_name), &mut candidates)
                .await;
        }

        candidates.sort_by(|left, right| {
            right
                .normalized_name
                .len()
                .cmp(&left.normalized_name.len())
                .then_with(|| left.display_name.cmp(&right.display_name))
        });
        candidates.dedup_by(|left, right| left.normalized_name == right.normalized_name);
        candidates
    }

    async fn collect_mod_candidates_from_dir(root: PathBuf, candidates: &mut Vec<LogModCandidate>) {
        if !root.exists() {
            return;
        }

        let mut pending_dirs = vec![root];
        while let Some(dir) = pending_dirs.pop() {
            let Ok(mut entries) = fs::read_dir(&dir).await else {
                continue;
            };

            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();
                let Ok(file_type) = entry.file_type().await else {
                    continue;
                };

                if file_type.is_dir() {
                    pending_dirs.push(path);
                    continue;
                }

                let Some(raw_name) = Self::dll_mod_candidate_name(&path) else {
                    continue;
                };

                candidates.extend(Self::build_mod_candidates_from_dll_name(&raw_name));
            }
        }
    }

    fn build_mod_candidates_from_dll_name(raw_name: &str) -> Vec<LogModCandidate> {
        let display_name = Self::strip_runtime_suffix_from_mod_name(raw_name);
        let mut names = vec![display_name.as_str()];

        if display_name != raw_name {
            names.push(raw_name);
        }

        names
            .into_iter()
            .filter(|name| !Self::should_skip_mod_candidate(name))
            .map(|name| LogModCandidate {
                display_name: display_name.clone(),
                normalized_name: Self::normalize_mod_candidate_text(name),
            })
            .filter(|candidate| !candidate.normalized_name.is_empty())
            .collect()
    }

    fn strip_runtime_suffix_from_mod_name(name: &str) -> String {
        let mut trimmed = name.trim().to_string();

        loop {
            let lower = trimmed.to_ascii_lowercase();
            let suffixes = [
                ".melonloader",
                ".il2cpp",
                "-il2cpp",
                "_il2cpp",
                "il2cpp",
                ".mono",
                "-mono",
                "_mono",
            ];

            let Some(suffix) = suffixes.iter().find(|suffix| lower.ends_with(**suffix)) else {
                break;
            };

            let next_len = trimmed.len().saturating_sub(suffix.len());
            trimmed.truncate(next_len);
            trimmed = trimmed
                .trim_end_matches(['.', '-', '_', ' '])
                .trim()
                .to_string();

            if trimmed.is_empty() {
                return name.trim().to_string();
            }
        }

        trimmed
    }

    fn dll_mod_candidate_name(path: &Path) -> Option<String> {
        let file_name = path.file_name()?.to_str()?;
        let lower_name = file_name.to_ascii_lowercase();

        let base_name = if lower_name.ends_with(".dll.disabled") {
            &file_name[..file_name.len().saturating_sub(".dll.disabled".len())]
        } else if lower_name.ends_with(".dll") {
            &file_name[..file_name.len().saturating_sub(".dll".len())]
        } else {
            return None;
        };

        let trimmed = base_name.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
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
            "UnityExceptionTrace",
        ];

        if melonloader_tags
            .iter()
            .any(|tag| line.contains(&format!("[{}]", tag)))
        {
            return LogCategory::MelonLoader;
        }

        if let Some(tag) = mod_tag {
            if melonloader_tags.iter().any(|&ml_tag| tag.contains(ml_tag)) {
                return LogCategory::MelonLoader;
            }
            return LogCategory::Mod;
        }

        // Check if line contains MelonLoader-specific text
        if line.contains("MelonLoader")
            || line.contains("Unity")
            || line.contains("IL2CPP")
            || line.contains("Il2Cpp")
            || line.contains("Il2CppInterop")
            || line.contains("Il2CppAssemblyGenerator")
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
        let sanitized_path = LoggerService::sanitize_log_text(log_path);

        if !path.exists() {
            log::warn!("Cannot watch missing log file: {}", sanitized_path);
            return Err(anyhow::anyhow!("Log file does not exist: {}", log_path));
        }

        // Set watching flag
        *self.watching.write().await = true;
        let current_session = {
            let mut session = self.watch_session_id.write().await;
            *session += 1;
            *session
        };

        let mut watched_file = fs::File::open(&path).await?;
        let metadata = watched_file.metadata().await?;
        let (mut encoding, mut data_start) = Self::detect_log_encoding(&mut watched_file).await?;
        let mod_candidates = Self::load_mod_candidates_for_log(&path).await;
        *self.last_position.write().await = metadata.len();
        *self.last_line_count.write().await =
            Self::count_lines(&mut watched_file, metadata.len(), data_start, encoding).await?;

        let watching = Arc::clone(&self.watching);
        let last_position = Arc::clone(&self.last_position);
        let last_line_count = Arc::clone(&self.last_line_count);
        let watch_session_id = Arc::clone(&self.watch_session_id);
        let mut pending_bytes = Vec::new();

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
                if let Ok(mut file) = fs::File::open(&path).await {
                    let read_start = if last_pos == 0 { data_start } else { last_pos };
                    let mut file_bytes =
                        Vec::with_capacity(current_size.saturating_sub(read_start) as usize);

                    if file.seek(SeekFrom::Start(read_start)).await.is_ok()
                        && file.read_to_end(&mut file_bytes).await.is_ok()
                    {
                        if !pending_bytes.is_empty() {
                            let mut combined =
                                Vec::with_capacity(pending_bytes.len() + file_bytes.len());
                            combined.extend_from_slice(&pending_bytes);
                            combined.extend_from_slice(&file_bytes);
                            file_bytes = combined;
                        }

                        let (complete_bytes, next_pending_bytes) =
                            Self::split_complete_log_bytes(&file_bytes, encoding);
                        pending_bytes = next_pending_bytes;

                        if complete_bytes.is_empty() {
                            *last_position.write().await = current_size;
                            continue;
                        }

                        let file_content =
                            Self::decode_log_content_with_encoding(&complete_bytes, encoding);
                        let lines: Vec<&str> = file_content.lines().collect();
                        let previous_line_count = *last_line_count.read().await;

                        if !lines.is_empty() {
                            let log_lines = Self::parse_log_lines(
                                &file_content,
                                previous_line_count,
                                &mod_candidates,
                            );

                            // Emit event with new log lines
                            let _ = app_handle.emit(
                                "log-update",
                                serde_json::json!({
                                    "lines": log_lines,
                                }),
                            );
                        }

                        *last_line_count.write().await = previous_line_count + lines.len();
                        *last_position.write().await = current_size;
                    }
                }
            } else if current_size < last_pos {
                // File was truncated or replaced; re-detect BOM/encoding before reading new bytes.
                pending_bytes.clear();
                if let Ok(mut refreshed_file) = fs::File::open(&path).await {
                    if let Ok((next_encoding, next_data_start)) =
                        Self::detect_log_encoding(&mut refreshed_file).await
                    {
                        encoding = next_encoding;
                        data_start = next_data_start;
                        *last_position.write().await = data_start;
                        *last_line_count.write().await = Self::count_lines(
                            &mut refreshed_file,
                            data_start,
                            data_start,
                            encoding,
                        )
                        .await
                        .unwrap_or(0);
                    } else {
                        *last_position.write().await = 0;
                        *last_line_count.write().await = 0;
                    }
                } else {
                    *last_position.write().await = 0;
                    *last_line_count.write().await = 0;
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn read_log_file_limits_to_tail_with_original_line_numbers() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let log_path = temp_dir.path().join("Latest.log");
        let content = (1..=8)
            .map(|line| format!("[12:00:0{line}.000] [Mod{line}] line {line}"))
            .collect::<Vec<_>>()
            .join("\n");

        fs::write(&log_path, content).await.expect("write log file");

        let service = LogsService::new();
        let lines = service
            .read_log_file(log_path.to_str().expect("utf8 path"), Some(3))
            .await
            .expect("read log file");

        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].line_number, 6);
        assert_eq!(lines[0].content, "line 6");
        assert_eq!(lines[0].timestamp.as_deref(), Some("12:00:06.000"));
        assert_eq!(lines[0].mod_tag.as_deref(), Some("Mod6"));
        assert_eq!(lines[2].line_number, 8);
        assert_eq!(lines[2].content, "line 8");
    }

    #[tokio::test]
    async fn read_log_file_tails_utf16_le_logs() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let log_path = temp_dir.path().join("Latest.log");
        let content = "[12:00:01.000] first\n[12:00:02.000] second\n[12:00:03.000] third";
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend(content.encode_utf16().flat_map(u16::to_le_bytes));

        fs::write(&log_path, bytes)
            .await
            .expect("write utf16 log file");

        let service = LogsService::new();
        let lines = service
            .read_log_file(log_path.to_str().expect("utf8 path"), Some(2))
            .await
            .expect("read log file");

        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].line_number, 2);
        assert_eq!(lines[0].timestamp.as_deref(), Some("12:00:02.000"));
        assert_eq!(lines[0].content, "second");
        assert_eq!(lines[1].line_number, 3);
        assert_eq!(lines[1].content, "third");
    }

    #[tokio::test]
    async fn read_log_file_combines_il2cpp_exception_stack_trace() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let log_path = temp_dir.path().join("Latest.log");
        let content = [
            "[23:50:29.919] [SidewalkEconomy] Build preview placement failed: System.Reflection.TargetInvocationException: Exception has been thrown by the target of an invocation.",
            " ---> Il2CppInterop.Runtime.Il2CppException: System.ArgumentOutOfRangeException: Index was out of range.",
            "--- BEGIN IL2CPP STACK TRACE ---",
            "System.ArgumentOutOfRangeException: Index was out of range.",
            "  at ScheduleOne.Building.BuildUpdate_Grid.Place () [0x00000] in <00000000000000000000000000000000>:0 ",
            "--- END IL2CPP STACK TRACE ---",
            "[23:50:29.923] [SidewalkEconomy] BuildManager.StopBuilding did not fully clear build mode (preview placement exception); escalating to forced reset",
        ]
        .join("\n");

        fs::write(&log_path, content).await.expect("write log file");

        let service = LogsService::new();
        let lines = service
            .read_log_file(log_path.to_str().expect("utf8 path"), None)
            .await
            .expect("read log file");

        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].line_number, 1);
        assert_eq!(lines[0].level.as_deref(), Some("ERROR"));
        assert_eq!(lines[0].mod_tag.as_deref(), Some("SidewalkEconomy"));
        assert!(lines[0].content.contains("Il2CppException"));
        assert!(lines[0]
            .content
            .contains("ScheduleOne.Building.BuildUpdate_Grid.Place"));
        assert_eq!(lines[1].line_number, 7);
        assert_eq!(lines[1].level.as_deref(), Some("ERROR"));
    }

    #[tokio::test]
    async fn read_log_file_marks_il2cpp_warnings_and_system_category() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let log_path = temp_dir.path().join("Latest.log");
        let content = [
            "[23:49:03.471] [Il2CppInterop] Failed to init IL2CPP patch backend for void UnityEngine.WaitForSeconds::.ctor(float seconds), using normal patch handlers: Derived classes must provide an implementation.",
            "[06:29:12.276] [Il2CppInterop] Method PackRat.Config.BackpackTierDefinition get_CurrentTier() on type PackRat.PlayerBackpack has unsupported return type PackRat.Config.BackpackTierDefinition",
            "[01:06:34.484] [Il2CppInterop] Exception in IL2CPP-to-Managed trampoline, not passing it to il2cpp: System.MissingMethodException: Method not found: 'Il2CppScheduleOne.ItemFramework.EItemCategory Il2CppScheduleOne.ItemFramework.ItemInstance.get_Category()'.",
            "   at AdvancedDealing.Economy.DealerExtension.GetAllProducts(Int32& totalAmount)",
            "   at AdvancedDealing.Economy.DealerExtension.OnTick()",
        ]
        .join("\n");

        fs::write(&log_path, content).await.expect("write log file");

        let service = LogsService::new();
        let lines = service
            .read_log_file(log_path.to_str().expect("utf8 path"), None)
            .await
            .expect("read log file");

        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].level.as_deref(), Some("WARN"));
        assert!(matches!(lines[0].category, LogCategory::MelonLoader));
        assert_eq!(lines[1].level.as_deref(), Some("WARN"));
        assert!(matches!(lines[1].category, LogCategory::MelonLoader));
        assert_eq!(lines[2].level.as_deref(), Some("ERROR"));
        assert!(matches!(lines[2].category, LogCategory::MelonLoader));
        assert!(lines[2].content.contains("DealerExtension.GetAllProducts"));
        assert!(lines[2].content.contains("DealerExtension.OnTick"));
    }

    #[tokio::test]
    async fn read_log_file_links_generic_il2cpp_entries_to_installed_mods() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let game_dir = temp_dir.path().join("Schedule I");
        let mods_dir = game_dir.join("mods");
        let plugins_dir = game_dir.join("Plugins");
        let melonloader_dir = game_dir.join("MelonLoader");
        let log_path = melonloader_dir.join("Latest.log");

        fs::create_dir_all(&mods_dir)
            .await
            .expect("create lowercase mods dir");
        fs::create_dir_all(&plugins_dir)
            .await
            .expect("create plugins dir");
        fs::create_dir_all(&melonloader_dir)
            .await
            .expect("create melonloader dir");
        fs::write(mods_dir.join("PackRat-IL2CPP.dll"), b"")
            .await
            .expect("write PackRat dll");
        fs::write(plugins_dir.join("AdvancedDealing.Il2Cpp.dll.disabled"), b"")
            .await
            .expect("write disabled AdvancedDealing dll");

        let content = [
            "[06:29:12.276] [Il2CppInterop] Method PackRat.Config.BackpackTierDefinition get_CurrentTier() on type PackRat.PlayerBackpack has unsupported return type PackRat.Config.BackpackTierDefinition",
            "[01:06:34.484] [Il2CppInterop] Exception in IL2CPP-to-Managed trampoline, not passing it to il2cpp: System.MissingMethodException: Method not found.",
            "   at AdvancedDealing.Economy.DealerExtension.GetAllProducts(Int32& totalAmount)",
        ]
        .join("\n");

        fs::write(&log_path, content).await.expect("write log file");

        let service = LogsService::new();
        let lines = service
            .read_log_file(log_path.to_str().expect("utf8 path"), None)
            .await
            .expect("read log file");

        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].mod_tag.as_deref(), Some("PackRat"));
        assert_eq!(lines[0].level.as_deref(), Some("WARN"));
        assert!(matches!(lines[0].category, LogCategory::MelonLoader));
        assert_eq!(lines[1].mod_tag.as_deref(), Some("AdvancedDealing"));
        assert_eq!(lines[1].level.as_deref(), Some("ERROR"));
        assert!(matches!(lines[1].category, LogCategory::MelonLoader));
    }

    #[tokio::test]
    async fn read_log_file_keeps_generic_il2cpp_mod_tag_empty_without_installed_match() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let game_dir = temp_dir.path().join("Schedule I");
        let melonloader_dir = game_dir.join("MelonLoader");
        let log_path = melonloader_dir.join("Latest.log");

        fs::create_dir_all(&melonloader_dir)
            .await
            .expect("create melonloader dir");

        fs::write(
            &log_path,
            "[01:06:34.484] [Il2CppInterop] Exception in IL2CPP-to-Managed trampoline, not passing it to il2cpp: UnknownMod.SomeType threw.",
        )
        .await
        .expect("write log file");

        let service = LogsService::new();
        let lines = service
            .read_log_file(log_path.to_str().expect("utf8 path"), None)
            .await
            .expect("read log file");

        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].mod_tag, None);
        assert_eq!(lines[0].level.as_deref(), Some("ERROR"));
        assert!(matches!(lines[0].category, LogCategory::MelonLoader));
    }

    #[test]
    fn split_complete_log_bytes_buffers_partial_lines_and_code_units() {
        let (complete, pending) =
            LogsService::split_complete_log_bytes(b"first\nsecond", LogEncoding::Utf8);
        assert_eq!(complete, b"first\n");
        assert_eq!(pending, b"second");

        let utf16_bytes = "one\ntw"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .chain([0x00])
            .collect::<Vec<_>>();
        let (complete, pending) =
            LogsService::split_complete_log_bytes(&utf16_bytes, LogEncoding::Utf16Le);
        assert_eq!(
            LogsService::decode_log_content_with_encoding(&complete, LogEncoding::Utf16Le),
            "one\n"
        );
        assert_eq!(
            LogsService::decode_log_content_with_encoding(
                &pending[..pending.len() - 1],
                LogEncoding::Utf16Le
            ),
            "tw"
        );
        assert_eq!(pending.last(), Some(&0x00));
    }
}
