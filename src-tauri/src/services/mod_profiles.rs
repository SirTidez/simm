use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use serde_json::Value;
use sqlx::SqlitePool;

use crate::services::environment::EnvironmentService;
use crate::services::mods::ModsService;
use crate::services::plugins::PluginsService;
use crate::services::userlibs::UserLibsService;
use crate::types::{
    Environment, ModLibraryEntry, ModProfileApplyRequest, ModProfileApplyResult,
    ModProfileImportPlan, ModProfileImportPlanItem, ModProfileImportStatus,
    ModProfileImportSummary, ModProfileInfo, ModProfileItem, ModProfileItemType,
    ModProfileManifest, ModSource, Runtime,
};

const PROFILE_KIND: &str = "simm.profile";
const PROFILE_SCHEMA_VERSION: u32 = 1;
const PROFILE_GAME_ID: &str = "schedule-i";
const NEXUS_FILE_ID_TAG_PREFIX: &str = "nexus-file-id:";

pub struct ModProfilesService {
    pool: Arc<SqlitePool>,
}

impl ModProfilesService {
    pub fn new(pool: Arc<SqlitePool>) -> Self {
        Self { pool }
    }

    pub async fn export_environment_profile(
        &self,
        environment_id: &str,
    ) -> Result<ModProfileManifest> {
        let env_service = EnvironmentService::new(self.pool.clone())?;
        let environment = env_service
            .get_environment(environment_id)
            .await?
            .ok_or_else(|| anyhow!("Environment not found"))?;

        let mods_service = ModsService::new(self.pool.clone());
        let installed_mods = mods_service
            .list_mods(&environment.output_dir)
            .await
            .context("Failed to list installed mods for profile export")?;
        let library = mods_service
            .get_mod_library()
            .await
            .context("Failed to load mod library for profile export")?;

        let mut items = build_managed_mod_items(&environment, &library.downloaded, &installed_mods);
        items.extend(build_unmanaged_mod_items(&environment, &installed_mods));
        items.extend(build_plugin_items(self.pool.clone(), &environment).await?);
        items.extend(build_userlib_items(&environment).await?);

        items.sort_by(|left, right| {
            format!("{:?}:{}", left.item_type, left.name.to_lowercase()).cmp(&format!(
                "{:?}:{}",
                right.item_type,
                right.name.to_lowercase()
            ))
        });

        Ok(ModProfileManifest {
            schema_version: PROFILE_SCHEMA_VERSION,
            kind: PROFILE_KIND.to_string(),
            profile: ModProfileInfo {
                name: environment.name.clone(),
                game: PROFILE_GAME_ID.to_string(),
                environment_id: Some(environment.id.clone()),
                runtime: environment.runtime,
                branch: environment.branch,
                game_version: environment.current_game_version,
                exported_at: Utc::now().to_rfc3339(),
            },
            items,
        })
    }

    pub async fn preview_import(
        &self,
        manifest: ModProfileManifest,
        target_environment_id: Option<String>,
    ) -> Result<ModProfileImportPlan> {
        validate_manifest(&manifest)?;
        let target_environment = self
            .load_target_environment(target_environment_id.as_deref())
            .await?;
        let mods_service = ModsService::new(self.pool.clone());
        let library = mods_service.get_mod_library().await?;
        let installed_mods = if let Some(environment) = target_environment.as_ref() {
            Some(mods_service.list_mods(&environment.output_dir).await?)
        } else {
            None
        };

        let mut summary = ModProfileImportSummary {
            total: manifest.items.len(),
            ..Default::default()
        };
        let mut items = Vec::with_capacity(manifest.items.len());

        for item in manifest.items.iter().cloned() {
            let plan_item = plan_item(
                item,
                target_environment.as_ref(),
                &library.downloaded,
                installed_mods.as_ref(),
            );
            increment_summary(&mut summary, &plan_item.status);
            items.push(plan_item);
        }

        Ok(ModProfileImportPlan {
            profile: manifest.profile,
            target_environment_id,
            items,
            summary,
        })
    }

