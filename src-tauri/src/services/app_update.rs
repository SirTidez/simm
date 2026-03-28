use crate::services::nexus_mods::NexusModsService;
use crate::types::Settings;
use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashSet;

const DEFAULT_GAME_ID: &str = "schedule1";
const DEFAULT_APP_UPDATE_QUERY: [&str; 2] = ["Schedule I Mod Manager", "SIMM"];
const PLACEHOLDER_APP_UPDATE_IDENTIFIERS: [&str; 2] = ["schedule-i", "schedule1"];

static VERSION_CORE_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\d+(?:\.\d+)*").expect("version normalization regex should compile")
});

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatus {
    pub current_version_raw: String,
    pub current_version_normalized: String,
    pub latest_version_raw: String,
    pub latest_version_normalized: String,
    pub update_available: bool,
    pub target_url: String,
    pub fallback_files_url: String,
    pub checked_at: String,
}

fn normalize_release_version(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    VERSION_CORE_REGEX
        .find(trimmed)
        .map(|m| m.as_str().trim_matches('.').to_string())
        .unwrap_or_else(|| trimmed.to_string())
}

fn compare_normalized_versions(left: &str, right: &str) -> Ordering {
    let left_parts: Vec<u64> = normalize_release_version(left)
        .split('.')
        .filter(|segment| !segment.is_empty())
        .map(|segment| segment.parse::<u64>().unwrap_or(0))
        .collect();
    let right_parts: Vec<u64> = normalize_release_version(right)
        .split('.')
        .filter(|segment| !segment.is_empty())
        .map(|segment| segment.parse::<u64>().unwrap_or(0))
        .collect();

    let max_len = left_parts.len().max(right_parts.len());
    for index in 0..max_len {
        let left_value = left_parts.get(index).copied().unwrap_or(0);
        let right_value = right_parts.get(index).copied().unwrap_or(0);
        match left_value.cmp(&right_value) {
            Ordering::Equal => continue,
            other => return other,
        }
    }

    Ordering::Equal
}

fn is_placeholder_app_identifier(value: &str) -> bool {
    PLACEHOLDER_APP_UPDATE_IDENTIFIERS
        .iter()
        .any(|placeholder| placeholder.eq_ignore_ascii_case(value.trim()))
}

fn build_search_queries(settings: &Settings) -> Vec<String> {
    let mut queries = Vec::new();
    let mut seen = HashSet::new();

    if let Some(configured) = settings
        .nexus_mods_app_slug
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && !is_placeholder_app_identifier(value))
    {
        let normalized = configured.to_ascii_lowercase();
        if seen.insert(normalized) {
            queries.push(configured.to_string());
        }
    }

    for query in DEFAULT_APP_UPDATE_QUERY {
        let normalized = query.to_ascii_lowercase();
        if seen.insert(normalized) {
            queries.push(query.to_string());
        }
    }

    queries
}

fn parse_mod_id(value: &Value) -> Option<u32> {
    value
        .get("mod_id")
        .or_else(|| value.get("modId"))
        .and_then(|candidate| candidate.as_u64())
        .map(|candidate| candidate as u32)
}

fn parse_file_id(value: &Value) -> Option<u32> {
    value
        .get("file_id")
        .or_else(|| value.get("fileId"))
        .and_then(|candidate| candidate.as_u64())
        .map(|candidate| candidate as u32)
}

fn score_candidate(candidate: &Value, preferred_query: Option<&str>) -> i32 {
    let name = candidate
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let summary = candidate
        .get("summary")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let author = candidate
        .get("author")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let preferred = preferred_query.unwrap_or("").trim().to_ascii_lowercase();

    let mut score = 0;
    if name == "simm" {
        score += 1000;
    }
    if name == "schedule i mod manager" {
        score += 950;
    }
    if !preferred.is_empty() && name == preferred {
        score += 900;
    }
    if name.contains("simm") {
        score += 260;
    }
    if name.contains("mod manager") {
        score += 180;
    }
    if name.contains("schedule i") {
        score += 120;
    }
    if summary.contains("schedule i") {
        score += 80;
    }
    if summary.contains("mod manager") {
        score += 60;
    }
    if author.contains("lockwire") {
        score += 30;
    }
    score
}

fn build_files_tab_url(game_id: &str, mod_id: u32) -> String {
    format!(
        "https://www.nexusmods.com/{}/mods/{}?tab=files",
        game_id, mod_id
    )
}

fn build_file_target_url(game_id: &str, mod_id: u32, file: &Value) -> String {
    let file_target = parse_file_id(file)
        .map(|file_id| {
            format!(
                "https://www.nexusmods.com/{}/mods/{}?tab=files&file_id={}",
                game_id, mod_id, file_id
            )
        })
        .unwrap_or_else(|| build_files_tab_url(game_id, mod_id));

    match file
        .get("uri")
        .and_then(|value| value.as_str())
        .map(str::trim)
    {
        Some(uri) if uri.starts_with("http://") || uri.starts_with("https://") => uri.to_string(),
        Some(uri) if uri.starts_with('/') => format!("https://www.nexusmods.com{}", uri),
        _ => file_target,
    }
}

