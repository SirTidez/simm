use std::path::PathBuf;
use regex::Regex;
use anyhow::{Context, Result};

/// Validates and sanitizes a directory path to prevent path traversal attacks
pub fn validate_directory_path(path: &str, base_dir: Option<&str>) -> Result<String> {
    // Check for dangerous patterns first
    if path.contains("..") {
        return Err(anyhow::anyhow!("Path traversal detected: \"..\" not allowed"));
    }
    
    let mut normalized = PathBuf::from(path);
    
    // Normalize the path - resolve relative paths
    if normalized.is_relative() {
        normalized = std::env::current_dir()
            .context("Failed to get current directory")?
            .join(normalized);
    }
    
    // Try to canonicalize if path exists, otherwise use the normalized path
    let normalized = if normalized.exists() {
        normalized.canonicalize()
            .context("Failed to canonicalize path")?
    } else {
        // For non-existent paths, just use the normalized absolute path
        normalized
    };
    
    // If baseDir is provided, ensure path is within it
    if let Some(base) = base_dir {
        let base_path = PathBuf::from(base);
        let base_normalized = if base_path.exists() {
            base_path.canonicalize()
                .context("Failed to canonicalize base directory")?
        } else {
            // For non-existent base, resolve relative to current dir
            if base_path.is_relative() {
                std::env::current_dir()
                    .context("Failed to get current directory")?
                    .join(base_path)
            } else {
                base_path
            }
        };
        
        // Check if the normalized path is still within baseDir
        if !normalized.starts_with(&base_normalized) {
            return Err(anyhow::anyhow!("Path traversal detected: path must be within base directory"));
        }
    }
    
    // Convert to absolute path string
    let path_str = normalized.to_string_lossy().to_string();
    
    // Strip Windows extended path prefix (\\?\) if present
    let cleaned_path = if path_str.starts_with(r"\\?\") {
        &path_str[4..]
    } else {
        &path_str
    };
    
    Ok(cleaned_path.to_string())
}

/// Validates AppID format (should be numeric)
pub fn validate_app_id(app_id: &str) -> bool {
    app_id.chars().all(|c| c.is_ascii_digit()) && !app_id.is_empty()
}

/// Validates branch name (alphanumeric, hyphens, underscores)
pub fn validate_branch_name(branch: &str) -> bool {
    let re = Regex::new(r"^[a-zA-Z0-9_-]+$").unwrap();
    re.is_match(branch) && !branch.is_empty() && branch.len() <= 100
}

/// Validates environment name
pub fn validate_environment_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 200
}

/// Sanitizes string to prevent command injection
pub fn sanitize_string(input: &str) -> String {
    input.chars()
        .filter(|c| !matches!(c, ';' | '&' | '|' | '`' | '$' | '(' | ')' | '{' | '}' | '[' | ']' | '<' | '>'))
        .collect()
}

/// Validates platform value
pub fn validate_platform(platform: &str) -> bool {
    matches!(platform, "windows" | "macos" | "linux")
}