    pub async fn apply_import(
        &self,
        request: ModProfileApplyRequest,
    ) -> Result<ModProfileApplyResult> {
        let target_environment_id = request.target_environment_id.clone();
        let plan = self
            .preview_import(request.manifest, Some(target_environment_id.clone()))
            .await?;
        let mods_service = ModsService::new(self.pool.clone());
        let mut installed = 0usize;
        let mut skipped = 0usize;
        let mut unresolved = 0usize;
        let mut messages = Vec::new();

        for item in &plan.items {
            match item.status {
                ModProfileImportStatus::ReadyToInstall => {
                    if item.item.item_type != ModProfileItemType::Mod {
                        skipped += 1;
                        messages.push(format!(
                            "Skipped {} because only mod installs are automated in this version.",
                            item.item.name
                        ));
                        continue;
                    }
                    if let Some(storage_id) = item.resolved_storage_id.as_deref() {
                        mods_service
                            .install_storage_mod_to_envs(
                                storage_id,
                                vec![target_environment_id.clone()],
                            )
                            .await
                            .with_context(|| format!("Failed to install {}", item.item.name))?;
                        installed += 1;
                    } else {
                        unresolved += 1;
                    }
                }
                ModProfileImportStatus::AlreadyInstalled => {
                    skipped += 1;
                }
                _ => {
                    unresolved += 1;
                    messages.push(format!("{}: {}", item.item.name, item.message));
                }
            }
        }

        let refreshed_plan = self
            .preview_import(plan_to_manifest(&plan), Some(target_environment_id))
            .await?;

        Ok(ModProfileApplyResult {
            plan: refreshed_plan,
            installed,
            skipped,
            unresolved,
            messages,
        })
    }

    pub async fn save_manifest_to_file(
        &self,
        manifest: ModProfileManifest,
        destination: PathBuf,
    ) -> Result<()> {
        validate_manifest(&manifest)?;
        let profile_json = serde_json::to_string_pretty(&manifest)
            .context("Failed to serialize profile manifest")?;
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("Failed to create {}", parent.display()))?;
        }
        tokio::fs::write(&destination, profile_json)
            .await
            .with_context(|| format!("Failed to write {}", destination.display()))?;
        Ok(())
    }

    pub async fn read_manifest_from_file(&self, source: PathBuf) -> Result<ModProfileManifest> {
        let profile_json = tokio::fs::read_to_string(&source)
            .await
            .with_context(|| format!("Failed to read {}", source.display()))?;
        let manifest = serde_json::from_str::<ModProfileManifest>(&profile_json)
            .with_context(|| format!("Failed to parse {}", source.display()))?;
        validate_manifest(&manifest)?;
        Ok(manifest)
    }

    async fn load_target_environment(&self, id: Option<&str>) -> Result<Option<Environment>> {
        let Some(id) = id else {
            return Ok(None);
        };
        let env_service = EnvironmentService::new(self.pool.clone())?;
        env_service
            .get_environment(id)
            .await?
            .map(Some)
            .ok_or_else(|| anyhow!("Target environment not found"))
    }
}

fn validate_manifest(manifest: &ModProfileManifest) -> Result<()> {
    if manifest.schema_version != PROFILE_SCHEMA_VERSION {
        return Err(anyhow!(
            "Unsupported profile schema version {}",
            manifest.schema_version
        ));
    }
    if manifest.kind != PROFILE_KIND {
        return Err(anyhow!("Unsupported profile kind {}", manifest.kind));
    }
    if manifest.profile.game != PROFILE_GAME_ID {
        return Err(anyhow!(
            "Unsupported profile game {}",
            manifest.profile.game
        ));
    }
    Ok(())
}