fn select_latest_file<'a>(files: &'a [Value]) -> Option<&'a Value> {
    files.iter().max_by(|left, right| {
        let left_version = left
            .get("version")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let right_version = right
            .get("version")
            .and_then(|value| value.as_str())
            .unwrap_or("");

        compare_normalized_versions(left_version, right_version)
            .then_with(|| {
                let left_primary = left
                    .get("is_primary")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false);
                let right_primary = right
                    .get("is_primary")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false);
                left_primary.cmp(&right_primary)
            })
            .then_with(|| parse_file_id(left).cmp(&parse_file_id(right)))
    })
}

async fn resolve_app_mod(
    nexus_service: &NexusModsService,
    settings: &Settings,
    game_id: &str,
) -> Result<Value> {
    if let Some(configured) = settings
        .nexus_mods_app_slug
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Ok(mod_id) = configured.parse::<u32>() {
            return nexus_service
                .get_mod(game_id, mod_id)
                .await
                .with_context(|| {
                    format!("Failed to resolve configured Nexus app mod id {}", mod_id)
                });
        }
    }

    let queries = build_search_queries(settings);
    let preferred_query = queries.first().cloned();
    let mut candidates = Vec::new();
    let mut seen_ids = HashSet::new();

    for query in queries {
        for candidate in nexus_service.search_mods(game_id, &query).await? {
            let Some(mod_id) = parse_mod_id(&candidate) else {
                continue;
            };
            if seen_ids.insert(mod_id) {
                candidates.push(candidate);
            }
        }
    }

    candidates
        .into_iter()
        .max_by(|left, right| {
            score_candidate(left, preferred_query.as_deref())
                .cmp(&score_candidate(right, preferred_query.as_deref()))
                .then_with(|| {
                    let left_updated = left
                        .get("updated_at")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    let right_updated = right
                        .get("updated_at")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    left_updated.cmp(right_updated)
                })
        })
        .ok_or_else(|| anyhow!("Failed to locate the SIMM Nexus listing"))
}

pub async fn fetch_app_update_status(
    nexus_service: &NexusModsService,
    settings: &Settings,
    current_version_raw: &str,
) -> Result<AppUpdateStatus> {
    let game_id = settings
        .nexus_mods_game_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_GAME_ID);

    let app_mod = resolve_app_mod(nexus_service, settings, game_id).await?;
    let mod_id = parse_mod_id(&app_mod)
        .ok_or_else(|| anyhow!("Resolved app listing is missing a mod id"))?;
    let files = nexus_service.get_mod_files(game_id, mod_id).await?;
    let latest_file = select_latest_file(&files)
        .ok_or_else(|| anyhow!("The SIMM Nexus listing does not expose any versioned files"))?;
    let latest_version_raw = latest_file
        .get("version")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            app_mod
                .get("version")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .ok_or_else(|| anyhow!("The SIMM Nexus listing does not expose a usable version"))?
        .to_string();

    let latest_version_normalized = normalize_release_version(&latest_version_raw);
    let current_version_normalized = normalize_release_version(current_version_raw);
    let fallback_files_url = build_files_tab_url(game_id, mod_id);
    let target_url = build_file_target_url(game_id, mod_id, latest_file);

    Ok(AppUpdateStatus {
        current_version_raw: current_version_raw.trim().to_string(),
        current_version_normalized: current_version_normalized.clone(),
        latest_version_raw,
        latest_version_normalized: latest_version_normalized.clone(),
        update_available: compare_normalized_versions(
            &latest_version_normalized,
            &current_version_normalized,
        )
        .is_gt(),
        target_url,
        fallback_files_url,
        checked_at: Utc::now().to_rfc3339(),
    })
}

#[cfg(test)]
mod tests {
    use super::{compare_normalized_versions, normalize_release_version, select_latest_file};
    use std::cmp::Ordering;

    #[test]
    fn normalize_release_version_strips_prerelease_suffixes() {
        assert_eq!(normalize_release_version("0.7.8-beta"), "0.7.8");
        assert_eq!(normalize_release_version("v1.2.3+build7"), "1.2.3");
        assert_eq!(normalize_release_version("  2.0.1 rc1 "), "2.0.1");
    }

    #[test]
    fn compare_normalized_versions_uses_numeric_segments() {
        assert_eq!(
            compare_normalized_versions("0.7.10", "0.7.9"),
            Ordering::Greater
        );
        assert_eq!(
            compare_normalized_versions("0.7.8-beta", "0.7.8"),
            Ordering::Equal
        );
        assert_eq!(
            compare_normalized_versions("1.0.0", "1.0.1"),
            Ordering::Less
        );
    }

    #[test]
    fn select_latest_file_prefers_highest_normalized_version() {
        let files = vec![
            serde_json::json!({
                "file_id": 1,
                "version": "0.7.8",
                "is_primary": true
            }),
            serde_json::json!({
                "file_id": 2,
                "version": "0.7.9-beta",
                "is_primary": false
            }),
        ];

        let latest = select_latest_file(&files).expect("should choose a file");
        assert_eq!(
            latest.get("file_id").and_then(|value| value.as_u64()),
            Some(2)
        );
    }

    #[test]
    fn parse_mod_id_supports_graphql_camel_case_shape() {
        let entry = serde_json::json!({
            "modId": 42
        });

        assert_eq!(super::parse_mod_id(&entry), Some(42));
    }
}
