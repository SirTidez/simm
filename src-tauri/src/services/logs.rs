use std::path::{Path, PathBuf};
use anyhow::{Context, Result};
use tokio::fs;
use chrono::{DateTime, Utc};
use regex::Regex;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LogFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: Option<DateTime<Utc>>,
    pub is_latest: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LogLine {
    pub line_number: usize,
    pub content: String,
    pub level: Option<String>,
    pub timestamp: Option<String>,
}

pub struct LogsService;

impl LogsService {
    pub fn new() -> Self {
        Self
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

    pub async fn list_log_files(&self, game_dir: &str) -> Result<Vec<LogFile>> {
        let melonloader_dir = self.get_melonloader_logs_dir(game_dir);
        
        if !melonloader_dir.exists() {
            return Ok(Vec::new());
        }

        let mut log_files = Vec::new();

        // Check for Latest.log
        let latest_log = self.get_latest_log_path(game_dir);
        if latest_log.exists() {
            if let Ok(metadata) = fs::metadata(&latest_log).await {
                let modified = metadata.modified()
                    .ok()
                    .and_then(|t| {
                        DateTime::<Utc>::from_timestamp(
                            t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64,
                            0
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

        // Check for logs in Logs directory
        let logs_dir = self.get_logs_dir(game_dir);
        if logs_dir.exists() {
            let mut entries = fs::read_dir(&logs_dir).await
                .context("Failed to read Logs directory")?;
            
            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("log") {
                    if let Ok(metadata) = entry.metadata().await {
                        let file_name = path.file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("unknown.log")
                            .to_string();
                        
                        let modified = metadata.modified()
                            .ok()
                            .and_then(|t| {
                                DateTime::<Utc>::from_timestamp(
                                    t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64,
                                    0
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

        // Sort by modified date (newest first), with Latest.log always first
        log_files.sort_by(|a, b| {
            if a.is_latest {
                std::cmp::Ordering::Less
            } else if b.is_latest {
                std::cmp::Ordering::Greater
            } else {
                match (a.modified, b.modified) {
                    (Some(a_time), Some(b_time)) => b_time.cmp(&a_time),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => std::cmp::Ordering::Equal,
                }
            }
        });

        Ok(log_files)
    }

    pub async fn read_log_file(&self, log_path: &str, max_lines: Option<usize>) -> Result<Vec<LogLine>> {
        let path = Path::new(log_path);
        
        if !path.exists() {
            return Err(anyhow::anyhow!("Log file does not exist: {}", log_path));
        }

        let content = fs::read_to_string(path).await
            .context("Failed to read log file")?;

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
            let content = line.to_string();
            
            // Parse log level from common formats:
            // [INFO] message
            // [WARN] message
            // [ERROR] message
            // [DEBUG] message
            // [00:00:00.000] [INFO] message
            let level = Self::extract_log_level(&content);
            let timestamp = Self::extract_timestamp(&content);

            log_lines.push(LogLine {
                line_number,
                content,
                level,
                timestamp,
            });
        }

        Ok(log_lines)
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

    fn extract_timestamp(line: &str) -> Option<String> {
        // Try to match timestamp patterns like:
        // [00:00:00.000]
        // 2024-01-01 00:00:00
        // ISO format timestamps
        let timestamp_patterns = [
            r"\[\d{2}:\d{2}:\d{2}\.\d{3}\]",  // [00:00:00.000]
            r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}",  // 2024-01-01 00:00:00
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}",  // ISO format
        ];

        for pattern in &timestamp_patterns {
            if let Ok(re) = regex::Regex::new(pattern) {
                if let Some(captures) = re.find(line) {
                    return Some(captures.as_str().to_string());
                }
            }
        }
        None
    }

    pub async fn export_logs(
        &self,
        log_path: &str,
        filter_level: Option<&str>,
        search_query: Option<&str>,
        output_path: &str,
    ) -> Result<()> {
        let log_lines = self.read_log_file(log_path, None).await?;

        let mut filtered_lines = log_lines.iter()
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

                // Filter by search query
                if let Some(query) = search_query {
                    if !query.is_empty() && !line.content.to_lowercase().contains(&query.to_lowercase()) {
                        return false;
                    }
                }

                true
            })
            .map(|line| line.content.clone())
            .collect::<Vec<_>>();

        // Add header with filter/search info
        let mut output = String::new();
        output.push_str(&format!("MelonLoader Log Export\n"));
        output.push_str(&format!("Source: {}\n", log_path));
        output.push_str(&format!("Exported: {}\n", Utc::now().to_rfc3339()));
        if let Some(level) = filter_level {
            output.push_str(&format!("Filter Level: {}\n", level));
        }
        if let Some(query) = search_query {
            output.push_str(&format!("Search Query: {}\n", query));
        }
        output.push_str(&format!("Total Lines: {}\n", filtered_lines.len()));
        output.push_str(&format!("{}\n", "=".repeat(80)));
        output.push_str("\n");

        output.push_str(&filtered_lines.join("\n"));

        fs::write(output_path, output).await
            .context("Failed to write export file")?;

        Ok(())
    }
}

impl Default for LogsService {
    fn default() -> Self {
        Self::new()
    }
}