fn build_managed_mod_items(
    environment: &Environment,
    library: &[ModLibraryEntry],
    installed_mods: &Value,
) -> Vec<ModProfileItem> {
    installed_mods
        .get("mods")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|mod_value| {
            mod_value
                .get("managed")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|mod_value| {
            let storage_id = read_string(mod_value, "modStorageId")?;
            let entry = library.iter().find(|entry| entry.storage_id == storage_id);
            let enabled = !mod_value
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let name = entry
                .map(|entry| entry.display_name.clone())
                .or_else(|| read_string(mod_value, "name"))
                .or_else(|| read_string(mod_value, "fileName"))
                .unwrap_or_else(|| "Managed mod".to_string());
            let file_name = read_string(mod_value, "fileName")
                .or_else(|| entry.and_then(|entry| entry.files.first().cloned()));
            ModProfileItem {
                item_type: ModProfileItemType::Mod,
                name,
                file_name,
                required: true,
                enabled,
                source: entry.and_then(|entry| entry.source.clone()).or_else(|| {
                    mod_value
                        .get("source")
                        .cloned()
                        .and_then(|value| serde_json::from_value(value).ok())
                }),
                source_id: entry.and_then(|entry| entry.source_id.clone()),
                source_version: entry
                    .and_then(|entry| {
                        entry
                            .source_version
                            .clone()
                            .or(entry.installed_version.clone())
                    })
                    .or_else(|| read_string(mod_value, "version")),
                source_url: entry.and_then(|entry| entry.source_url.clone()),
                runtime: Some(environment.runtime.clone()),
                storage_id: Some(storage_id),
                nexus_file_id: entry.and_then(|entry| parse_nexus_file_id(entry.tags.as_deref())),
                manual_reason: None,
            }
            .into()
        })
        .collect()
}

