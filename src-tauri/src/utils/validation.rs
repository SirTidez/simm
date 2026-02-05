use anyhow::{Context, Result};
use regex::Regex;
use std::path::PathBuf;

/// Validates and sanitizes a directory path to prevent path traversal attacks
pub fn validate_directory_path(path: &str, base_dir: Option<&str>) -> Result<String> {
    let path_ref = std::path::Path::new(path);
    for component in path_ref.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err(anyhow::anyhow!(
                "Path traversal detected: \"..\" not allowed"
            ));
        }
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
        normalized
            .canonicalize()
            .context("Failed to canonicalize path")?
    } else {
        // For non-existent paths, just use the normalized absolute path
        normalized
    };

    // If baseDir is provided, ensure path is within it
    if let Some(base) = base_dir {
        let base_path = PathBuf::from(base);
        let base_normalized = if base_path.exists() {
            base_path
                .canonicalize()
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
            return Err(anyhow::anyhow!(
                "Path traversal detected: path must be within base directory"
            ));
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
    input
        .chars()
        .filter(|c| {
            !matches!(
                c,
                ';' | '&' | '|' | '`' | '$' | '(' | ')' | '{' | '}' | '[' | ']' | '<' | '>'
            )
        })
        .collect()
}

/// Validates platform value
pub fn validate_platform(platform: &str) -> bool {
    matches!(platform, "windows" | "macos" | "linux")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::path::PathBuf;
    use tempfile::tempdir;

    #[test]
    fn validate_directory_path_rejects_traversal() {
        let result = validate_directory_path("../evil", None);
        assert!(result.is_err());
    }

    #[test]
    #[serial]
    fn validate_directory_path_respects_base_dir() -> Result<()> {
        let base_temp = tempdir()?;
        let base_path = base_temp.path();
        let child_path = base_path.join("child");
        std::fs::create_dir_all(&child_path)?;

        let allowed = validate_directory_path(
            child_path.to_string_lossy().as_ref(),
            Some(base_path.to_string_lossy().as_ref()),
        )?;
        let allowed_path = PathBuf::from(allowed);
        assert!(allowed_path.starts_with(base_path));

        let other_temp = tempdir()?;
        let denied = validate_directory_path(
            other_temp.path().to_string_lossy().as_ref(),
            Some(base_path.to_string_lossy().as_ref()),
        );
        assert!(denied.is_err());

        Ok(())
    }

    #[test]
    fn validate_app_id_rules() {
        assert!(validate_app_id("123"));
        assert!(!validate_app_id("12a"));
        assert!(!validate_app_id(""));
    }

    #[test]
    fn validate_branch_name_rules() {
        assert!(validate_branch_name("main"));
        assert!(validate_branch_name("feature-1"));
        assert!(!validate_branch_name("with space"));
        assert!(!validate_branch_name(&"a".repeat(101)));
    }

    #[test]
    fn validate_environment_name_rules() {
        assert!(validate_environment_name("Env"));
        assert!(!validate_environment_name(""));
        assert!(!validate_environment_name(&"a".repeat(201)));
    }

    #[test]
    fn sanitize_string_removes_dangerous_chars() {
        let sanitized = sanitize_string("rm -rf /; echo hi | exit");
        assert!(!sanitized.contains(';'));
        assert!(!sanitized.contains('|'));
        assert!(sanitized.contains("rm -rf /"));
    }

    #[test]
    fn validate_platform_rules() {
        assert!(validate_platform("windows"));
        assert!(validate_platform("linux"));
        assert!(!validate_platform("win"));
    }
}