fn build_unmanaged_mod_items(
    environment: &Environment,
    installed_mods: &Value,
) -> Vec<ModProfileItem> {
    installed_mods
        .get("mods")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|mod_value| {
            !mod_value
                .get("managed")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .map(|mod_value| {
            let name = read_string(mod_value, "name")
                .or_else(|| read_string(mod_value, "fileName"))
                .unwrap_or_else(|| "Local mod".to_string());
            ModProfileItem {
                item_type: ModProfileItemType::Mod,
                name,
                file_name: read_string(mod_value, "fileName"),
                required: true,
                enabled: !mod_value
                    .get("disabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                source: Some(ModSource::Local),
                source_id: None,
                source_version: read_string(mod_value, "version"),
                source_url: read_string(mod_value, "sourceUrl"),
                runtime: Some(environment.runtime.clone()),
                storage_id: None,
                nexus_file_id: None,
                manual_reason: Some("Local mod is not linked to a supported source.".to_string()),
            }
        })
        .collect()
}

async fn build_plugin_items(
    pool: Arc<SqlitePool>,
    environment: &Environment,
) -> Result<Vec<ModProfileItem>> {
    let plugins = PluginsService::new(pool)
        .list_plugins(&environment.output_dir)
        .await
        .context("Failed to list plugins for profile export")?;
    Ok(plugins
        .get("plugins")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|plugin| {
            let name = read_string(plugin, "name")
                .or_else(|| read_string(plugin, "fileName"))
                .unwrap_or_else(|| "Plugin".to_string());
            ModProfileItem {
                item_type: ModProfileItemType::Plugin,
                name,
                file_name: read_string(plugin, "fileName"),
                required: true,
                enabled: !plugin
                    .get("disabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                source: plugin
                    .get("source")
                    .cloned()
                    .and_then(|value| serde_json::from_value(value).ok()),
                source_id: None,
                source_version: read_string(plugin, "version"),
                source_url: None,
                runtime: Some(environment.runtime.clone()),
                storage_id: None,
                nexus_file_id: None,
                manual_reason: Some(
                    "Plugin sync is exported as a manual checklist item.".to_string(),
                ),
            }
        })
        .collect())
}

async fn build_userlib_items(environment: &Environment) -> Result<Vec<ModProfileItem>> {
    let userlibs = UserLibsService::new()
        .list_user_libs(&environment.output_dir)
        .await
        .context("Failed to list UserLibs for profile export")?;
    Ok(userlibs
        .get("userLibs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|userlib| {
            let name = read_string(userlib, "name")
                .or_else(|| read_string(userlib, "fileName"))
                .unwrap_or_else(|| "UserLib".to_string());
            ModProfileItem {
                item_type: ModProfileItemType::Userlib,
                name,
                file_name: read_string(userlib, "fileName"),
                required: true,
                enabled: !userlib
                    .get("disabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                source: Some(ModSource::Local),
                source_id: None,
                source_version: None,
                source_url: None,
                runtime: Some(environment.runtime.clone()),
                storage_id: None,
                nexus_file_id: None,
                manual_reason: Some(
                    "UserLib sync is exported as a manual checklist item.".to_string(),
                ),
            }
        })
        .collect())
}

fn plan_item(
    item: ModProfileItem,
    target_environment: Option<&Environment>,
    library: &[ModLibraryEntry],
    installed_mods: Option<&Value>,
) -> ModProfileImportPlanItem {
    if item.item_type != ModProfileItemType::Mod {
        return ModProfileImportPlanItem {
            item,
            status: ModProfileImportStatus::ManualRequired,
            resolved_storage_id: None,
            message: "Plugins and UserLibs are included as manual checklist items.".to_string(),
        };
    }

    if matches!(
        item.source,
        Some(ModSource::Local) | Some(ModSource::Unknown) | None
    ) && item.source_id.is_none()
    {
        return ModProfileImportPlanItem {
            item,
            status: ModProfileImportStatus::ManualRequired,
            resolved_storage_id: None,
            message: "This local mod is not linked to a downloadable source.".to_string(),
        };
    }

    if let Some(environment) = target_environment {
        if let Some(runtime) = item.runtime.clone() {
            if runtime != environment.runtime {
                return ModProfileImportPlanItem {
                    item,
                    status: ModProfileImportStatus::RuntimeMismatch,
                    resolved_storage_id: None,
                    message: format!(
                        "Profile item is for {:?}, but target environment is {:?}.",
                        runtime, environment.runtime
                    ),
                };
            }
        }
    }

    if let Some(storage_id) = installed_storage_id(installed_mods, &item) {
        return ModProfileImportPlanItem {
            item,
            status: ModProfileImportStatus::AlreadyInstalled,
            resolved_storage_id: Some(storage_id),
            message: "Already installed in the target environment.".to_string(),
        };
    }

    let resolved = resolve_library_storage_id(library, &item);
    match resolved {
        Some(storage_id) => ModProfileImportPlanItem {
            item,
            status: ModProfileImportStatus::ReadyToInstall,
            resolved_storage_id: Some(storage_id),
            message: "Downloaded library entry is ready to install.".to_string(),
        },
        None if item.source_id.is_some() => ModProfileImportPlanItem {
            item,
            status: ModProfileImportStatus::NeedsDownload,
            resolved_storage_id: None,
            message: "Supported source is known, but the matching version is not downloaded yet."
                .to_string(),
        },
        None => ModProfileImportPlanItem {
            item,
            status: ModProfileImportStatus::ManualRequired,
            resolved_storage_id: None,
            message: "No supported source identity is available.".to_string(),
        },
    }
}

fn installed_storage_id(installed_mods: Option<&Value>, item: &ModProfileItem) -> Option<String> {
    let installed_mods = installed_mods?;
    installed_mods
        .get("mods")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find_map(|mod_value| {
            let storage_id = read_string(mod_value, "modStorageId")?;
            if item
                .storage_id
                .as_ref()
                .map(|expected| expected == &storage_id)
                .unwrap_or(false)
            {
                return Some(storage_id);
            }
            let same_source = item.source_id.as_ref().is_some_and(|source_id| {
                read_string(mod_value, "sourceId")
                    .as_ref()
                    .map(|value| value.eq_ignore_ascii_case(source_id))
                    .unwrap_or(false)
            });
            if same_source {
                Some(storage_id)
            } else {
                None
            }
        })
}

fn resolve_library_storage_id(
    library: &[ModLibraryEntry],
    item: &ModProfileItem,
) -> Option<String> {
    if let Some(storage_id) = item.storage_id.as_deref() {
        if library.iter().any(|entry| entry.storage_id == storage_id) {
            return Some(storage_id.to_string());
        }
    }

    let source_id = item.source_id.as_deref()?;
    library.iter().find_map(|entry| {
        let entry_source_id = entry.source_id.as_deref()?;
        if !entry_source_id.eq_ignore_ascii_case(source_id) {
            return None;
        }
        if let Some(version) = item.source_version.as_deref() {
            let entry_version = entry
                .source_version
                .as_deref()
                .or(entry.installed_version.as_deref());
            if entry_version != Some(version) {
                return None;
            }
        }
        if let Some(runtime) = item.runtime.as_ref() {
            let runtime_key = runtime_key(runtime);
            if !entry.available_runtimes.is_empty()
                && !entry
                    .available_runtimes
                    .iter()
                    .any(|candidate| candidate.eq_ignore_ascii_case(runtime_key))
            {
                return None;
            }
            if let Some(runtime_storage_id) = entry.storage_ids_by_runtime.get(runtime_key) {
                return Some(runtime_storage_id.clone());
            }
        }
        Some(entry.storage_id.clone())
    })
}

fn parse_nexus_file_id(tags: Option<&[String]>) -> Option<String> {
    tags.into_iter().flatten().find_map(|tag| {
        tag.strip_prefix(NEXUS_FILE_ID_TAG_PREFIX)
            .map(|value| value.to_string())
    })
}

fn read_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(ToString::to_string)
}

fn runtime_key(runtime: &Runtime) -> &'static str {
    match runtime {
        Runtime::Il2cpp => "IL2CPP",
        Runtime::Mono => "Mono",
    }
}

fn increment_summary(summary: &mut ModProfileImportSummary, status: &ModProfileImportStatus) {
    match status {
        ModProfileImportStatus::AlreadyInstalled => summary.already_installed += 1,
        ModProfileImportStatus::ReadyToInstall => summary.ready_to_install += 1,
        ModProfileImportStatus::NeedsDownload => summary.needs_download += 1,
        ModProfileImportStatus::ManualRequired => summary.manual_required += 1,
        ModProfileImportStatus::RuntimeMismatch => summary.runtime_mismatches += 1,
        ModProfileImportStatus::Unsupported => summary.unsupported += 1,
    }
}

fn plan_to_manifest(plan: &ModProfileImportPlan) -> ModProfileManifest {
    ModProfileManifest {
        schema_version: PROFILE_SCHEMA_VERSION,
        kind: PROFILE_KIND.to_string(),
        profile: plan.profile.clone(),
        items: plan.items.iter().map(|item| item.item.clone()).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library_entry(storage_id: &str, source_id: &str, runtime: Runtime) -> ModLibraryEntry {
        ModLibraryEntry {
            storage_id: storage_id.to_string(),
            display_name: "Example".to_string(),
            files: vec!["Example.dll".to_string()],
            attached_userlibs: Vec::new(),
            attached_userdata: Vec::new(),
            source: Some(ModSource::Thunderstore),
            source_id: Some(source_id.to_string()),
            source_version: Some("1.0.0".to_string()),
            source_url: None,
            summary: None,
            icon_url: None,
            icon_cache_path: None,
            downloads: None,
            likes_or_endorsements: None,
            updated_at: None,
            tags: None,
            installed_version: None,
            library_added_at: None,
            installed_at: None,
            author: None,
            update_available: None,
            remote_version: None,
            managed: true,
            installed_in: Vec::new(),
            available_runtimes: vec![runtime_key(&runtime).to_string()],
            storage_ids_by_runtime: Default::default(),
            installed_in_by_runtime: Default::default(),
            files_by_runtime: Default::default(),
            security_scan: None,
        }
    }

    fn profile_item() -> ModProfileItem {
        ModProfileItem {
            item_type: ModProfileItemType::Mod,
            name: "Example".to_string(),
            file_name: Some("Example.dll".to_string()),
            required: true,
            enabled: true,
            source: Some(ModSource::Thunderstore),
            source_id: Some("Author/Example".to_string()),
            source_version: Some("1.0.0".to_string()),
            source_url: None,
            runtime: Some(Runtime::Mono),
            storage_id: None,
            nexus_file_id: None,
            manual_reason: None,
        }
    }

    fn profile_manifest() -> ModProfileManifest {
        ModProfileManifest {
            schema_version: PROFILE_SCHEMA_VERSION,
            kind: PROFILE_KIND.to_string(),
            profile: ModProfileInfo {
                name: "Co-op".to_string(),
                game: PROFILE_GAME_ID.to_string(),
                environment_id: Some("env-1".to_string()),
                runtime: Runtime::Mono,
                branch: "alternate".to_string(),
                game_version: Some("0.4.5f2".to_string()),
                exported_at: "2026-05-31T00:00:00Z".to_string(),
            },
            items: vec![profile_item()],
        }
    }

    #[test]
    fn plan_item_marks_downloaded_source_ready_to_install() {
        let item = profile_item();
        let library = vec![library_entry("storage-1", "Author/Example", Runtime::Mono)];
        let planned = plan_item(item, None, &library, None);

        assert_eq!(planned.status, ModProfileImportStatus::ReadyToInstall);
        assert_eq!(planned.resolved_storage_id.as_deref(), Some("storage-1"));
    }

    #[test]
    fn export_managed_mod_items_uses_live_installed_snapshot() {
        let env = Environment {
            id: "env-1".to_string(),
            name: "IL2CPP".to_string(),
            description: None,
            app_id: PROFILE_GAME_ID.to_string(),
            branch: "main".to_string(),
            output_dir: String::new(),
            runtime: Runtime::Il2cpp,
            status: crate::types::EnvironmentStatus::Completed,
            last_updated: None,
            size: None,
            last_manifest_id: None,
            last_update_check: None,
            update_available: None,
            remote_manifest_id: None,
            remote_build_id: None,
            current_game_version: None,
            update_game_version: None,
            melon_loader_version: None,
            steamapps_dir: None,
            steam_manifest_path: None,
            environment_type: None,
        };
        let mut visible_entry = library_entry("visible-storage", "Author/Visible", Runtime::Il2cpp);
        visible_entry.display_name = "Visible Mod".to_string();
        let mut stale_entry = library_entry("stale-storage", "Author/Stale", Runtime::Il2cpp);
        stale_entry.display_name = "Stale Library Mod".to_string();
        stale_entry.installed_in = vec![env.id.clone()];
        let installed_mods = serde_json::json!({
            "mods": [{
                "name": "Visible Mod",
                "fileName": "Visible.dll",
                "managed": true,
                "modStorageId": "visible-storage"
            }],
            "count": 1
        });

        let items = build_managed_mod_items(&env, &[visible_entry, stale_entry], &installed_mods);

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "Visible Mod");
        assert_eq!(items[0].storage_id.as_deref(), Some("visible-storage"));
    }

    #[test]
    fn plan_item_blocks_runtime_mismatch_before_install() {
        let item = profile_item();
        let env = Environment {
            id: "env-1".to_string(),
            name: "IL2CPP".to_string(),
            description: None,
            app_id: PROFILE_GAME_ID.to_string(),
            branch: "main".to_string(),
            output_dir: String::new(),
            runtime: Runtime::Il2cpp,
            status: crate::types::EnvironmentStatus::Completed,
            last_updated: None,
            size: None,
            last_manifest_id: None,
            last_update_check: None,
            update_available: None,
            remote_manifest_id: None,
            remote_build_id: None,
            current_game_version: None,
            update_game_version: None,
            melon_loader_version: None,
            steamapps_dir: None,
            steam_manifest_path: None,
            environment_type: None,
        };

        let planned = plan_item(item, Some(&env), &[], None);

        assert_eq!(planned.status, ModProfileImportStatus::RuntimeMismatch);
    }

    #[test]
    fn plan_item_marks_local_mod_manual() {
        let mut item = profile_item();
        item.source = Some(ModSource::Local);
        item.source_id = None;

        let planned = plan_item(item, None, &[], None);

        assert_eq!(planned.status, ModProfileImportStatus::ManualRequired);
    }

    #[tokio::test]
    async fn profile_file_round_trips_manifest() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let pool = Arc::new(SqlitePool::connect(":memory:").await?);
        let service = ModProfilesService::new(pool);
        let path = temp.path().join("coop-profile.json");
        let manifest = profile_manifest();

        service
            .save_manifest_to_file(manifest.clone(), path.clone())
            .await?;
        let loaded = service.read_manifest_from_file(path).await?;

        assert_eq!(loaded.profile.name, "Co-op");
        assert_eq!(loaded.items.len(), 1);
        assert_eq!(loaded.items[0].name, "Example");
        Ok(())
    }
}
