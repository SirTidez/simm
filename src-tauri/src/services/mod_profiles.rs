use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::services::environment::EnvironmentService;
use crate::services::mods::ModsService;
use crate::services::plugins::PluginsService;
use crate::services::userlibs::UserLibsService;
use crate::types::{
    Environment, ModLibraryEntry, ModProfileApplyRequest, ModProfileApplyResult,
    ModProfileCaptureRequest, ModProfileExportRequest, ModProfileImportPlan,
    ModProfileImportPlanItem, ModProfileImportStatus, ModProfileImportSummary, ModProfileInfo,
    ModProfileItem, ModProfileItemType, ModProfileManifest, ModProfileSaveRequest, ModSource,
    Runtime, Settings, StoredModProfile,
};

const PROFILE_KIND: &str = "simm.profile";
const PROFILE_SCHEMA_VERSION: u32 = 1;
const PROFILE_GAME_ID: &str = "schedule-i";
const NEXUS_FILE_ID_TAG_PREFIX: &str = "nexus-file-id:";
const DEFAULT_IL2CPP_PROFILE_ID: &str = "default-il2cpp";
const DEFAULT_MONO_PROFILE_ID: &str = "default-mono";

pub struct ModProfilesService {
    pool: Arc<SqlitePool>,
    // Profile work can traverse the shared mod library. Managed command paths
    // supply this public-settings snapshot so those traversals do not fall
    // back to a durable settings read.
    runtime_settings: Option<Settings>,
}

#[derive(Debug, Default)]
pub struct RuntimeModSwitchSummary {
    pub disabled_items: usize,
    pub installed_items: usize,
    pub missing_items: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TargetEnvironmentFingerprint {
    id: String,
    output_dir: String,
    runtime: Runtime,
    branch: String,
}

impl TargetEnvironmentFingerprint {
    fn capture(environment: &Environment) -> Self {
        Self {
            id: environment.id.clone(),
            output_dir: environment.output_dir.clone(),
            runtime: environment.runtime.clone(),
            branch: environment.branch.clone(),
        }
    }

    fn matches(&self, environment: &Environment) -> bool {
        self.id == environment.id
            && self.output_dir == environment.output_dir
            && self.runtime == environment.runtime
            && self.branch == environment.branch
    }
}

impl ModProfilesService {
    pub fn new(pool: Arc<SqlitePool>) -> Self {
        Self {
            pool,
            runtime_settings: None,
        }
    }

    pub fn with_runtime_settings(mut self, settings: Settings) -> Self {
        self.runtime_settings = Some(settings);
        self
    }

    fn mods_service(&self) -> ModsService {
        let service = ModsService::new(self.pool.clone());
        match &self.runtime_settings {
            Some(settings) => service.with_runtime_settings(settings.clone()),
            // Direct service construction is retained for focused tests and
            // non-Tauri callers. It is not used by managed command paths.
            None => service,
        }
    }

    /// Disable the active items captured from the previous runtime, then install
    /// explicitly downloaded counterparts for the environment's new runtime.
    /// Unknown or runtime-ambiguous library entries are never crossed over.
    pub async fn switch_environment_runtime_items(
        &self,
        previous_manifest: ModProfileManifest,
        target_environment: &Environment,
    ) -> RuntimeModSwitchSummary {
        let mut summary = RuntimeModSwitchSummary::default();
        let mods_service = self.mods_service();
        let library = match mods_service.get_mod_library().await {
            Ok(library) => library.downloaded,
            Err(error) => {
                summary.errors.push(format!(
                    "Could not inspect the mod library for runtime counterparts: {}",
                    error
                ));
                Vec::new()
            }
        };

        let mut installs: HashMap<String, Vec<String>> = HashMap::new();
        for item in previous_manifest
            .items
            .into_iter()
            .filter(|item| item.enabled)
        {
            match toggle_profile_item(self.pool.clone(), target_environment, &item, false).await {
                Ok(()) => summary.disabled_items += 1,
                Err(error) => summary.errors.push(format!(
                    "Could not disable {} before the runtime switch: {}",
                    item.name, error
                )),
            }

            match resolve_runtime_switch_storage_id(&library, &item, &target_environment.runtime) {
                Some(storage_id) => installs.entry(storage_id).or_default().push(item.name),
                None => summary.missing_items.push(item.name),
            }
        }

        for (storage_id, item_names) in installs {
            match mods_service
                .install_storage_mod_to_envs(&storage_id, vec![target_environment.id.clone()])
                .await
            {
                Ok(_) => summary.installed_items += item_names.len(),
                Err(error) => {
                    summary.missing_items.extend(item_names.iter().cloned());
                    summary.errors.push(format!(
                        "Could not install {} for the new runtime: {}",
                        item_names.join(", "),
                        error
                    ));
                }
            }
        }

        summary
            .missing_items
            .sort_by_key(|name| name.to_ascii_lowercase());
        summary
            .missing_items
            .dedup_by(|left, right| left.eq_ignore_ascii_case(right));
        summary
    }

    pub async fn export_environment_profile(
        &self,
        environment_id: &str,
    ) -> Result<ModProfileManifest> {
        self.export_environment_profile_with_options(environment_id, false)
            .await
    }

    pub async fn export_environment_profile_with_options(
        &self,
        environment_id: &str,
        include_disabled: bool,
    ) -> Result<ModProfileManifest> {
        let env_service = EnvironmentService::new(self.pool.clone())?;
        let environment = env_service
            .get_environment(environment_id)
            .await?
            .ok_or_else(|| anyhow!("Environment not found"))?;

        let mods_service = self.mods_service();
        let installed_mods = mods_service
            .list_mods(&environment.output_dir)
            .await
            .context("Failed to list installed mods for profile export")?;
        let library = mods_service
            .get_mod_library()
            .await
            .context("Failed to load mod library for profile export")?;

        let mut items = build_managed_mod_items(
            &environment,
            &library.downloaded,
            &installed_mods,
            include_disabled,
        );
        items.extend(build_unmanaged_mod_items(
            &environment,
            &installed_mods,
            include_disabled,
        ));
        items.extend(
            build_plugin_items(
                self.pool.clone(),
                &environment,
                &library.downloaded,
                include_disabled,
            )
            .await?,
        );
        items.extend(
            build_userlib_items(&environment, &library.downloaded, include_disabled).await?,
        );

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
            profile_id: None,
            is_default: None,
            created_at: None,
            updated_at: None,
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

    pub async fn list_profiles(&self) -> Result<Vec<StoredModProfile>> {
        self.ensure_default_profiles().await?;
        let rows = sqlx::query_as::<_, (String, String, String, i64, String, String, String)>(
            "SELECT id, name, runtime, is_default, manifest, created_at, updated_at \
             FROM profiles ORDER BY runtime, is_default DESC, name COLLATE NOCASE",
        )
        .fetch_all(self.pool.as_ref())
        .await
        .context("Failed to list profiles")?;

        let active_environment_ids = self.active_environment_ids_by_profile().await?;
        rows.into_iter()
            .map(profile_from_row)
            .map(|profile| {
                profile.map(|mut profile| {
                    profile.active_environment_ids = active_environment_ids
                        .get(&profile.id)
                        .cloned()
                        .unwrap_or_default();
                    profile
                })
            })
            .collect::<Result<Vec<_>>>()
    }

    pub async fn get_profile(&self, profile_id: &str) -> Result<StoredModProfile> {
        self.ensure_default_profiles().await?;
        let row = sqlx::query_as::<_, (String, String, String, i64, String, String, String)>(
            "SELECT id, name, runtime, is_default, manifest, created_at, updated_at \
             FROM profiles WHERE id = ?",
        )
        .bind(profile_id)
        .fetch_optional(self.pool.as_ref())
        .await
        .context("Failed to load profile")?
        .ok_or_else(|| anyhow!("Profile not found"))?;
        let mut profile = profile_from_row(row)?;
        profile.active_environment_ids =
            self.active_environment_ids_for_profile(profile_id).await?;
        Ok(profile)
    }

    pub async fn save_profile(&self, request: ModProfileSaveRequest) -> Result<StoredModProfile> {
        self.ensure_default_profiles().await?;
        validate_manifest(&request.manifest)?;
        if request.manifest.profile.runtime != request.runtime {
            return Err(anyhow!("Profile runtime does not match manifest runtime"));
        }
        let id = request
            .profile_id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("profile-{}", Uuid::new_v4().simple()));
        let now = Utc::now().to_rfc3339();
        let created_at =
            sqlx::query_scalar::<_, String>("SELECT created_at FROM profiles WHERE id = ?")
                .bind(&id)
                .fetch_optional(self.pool.as_ref())
                .await?
                .unwrap_or_else(|| now.clone());
        let mut manifest = request.manifest;
        manifest.profile_id = Some(id.clone());
        manifest.is_default = Some(false);
        manifest.created_at = Some(created_at.clone());
        manifest.updated_at = Some(now.clone());
        manifest.profile.name = request.name.clone();
        manifest.profile.runtime = request.runtime.clone();
        normalize_profile_items(&mut manifest, Some(&request.runtime));
        let manifest_json = serde_json::to_string(&manifest)?;
        sqlx::query(
            "INSERT INTO profiles (id, name, runtime, is_default, manifest, created_at, updated_at) \
             VALUES (?, ?, ?, 0, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET \
             name = excluded.name, runtime = excluded.runtime, manifest = excluded.manifest, updated_at = excluded.updated_at",
        )
        .bind(&id)
        .bind(&request.name)
        .bind(runtime_key(&request.runtime))
        .bind(manifest_json)
        .bind(&created_at)
        .bind(&now)
        .execute(self.pool.as_ref())
        .await
        .context("Failed to save profile")?;

        self.get_profile(&id).await
    }

    pub async fn capture_profile(
        &self,
        request: ModProfileCaptureRequest,
    ) -> Result<StoredModProfile> {
        let mut manifest = self
            .export_environment_profile_with_options(
                &request.environment_id,
                request.include_disabled,
            )
            .await?;
        let runtime = manifest.profile.runtime.clone();
        let name = request
            .name
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| manifest.profile.name.clone());
        manifest.profile.name = name.clone();
        self.save_profile(ModProfileSaveRequest {
            profile_id: request.profile_id,
            name,
            runtime,
            manifest,
        })
        .await
    }

    pub async fn import_profile_manifest(
        &self,
        mut manifest: ModProfileManifest,
    ) -> Result<StoredModProfile> {
        self.ensure_default_profiles().await?;
        validate_manifest(&manifest)?;
        let runtime = manifest.profile.runtime.clone();
        normalize_profile_items(&mut manifest, Some(&runtime));
        self.save_profile(ModProfileSaveRequest {
            profile_id: None,
            name: manifest.profile.name.clone(),
            runtime,
            manifest,
        })
        .await
    }

    pub async fn export_profile_manifest(
        &self,
        request: ModProfileExportRequest,
    ) -> Result<ModProfileManifest> {
        let profile = self.get_profile(&request.profile_id).await?;
        let mut manifest = profile.manifest;
        if !request.include_disabled {
            manifest.items.retain(|item| item.enabled);
        }
        manifest.profile_id = Some(profile.id);
        manifest.is_default = Some(profile.is_default);
        manifest.created_at = Some(profile.created_at);
        manifest.updated_at = Some(profile.updated_at);
        Ok(manifest)
    }

    pub async fn delete_profile(&self, profile_id: &str) -> Result<()> {
        self.ensure_default_profiles().await?;
        let profile = self.get_profile(profile_id).await?;
        if profile.is_default {
            return Err(anyhow!("Default runtime profiles cannot be deleted"));
        }
        let active_environment_ids = self.active_environment_ids_for_profile(profile_id).await?;
        if !active_environment_ids.is_empty() {
            return Err(anyhow!(
                "Profile is active in {} environment(s) and cannot be deleted until another profile is applied",
                active_environment_ids.len()
            ));
        }
        sqlx::query("DELETE FROM profiles WHERE id = ?")
            .bind(profile_id)
            .execute(self.pool.as_ref())
            .await
            .context("Failed to delete profile")?;
        Ok(())
    }

    pub async fn preview_profile_apply(
        &self,
        profile_id: &str,
        target_environment_id: String,
    ) -> Result<ModProfileImportPlan> {
        let profile = self.get_profile(profile_id).await?;
        self.preview_import(profile.manifest, Some(target_environment_id))
            .await
    }

    pub async fn preview_import(
        &self,
        mut manifest: ModProfileManifest,
        target_environment_id: Option<String>,
    ) -> Result<ModProfileImportPlan> {
        validate_manifest(&manifest)?;
        let manifest_runtime = manifest.profile.runtime.clone();
        normalize_profile_items(&mut manifest, Some(&manifest_runtime));
        let target_environment = self
            .load_target_environment(target_environment_id.as_deref())
            .await?;
        let mods_service = self.mods_service();
        let library = mods_service.get_mod_library().await?;
        let installed_snapshot = if let Some(environment) = target_environment.as_ref() {
            Some(build_installed_snapshot(self.pool.clone(), &mods_service, environment).await?)
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
                installed_snapshot.as_ref(),
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
        let target_environment = self
            .load_target_environment(Some(&target_environment_id))
            .await?
            .ok_or_else(|| anyhow!("Target environment not found"))?;
        let target_fingerprint = TargetEnvironmentFingerprint::capture(&target_environment);
        if request.manifest.profile.runtime != target_environment.runtime {
            return Err(anyhow!(
                "Profile runtime {:?} cannot be applied to {:?} environment",
                request.manifest.profile.runtime,
                target_environment.runtime
            ));
        }
        let plan = self
            .preview_import(request.manifest, Some(target_environment_id.clone()))
            .await?;
        self.revalidate_target_environment(&target_fingerprint)
            .await?;
        let mods_service = self.mods_service();
        let mut installed = 0usize;
        let mut skipped = 0usize;
        let mut unresolved = 0usize;
        let mut messages = Vec::new();

        let mut installed_storage_ids = HashSet::new();
        for item in &plan.items {
            match item.status {
                ModProfileImportStatus::ReadyToInstall => {
                    if let Some(storage_id) = item.resolved_storage_id.as_deref() {
                        if installed_storage_ids.insert(storage_id.to_string()) {
                            self.revalidate_target_environment(&target_fingerprint)
                                .await?;
                            match mods_service
                                .install_storage_mod_to_envs(
                                    storage_id,
                                    vec![target_environment_id.clone()],
                                )
                                .await
                            {
                                Ok(_) => installed += 1,
                                Err(error) => {
                                    unresolved += 1;
                                    messages.push(format!(
                                        "{}: failed to install into the frozen target: {}",
                                        item.item.name, error
                                    ));
                                }
                            }
                        } else {
                            skipped += 1;
                        }
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

        let toggle_errors = self
            .sync_profile_enabled_state(&target_environment, &plan)
            .await?;
        unresolved += toggle_errors.len();
        messages.extend(toggle_errors);
        self.revalidate_target_environment(&target_fingerprint)
            .await?;

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

    pub async fn apply_profile(
        &self,
        profile_id: &str,
        target_environment_id: String,
    ) -> Result<ModProfileApplyResult> {
        let target_environment = self
            .load_target_environment(Some(&target_environment_id))
            .await?
            .ok_or_else(|| anyhow!("Target environment not found"))?;
        let target_fingerprint = TargetEnvironmentFingerprint::capture(&target_environment);
        let profile = self.get_profile(profile_id).await?;
        let mut request = ModProfileApplyRequest {
            manifest: profile.manifest,
            target_environment_id: target_environment_id.clone(),
        };
        request.manifest.profile_id = Some(profile.id.clone());
        let result = self.apply_import(request).await?;
        self.revalidate_target_environment(&target_fingerprint)
            .await?;
        self.set_environment_active_profile(&target_environment_id, &profile.id)
            .await?;
        Ok(result)
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

    /// Protects the final profile mutations from a target whose runtime,
    /// branch, or materialization path changed after the preview was built.
    async fn revalidate_target_environment(
        &self,
        expected: &TargetEnvironmentFingerprint,
    ) -> Result<()> {
        let actual = self
            .load_target_environment(Some(&expected.id))
            .await?
            .ok_or_else(|| anyhow!("Target environment not found"))?;
        if !expected.matches(&actual) {
            return Err(anyhow!(
                "Profile target changed while the operation was in flight; retry against the current environment"
            ));
        }
        Ok(())
    }

    async fn set_environment_active_profile(
        &self,
        environment_id: &str,
        profile_id: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO environment_profiles (environment_id, active_profile_id, last_applied_at) \
             VALUES (?, ?, ?) \
             ON CONFLICT(environment_id) DO UPDATE SET \
             active_profile_id = excluded.active_profile_id, last_applied_at = excluded.last_applied_at",
        )
        .bind(environment_id)
        .bind(profile_id)
        .bind(Utc::now().to_rfc3339())
        .execute(self.pool.as_ref())
        .await
        .context("Failed to update active profile")?;
        Ok(())
    }

    async fn active_environment_ids_by_profile(&self) -> Result<HashMap<String, Vec<String>>> {
        let rows = sqlx::query_as::<_, (String, String)>(
            "SELECT active_profile_id, environment_id FROM environment_profiles",
        )
        .fetch_all(self.pool.as_ref())
        .await
        .context("Failed to query active profile environments")?;

        let mut by_profile: HashMap<String, Vec<String>> = HashMap::new();
        for (profile_id, environment_id) in rows {
            by_profile
                .entry(profile_id)
                .or_default()
                .push(environment_id);
        }
        Ok(by_profile)
    }

    async fn active_environment_ids_for_profile(&self, profile_id: &str) -> Result<Vec<String>> {
        sqlx::query_scalar::<_, String>(
            "SELECT environment_id FROM environment_profiles WHERE active_profile_id = ?",
        )
        .bind(profile_id)
        .fetch_all(self.pool.as_ref())
        .await
        .context("Failed to query active profile environments")
    }

    pub async fn sync_active_profile_from_environment(&self, environment_id: &str) -> Result<()> {
        self.ensure_default_profiles().await?;
        let env_service = EnvironmentService::new(self.pool.clone())?;
        let environment = env_service
            .get_environment(environment_id)
            .await?
            .ok_or_else(|| anyhow!("Environment not found"))?;
        let active_profile_id = sqlx::query_scalar::<_, String>(
            "SELECT active_profile_id FROM environment_profiles WHERE environment_id = ?",
        )
        .bind(environment_id)
        .fetch_optional(self.pool.as_ref())
        .await?
        .unwrap_or_else(|| default_profile_id(&environment.runtime).to_string());
        let profile = self.get_profile(&active_profile_id).await?;
        self.capture_profile(ModProfileCaptureRequest {
            environment_id: environment_id.to_string(),
            name: Some(profile.name),
            profile_id: Some(active_profile_id),
            include_disabled: true,
        })
        .await?;
        Ok(())
    }

    async fn ensure_default_profiles(&self) -> Result<()> {
        let env_service = EnvironmentService::new(self.pool.clone())?;
        let environments = env_service.get_environments().await.unwrap_or_default();
        for runtime in [Runtime::Il2cpp, Runtime::Mono] {
            let default_id = default_profile_id(&runtime);
            let existing: Option<String> =
                sqlx::query_scalar("SELECT id FROM profiles WHERE id = ?")
                    .bind(default_id)
                    .fetch_optional(self.pool.as_ref())
                    .await?;
            if existing.is_none() {
                let mut manifest = self.seed_default_manifest(&runtime, &environments).await?;
                let now = Utc::now().to_rfc3339();
                manifest.profile_id = Some(default_id.to_string());
                manifest.is_default = Some(true);
                manifest.created_at = Some(now.clone());
                manifest.updated_at = Some(now.clone());
                let name = default_profile_name(&runtime).to_string();
                let manifest_json = serde_json::to_string(&manifest)?;
                sqlx::query(
                    "INSERT INTO profiles (id, name, runtime, is_default, manifest, created_at, updated_at) \
                     VALUES (?, ?, ?, 1, ?, ?, ?)",
                )
                .bind(default_id)
                .bind(name)
                .bind(runtime_key(&runtime))
                .bind(manifest_json)
                .bind(&now)
                .bind(&now)
                .execute(self.pool.as_ref())
                .await
                .context("Failed to seed default profile")?;
            }

            for environment in environments.iter().filter(|env| env.runtime == runtime) {
                sqlx::query(
                    "INSERT INTO environment_profiles (environment_id, active_profile_id, last_applied_at) \
                     VALUES (?, ?, NULL) \
                     ON CONFLICT(environment_id) DO NOTHING",
                )
                .bind(&environment.id)
                .bind(default_id)
                .execute(self.pool.as_ref())
                .await?;
            }
        }
        Ok(())
    }

    async fn seed_default_manifest(
        &self,
        runtime: &Runtime,
        environments: &[Environment],
    ) -> Result<ModProfileManifest> {
        let mut items = Vec::new();
        let mut seen = HashSet::new();
        for environment in environments.iter().filter(|env| &env.runtime == runtime) {
            if environment.output_dir.is_empty() {
                continue;
            }
            let manifest = self
                .export_environment_profile_with_options(&environment.id, true)
                .await
                .unwrap_or_else(|_| {
                    empty_profile_manifest(default_profile_name(runtime), runtime.clone())
                });
            for mut item in manifest.items {
                item.runtime = Some(runtime.clone());
                let key = profile_item_identity(&item);
                if seen.insert(key) {
                    items.push(item);
                }
            }
        }

        let mut manifest = empty_profile_manifest(default_profile_name(runtime), runtime.clone());
        manifest.items = items;
        Ok(manifest)
    }

    async fn sync_profile_enabled_state(
        &self,
        environment: &Environment,
        plan: &ModProfileImportPlan,
    ) -> Result<Vec<String>> {
        let mods_service = self.mods_service();
        let snapshot =
            build_installed_snapshot(self.pool.clone(), &mods_service, environment).await?;
        let desired: HashMap<String, bool> = plan
            .items
            .iter()
            .filter(|item| {
                item.status == ModProfileImportStatus::AlreadyInstalled
                    || item.status == ModProfileImportStatus::ReadyToInstall
            })
            .map(|item| (profile_item_identity(&item.item), item.item.enabled))
            .collect();

        let mut errors = Vec::new();
        for item in &plan.items {
            if desired.contains_key(&profile_item_identity(&item.item)) {
                if let Err(error) = toggle_profile_item(
                    self.pool.clone(),
                    environment,
                    &item.item,
                    item.item.enabled,
                )
                .await
                {
                    errors.push(format!(
                        "{}: failed to {}: {}",
                        profile_item_error_label(&item.item),
                        if item.item.enabled {
                            "enable"
                        } else {
                            "disable"
                        },
                        error
                    ));
                }
            }
        }

        for installed in installed_snapshot_items(&snapshot, &environment.runtime) {
            let key = profile_item_identity(&installed);
            if !desired.contains_key(&key) && installed.enabled {
                if let Err(error) =
                    toggle_profile_item(self.pool.clone(), environment, &installed, false).await
                {
                    errors.push(format!(
                        "{}: failed to disable: {}",
                        profile_item_error_label(&installed),
                        error
                    ));
                }
            }
        }
        Ok(errors)
    }
}

fn profile_from_row(
    row: (String, String, String, i64, String, String, String),
) -> Result<StoredModProfile> {
    let (id, name, runtime, is_default, manifest_json, created_at, updated_at) = row;
    let runtime = parse_runtime_key(&runtime)?;
    let mut manifest: ModProfileManifest = serde_json::from_str(&manifest_json)
        .with_context(|| format!("Failed to parse stored profile {}", id))?;
    manifest.profile_id = Some(id.clone());
    manifest.is_default = Some(is_default != 0);
    manifest.created_at = Some(created_at.clone());
    manifest.updated_at = Some(updated_at.clone());
    normalize_profile_items(&mut manifest, Some(&runtime));
    Ok(StoredModProfile {
        id,
        name,
        runtime,
        is_default: is_default != 0,
        active_environment_ids: Vec::new(),
        manifest,
        created_at,
        updated_at,
    })
}

fn empty_profile_manifest(name: &str, runtime: Runtime) -> ModProfileManifest {
    ModProfileManifest {
        schema_version: PROFILE_SCHEMA_VERSION,
        kind: PROFILE_KIND.to_string(),
        profile_id: None,
        is_default: None,
        created_at: None,
        updated_at: None,
        profile: ModProfileInfo {
            name: name.to_string(),
            game: PROFILE_GAME_ID.to_string(),
            environment_id: None,
            runtime,
            branch: "any".to_string(),
            game_version: None,
            exported_at: Utc::now().to_rfc3339(),
        },
        items: Vec::new(),
    }
}

fn default_profile_id(runtime: &Runtime) -> &'static str {
    match runtime {
        Runtime::Il2cpp => DEFAULT_IL2CPP_PROFILE_ID,
        Runtime::Mono => DEFAULT_MONO_PROFILE_ID,
    }
}

fn default_profile_name(runtime: &Runtime) -> &'static str {
    match runtime {
        Runtime::Il2cpp => "Default IL2CPP",
        Runtime::Mono => "Default Mono",
    }
}

fn parse_runtime_key(value: &str) -> Result<Runtime> {
    match value.to_ascii_uppercase().as_str() {
        "IL2CPP" => Ok(Runtime::Il2cpp),
        "MONO" => Ok(Runtime::Mono),
        other => Err(anyhow!("Unsupported profile runtime {}", other)),
    }
}

fn normalize_profile_items(manifest: &mut ModProfileManifest, runtime: Option<&Runtime>) {
    for item in &mut manifest.items {
        if item.runtime.is_none() {
            item.runtime = runtime.cloned();
        }
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
    include_disabled: bool,
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
        .filter(|mod_value| include_disabled || !is_disabled(mod_value))
        .filter_map(|mod_value| {
            let enabled = !is_disabled(mod_value);
            let storage_id = read_string(mod_value, "modStorageId")?;
            let entry = library.iter().find(|entry| entry.storage_id == storage_id);
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
    include_disabled: bool,
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
        .filter(|mod_value| include_disabled || !is_disabled(mod_value))
        .map(|mod_value| {
            let enabled = !is_disabled(mod_value);
            let name = read_string(mod_value, "name")
                .or_else(|| read_string(mod_value, "fileName"))
                .unwrap_or_else(|| "Local mod".to_string());
            ModProfileItem {
                item_type: ModProfileItemType::Mod,
                name,
                file_name: read_string(mod_value, "fileName"),
                required: true,
                enabled,
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
    library: &[ModLibraryEntry],
    include_disabled: bool,
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
        .filter(|plugin| include_disabled || !is_disabled(plugin))
        .map(|plugin| {
            let enabled = !is_disabled(plugin);
            let name = read_string(plugin, "name")
                .or_else(|| read_string(plugin, "fileName"))
                .unwrap_or_else(|| "Plugin".to_string());
            let file_name = read_string(plugin, "fileName");
            let entry = file_name.as_deref().and_then(|file_name| {
                library_entry_for_exported_file(
                    library,
                    ModProfileItemType::Plugin,
                    file_name,
                    environment,
                )
            });
            ModProfileItem {
                item_type: ModProfileItemType::Plugin,
                name,
                file_name,
                required: true,
                enabled,
                source: entry.and_then(|entry| entry.source.clone()).or_else(|| {
                    plugin
                        .get("source")
                        .cloned()
                        .and_then(|value| serde_json::from_value(value).ok())
                }),
                source_id: entry.and_then(|entry| entry.source_id.clone()),
                source_version: entry
                    .and_then(library_entry_source_version)
                    .or_else(|| read_string(plugin, "version")),
                source_url: entry.and_then(|entry| entry.source_url.clone()),
                runtime: Some(environment.runtime.clone()),
                storage_id: entry
                    .and_then(|entry| storage_id_for_runtime(entry, &environment.runtime)),
                nexus_file_id: None,
                manual_reason: entry
                    .is_none()
                    .then(|| "Plugin sync is exported as a manual checklist item.".to_string()),
            }
        })
        .collect())
}

async fn build_userlib_items(
    environment: &Environment,
    library: &[ModLibraryEntry],
    include_disabled: bool,
) -> Result<Vec<ModProfileItem>> {
    let userlibs = UserLibsService::new()
        .list_user_libs(&environment.output_dir)
        .await
        .context("Failed to list UserLibs for profile export")?;
    Ok(userlibs
        .get("userLibs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|userlib| include_disabled || !is_disabled(userlib))
        .map(|userlib| {
            let enabled = !is_disabled(userlib);
            let name = read_string(userlib, "name")
                .or_else(|| read_string(userlib, "fileName"))
                .unwrap_or_else(|| "UserLib".to_string());
            let file_name = read_string(userlib, "fileName");
            let entry = file_name.as_deref().and_then(|file_name| {
                library_entry_for_exported_file(
                    library,
                    ModProfileItemType::Userlib,
                    file_name,
                    environment,
                )
            });
            ModProfileItem {
                item_type: ModProfileItemType::Userlib,
                name,
                file_name,
                required: true,
                enabled,
                source: entry
                    .and_then(|entry| entry.source.clone())
                    .or(Some(ModSource::Local)),
                source_id: entry.and_then(|entry| entry.source_id.clone()),
                source_version: entry.and_then(library_entry_source_version),
                source_url: entry.and_then(|entry| entry.source_url.clone()),
                runtime: Some(environment.runtime.clone()),
                storage_id: entry
                    .and_then(|entry| storage_id_for_runtime(entry, &environment.runtime)),
                nexus_file_id: None,
                manual_reason: entry
                    .is_none()
                    .then(|| "UserLib sync is exported as a manual checklist item.".to_string()),
            }
        })
        .collect())
}

async fn build_installed_snapshot(
    pool: Arc<SqlitePool>,
    mods_service: &ModsService,
    environment: &Environment,
) -> Result<Value> {
    let mut snapshot = mods_service.list_mods(&environment.output_dir).await?;
    if let Some(object) = snapshot.as_object_mut() {
        let plugins = PluginsService::new(pool)
            .list_plugins(&environment.output_dir)
            .await
            .context("Failed to list installed plugins for profile import preview")?;
        let userlibs = UserLibsService::new()
            .list_user_libs(&environment.output_dir)
            .await
            .context("Failed to list installed UserLibs for profile import preview")?;
        object.insert(
            "plugins".to_string(),
            plugins
                .get("plugins")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new())),
        );
        object.insert(
            "userLibs".to_string(),
            userlibs
                .get("userLibs")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new())),
        );
    }
    Ok(snapshot)
}

fn plan_item(
    item: ModProfileItem,
    target_environment: Option<&Environment>,
    library: &[ModLibraryEntry],
    installed_mods: Option<&Value>,
) -> ModProfileImportPlanItem {
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

    if let Some(storage_id) =
        installed_storage_id(installed_mods, library, target_environment, &item)
    {
        return ModProfileImportPlanItem {
            item,
            status: ModProfileImportStatus::AlreadyInstalled,
            resolved_storage_id: Some(storage_id),
            message: "Already installed in the target environment.".to_string(),
        };
    }

    if is_unmanaged_profile_item(&item)
        && installed_mods.is_some_and(|snapshot| installed_profile_file_present(snapshot, &item))
    {
        return ModProfileImportPlanItem {
            item,
            status: ModProfileImportStatus::AlreadyInstalled,
            resolved_storage_id: None,
            message: "Unmanaged profile item is already present in the target environment."
                .to_string(),
        };
    }

    let resolved = resolve_library_storage_id(library, &item);
    if resolved.is_none()
        && matches!(
            item.source,
            Some(ModSource::Local) | Some(ModSource::Unknown) | None
        )
        && item.source_id.is_none()
        && item.storage_id.is_none()
    {
        return ModProfileImportPlanItem {
            item,
            status: ModProfileImportStatus::ManualRequired,
            resolved_storage_id: None,
            message: "This profile item is not linked to a downloadable source.".to_string(),
        };
    }

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

fn installed_storage_id(
    installed_mods: Option<&Value>,
    library: &[ModLibraryEntry],
    target_environment: Option<&Environment>,
    item: &ModProfileItem,
) -> Option<String> {
    let installed_mods = installed_mods?;
    if let Some(storage_id) = installed_mods
        .get("mods")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find_map(|mod_value| {
            let storage_id = read_string(mod_value, "modStorageId")?;
            let same_storage_id = item
                .storage_id
                .as_ref()
                .map(|expected| expected == &storage_id)
                .unwrap_or(false);
            if same_storage_id
                && (installed_mod_value_matches_item(mod_value, item)
                    || library.iter().any(|entry| {
                        library_entry_storage_id_matches(entry, &storage_id)
                            && library_entry_profile_identity_matches(entry, item)
                    }))
            {
                return Some(storage_id);
            }
            let same_source = item.source_id.as_ref().is_some_and(|source_id| {
                read_string(mod_value, "sourceId")
                    .as_ref()
                    .map(|value| value.eq_ignore_ascii_case(source_id))
                    .unwrap_or(false)
            });
            if same_source && installed_mod_value_matches_item(mod_value, item) {
                Some(storage_id)
            } else {
                None
            }
        })
    {
        return Some(storage_id);
    }

    if installed_profile_file_present(installed_mods, item) {
        if let Some(storage_id) = resolve_library_storage_id(library, item) {
            return Some(storage_id);
        }
    }

    if let Some(environment) = target_environment {
        if let Some(storage_id) = installed_library_storage_id(library, environment, item) {
            return Some(storage_id);
        }
    }

    None
}

fn profile_item_identity(item: &ModProfileItem) -> String {
    let path = normalize_managed_relative_identity(
        item.file_name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(item.name.as_str()),
    );
    let runtime = item
        .runtime
        .as_ref()
        .map(Runtime::canonical_label)
        .unwrap_or("any");
    let storage = item
        .storage_id
        .as_deref()
        .or(item.source_id.as_deref())
        .unwrap_or("unmanaged")
        .trim()
        .to_ascii_lowercase();
    format!("{:?}:{runtime}:{storage}:{path}", item.item_type)
}

fn profile_item_error_label(item: &ModProfileItem) -> String {
    let Some(file_name) = item
        .file_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return item.name.clone();
    };
    if file_name.eq_ignore_ascii_case(&item.name) {
        item.name.clone()
    } else {
        format!("{} ({})", item.name, file_name)
    }
}

fn installed_snapshot_items(snapshot: &Value, runtime: &Runtime) -> Vec<ModProfileItem> {
    let mut items = Vec::new();
    collect_installed_snapshot_items(
        snapshot,
        "mods",
        ModProfileItemType::Mod,
        runtime,
        &mut items,
    );
    collect_installed_snapshot_items(
        snapshot,
        "plugins",
        ModProfileItemType::Plugin,
        runtime,
        &mut items,
    );
    collect_installed_snapshot_items(
        snapshot,
        "userLibs",
        ModProfileItemType::Userlib,
        runtime,
        &mut items,
    );
    items
}

fn collect_installed_snapshot_items(
    snapshot: &Value,
    collection: &str,
    item_type: ModProfileItemType,
    runtime: &Runtime,
    items: &mut Vec<ModProfileItem>,
) {
    let Some(values) = snapshot.get(collection).and_then(Value::as_array) else {
        return;
    };
    for value in values {
        let name = read_string(value, "name")
            .or_else(|| read_string(value, "fileName"))
            .unwrap_or_else(|| "Installed item".to_string());
        items.push(ModProfileItem {
            item_type: item_type.clone(),
            name,
            file_name: read_string(value, "fileName"),
            required: true,
            enabled: !is_disabled(value),
            source: value
                .get("source")
                .cloned()
                .and_then(|source| serde_json::from_value(source).ok()),
            source_id: read_string(value, "sourceId"),
            source_version: read_string(value, "version"),
            source_url: read_string(value, "sourceUrl"),
            runtime: Some(runtime.clone()),
            storage_id: read_string(value, "modStorageId"),
            nexus_file_id: None,
            manual_reason: None,
        });
    }
}

async fn toggle_profile_item(
    pool: Arc<SqlitePool>,
    environment: &Environment,
    item: &ModProfileItem,
    enabled: bool,
) -> Result<()> {
    let Some(file_name) = item
        .file_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or(Some(item.name.as_str()))
    else {
        return Ok(());
    };

    match item.item_type {
        ModProfileItemType::Mod => {
            let service = ModsService::new(pool);
            if enabled {
                service
                    .enable_mod(&environment.output_dir, file_name)
                    .await?;
            } else {
                service
                    .disable_mod(&environment.output_dir, file_name)
                    .await?;
            }
        }
        ModProfileItemType::Plugin => {
            let service = PluginsService::new(pool);
            if enabled {
                service
                    .enable_plugin(&environment.output_dir, file_name)
                    .await?;
            } else {
                service
                    .disable_plugin(&environment.output_dir, file_name)
                    .await?;
            }
        }
        ModProfileItemType::Userlib => {
            let service = UserLibsService::new();
            if enabled {
                service
                    .enable_user_lib(&environment.output_dir, file_name)
                    .await?;
            } else {
                service
                    .disable_user_lib(&environment.output_dir, file_name)
                    .await?;
            }
        }
    }

    Ok(())
}

fn installed_profile_file_present(installed_mods: &Value, item: &ModProfileItem) -> bool {
    let collection = match item.item_type {
        ModProfileItemType::Mod => "mods",
        ModProfileItemType::Plugin => "plugins",
        ModProfileItemType::Userlib => "userLibs",
    };
    let Some(item_file) = item.file_name.as_deref().or(Some(item.name.as_str())) else {
        return false;
    };
    let item_file = normalize_managed_relative_identity(item_file);
    if item_file.is_empty() {
        return false;
    }

    installed_mods
        .get(collection)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|value| {
            read_string(value, "fileName")
                .or_else(|| read_string(value, "name"))
                .map(|file_name| normalize_managed_relative_identity(&file_name) == item_file)
                .unwrap_or(false)
        })
}

fn is_unmanaged_profile_item(item: &ModProfileItem) -> bool {
    item.storage_id.is_none()
        && item.source_id.is_none()
        && matches!(
            item.source,
            Some(ModSource::Local) | Some(ModSource::Unknown) | None
        )
}

fn resolve_library_storage_id(
    library: &[ModLibraryEntry],
    item: &ModProfileItem,
) -> Option<String> {
    if let Some(storage_id) = item.storage_id.as_deref() {
        if let Some(entry) = library.iter().find(|entry| {
            library_entry_storage_id_matches(entry, storage_id)
                && library_entry_profile_identity_matches(entry, item)
        }) {
            return storage_id_for_item_runtime(entry, item);
        }
    }

    if let Some(source_id) = item.source_id.as_deref() {
        if let Some(storage_id) = library.iter().find_map(|entry| {
            let entry_source_id = entry.source_id.as_deref()?;
            if !entry_source_id.eq_ignore_ascii_case(source_id) {
                return None;
            }
            if !library_entry_source_matches(entry, item)
                || !library_entry_version_matches(entry, item)
                || !library_entry_runtime_matches(entry, item)
            {
                return None;
            }
            storage_id_for_item_runtime(entry, item)
        }) {
            return Some(storage_id);
        }
    }

    if matches!(
        item.item_type,
        ModProfileItemType::Plugin | ModProfileItemType::Userlib
    ) {
        return library.iter().find_map(|entry| {
            if !library_entry_source_matches(entry, item)
                || !library_entry_version_matches(entry, item)
                || !library_entry_runtime_matches(entry, item)
                || !library_entry_file_matches_item(entry, item)
            {
                return None;
            }
            storage_id_for_item_runtime(entry, item)
        });
    }

    None
}

fn resolve_runtime_switch_storage_id(
    library: &[ModLibraryEntry],
    item: &ModProfileItem,
    target_runtime: &Runtime,
) -> Option<String> {
    let target_key = runtime_key(target_runtime);
    library.iter().find_map(|entry| {
        if let Some(storage_id) = item.storage_id.as_deref() {
            if !library_entry_storage_id_matches(entry, storage_id) {
                return None;
            }
        } else if !library_entry_source_matches(entry, item) {
            return None;
        }
        if !library_entry_version_matches(entry, item) {
            return None;
        }
        if let Some(source_id) = item.source_id.as_deref() {
            if !entry
                .source_id
                .as_deref()
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(source_id))
            {
                return None;
            }
        } else if matches!(
            item.item_type,
            ModProfileItemType::Plugin | ModProfileItemType::Userlib
        ) && !library_entry_file_matches_item(entry, item)
        {
            return None;
        }

        entry
            .storage_ids_by_runtime
            .get(target_key)
            .cloned()
            .or_else(|| {
                entry
                    .available_runtimes
                    .iter()
                    .any(|runtime| runtime.eq_ignore_ascii_case(target_key))
                    .then(|| entry.storage_id.clone())
            })
    })
}

fn installed_library_storage_id(
    library: &[ModLibraryEntry],
    environment: &Environment,
    item: &ModProfileItem,
) -> Option<String> {
    library.iter().find_map(|entry| {
        if !library_entry_installed_in_environment(entry, environment, item)
            || !library_entry_source_matches(entry, item)
            || !library_entry_version_matches(entry, item)
            || !library_entry_runtime_matches(entry, item)
        {
            return None;
        }
        if item.source_id.is_some() {
            let item_source_id = item.source_id.as_deref()?;
            if !entry
                .source_id
                .as_deref()
                .map(|entry_source_id| entry_source_id.eq_ignore_ascii_case(item_source_id))
                .unwrap_or(false)
            {
                return None;
            }
        } else if !library_entry_file_matches_item(entry, item) {
            return None;
        }
        storage_id_for_item_runtime(entry, item)
    })
}

fn library_entry_storage_id_matches(entry: &ModLibraryEntry, storage_id: &str) -> bool {
    entry.storage_id == storage_id
        || entry
            .storage_ids_by_runtime
            .values()
            .any(|candidate| candidate == storage_id)
}

fn library_entry_profile_identity_matches(entry: &ModLibraryEntry, item: &ModProfileItem) -> bool {
    if !library_entry_source_matches(entry, item)
        || !library_entry_version_matches(entry, item)
        || !library_entry_runtime_matches(entry, item)
    {
        return false;
    }

    if let Some(source_id) = item.source_id.as_deref() {
        return entry
            .source_id
            .as_deref()
            .map(|entry_source_id| entry_source_id.eq_ignore_ascii_case(source_id))
            .unwrap_or(false);
    }

    library_entry_file_matches_item(entry, item)
}

fn library_entry_installed_in_environment(
    entry: &ModLibraryEntry,
    environment: &Environment,
    item: &ModProfileItem,
) -> bool {
    if let Some(runtime) = item.runtime.as_ref() {
        if library_entry_installed_in_environment_for_runtime(entry, environment, runtime) {
            return true;
        }
    }
    entry.installed_in.iter().any(|id| id == &environment.id)
}

fn library_entry_installed_in_environment_for_runtime(
    entry: &ModLibraryEntry,
    environment: &Environment,
    runtime: &Runtime,
) -> bool {
    let runtime_key = runtime_key(runtime);
    entry
        .installed_in_by_runtime
        .get(runtime_key)
        .is_some_and(|env_ids| env_ids.iter().any(|id| id == &environment.id))
        || entry.installed_in.iter().any(|id| id == &environment.id)
}

fn library_entry_version_matches(entry: &ModLibraryEntry, item: &ModProfileItem) -> bool {
    let Some(version) = item.source_version.as_deref() else {
        return true;
    };
    let entry_version = entry
        .source_version
        .as_deref()
        .or(entry.installed_version.as_deref());
    entry_version
        .map(|entry_version| version_eq(entry_version, version))
        .unwrap_or(false)
}

fn library_entry_runtime_matches(entry: &ModLibraryEntry, item: &ModProfileItem) -> bool {
    let Some(runtime) = item.runtime.as_ref() else {
        return true;
    };
    let runtime_key = runtime_key(runtime);
    entry.available_runtimes.is_empty()
        || entry
            .available_runtimes
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(runtime_key))
}

fn library_entry_source_matches(entry: &ModLibraryEntry, item: &ModProfileItem) -> bool {
    match item.source.as_ref() {
        Some(ModSource::Unknown) | None => true,
        Some(ModSource::Local) if item.source_id.is_none() => true,
        Some(source) => entry
            .source
            .as_ref()
            .map(|entry_source| entry_source == source)
            .unwrap_or(false),
    }
}

fn installed_mod_value_matches_item(mod_value: &Value, item: &ModProfileItem) -> bool {
    if item.item_type != ModProfileItemType::Mod {
        return false;
    }

    if let Some(source_id) = item.source_id.as_deref() {
        let Some(installed_source_id) = read_string(mod_value, "sourceId") else {
            return false;
        };
        if !installed_source_id.eq_ignore_ascii_case(source_id) {
            return false;
        }
    }

    if let Some(source) = item.source.as_ref() {
        if !matches!(source, ModSource::Unknown | ModSource::Local) {
            let Some(installed_source) = read_string(mod_value, "source") else {
                return false;
            };
            if !installed_source.eq_ignore_ascii_case(mod_source_key(source)) {
                return false;
            }
        }
    }

    if let Some(version) = item.source_version.as_deref() {
        let Some(installed_version) = read_string(mod_value, "version") else {
            return false;
        };
        if !version_eq(&installed_version, version) {
            return false;
        }
    }

    true
}

fn storage_id_for_item_runtime(entry: &ModLibraryEntry, item: &ModProfileItem) -> Option<String> {
    if let Some(runtime) = item.runtime.as_ref() {
        return storage_id_for_runtime(entry, runtime);
    }
    Some(entry.storage_id.clone())
}

fn library_entry_file_matches_item(entry: &ModLibraryEntry, item: &ModProfileItem) -> bool {
    if matches!(item.item_type, ModProfileItemType::Mod) {
        return false;
    }
    let item_file = item
        .file_name
        .as_deref()
        .unwrap_or(item.name.as_str())
        .trim();
    if item_file.is_empty() {
        return false;
    }
    library_entry_file_matches(entry, &item.item_type, item_file, item.runtime.as_ref())
}

fn library_entry_for_exported_file<'a>(
    library: &'a [ModLibraryEntry],
    item_type: ModProfileItemType,
    file_name: &str,
    environment: &Environment,
) -> Option<&'a ModLibraryEntry> {
    library.iter().find(|entry| {
        library_entry_installed_in_environment_for_runtime(entry, environment, &environment.runtime)
            && library_entry_file_matches(entry, &item_type, file_name, Some(&environment.runtime))
    })
}

fn library_entry_file_matches(
    entry: &ModLibraryEntry,
    item_type: &ModProfileItemType,
    file_name: &str,
    runtime: Option<&Runtime>,
) -> bool {
    let item_file = normalize_file_identity(file_name);
    library_entry_files_for_type(entry, item_type, runtime)
        .into_iter()
        .any(|file| normalize_file_identity(file) == item_file)
}

fn library_entry_files_for_type<'a>(
    entry: &'a ModLibraryEntry,
    item_type: &ModProfileItemType,
    runtime: Option<&Runtime>,
) -> Vec<&'a str> {
    let mut files = Vec::new();
    match item_type {
        ModProfileItemType::Plugin => {
            files.extend(entry.files.iter().map(String::as_str));
        }
        ModProfileItemType::Userlib => {
            files.extend(entry.attached_userlibs.iter().map(String::as_str));
        }
        ModProfileItemType::Mod => {}
    }

    if let Some(runtime) = runtime {
        if let Some(runtime_files) = entry.files_by_runtime.get(runtime_key(runtime)) {
            files.extend(runtime_files.iter().map(String::as_str));
        }
    }
    files
}

fn library_entry_source_version(entry: &ModLibraryEntry) -> Option<String> {
    entry
        .source_version
        .clone()
        .or_else(|| entry.installed_version.clone())
}

fn storage_id_for_runtime(entry: &ModLibraryEntry, runtime: &Runtime) -> Option<String> {
    entry
        .storage_ids_by_runtime
        .get(runtime_key(runtime))
        .cloned()
        .or_else(|| Some(entry.storage_id.clone()))
}

fn normalize_file_identity(value: &str) -> String {
    normalize_managed_relative_identity(value)
}

fn normalize_managed_relative_identity(value: &str) -> String {
    let mut parts: Vec<String> = value
        .trim()
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .map(|part| part.to_ascii_lowercase())
        .collect();
    if let Some(last) = parts.last_mut() {
        if let Some(enabled) = last.strip_suffix(".disabled") {
            *last = enabled.to_string();
        }
    }
    parts.join("/")
}

fn version_eq(left: &str, right: &str) -> bool {
    left.trim()
        .trim_start_matches('v')
        .eq_ignore_ascii_case(right.trim().trim_start_matches('v'))
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

fn is_disabled(value: &Value) -> bool {
    value
        .get("disabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn runtime_key(runtime: &Runtime) -> &'static str {
    runtime.canonical_label()
}

fn mod_source_key(source: &ModSource) -> &'static str {
    match source {
        ModSource::Local => "local",
        ModSource::Thunderstore => "thunderstore",
        ModSource::Nexusmods => "nexusmods",
        ModSource::Github => "github",
        ModSource::Unknown => "unknown",
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
        profile_id: None,
        is_default: None,
        created_at: None,
        updated_at: None,
        profile: plan.profile.clone(),
        items: plan.items.iter().map(|item| item.item.clone()).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::initialize_pool;

    struct EnvVarGuard {
        key: &'static str,
        original: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let original = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, original }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.original {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

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
            profile_id: None,
            is_default: None,
            created_at: None,
            updated_at: None,
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
    fn runtime_switch_never_reuses_a_single_runtime_library_entry() {
        let entry = library_entry("mono-storage", "Author/Example", Runtime::Mono);
        let mut item = profile_item();
        item.storage_id = Some("mono-storage".to_string());

        assert_eq!(
            resolve_runtime_switch_storage_id(&[entry], &item, &Runtime::Il2cpp),
            None
        );
    }

    #[test]
    fn runtime_switch_resolves_the_explicit_counterpart_storage_id() {
        let mut entry = library_entry("mono-storage", "Author/Example", Runtime::Mono);
        entry.available_runtimes = vec!["Mono".to_string(), "IL2CPP".to_string()];
        entry.storage_ids_by_runtime = HashMap::from([
            ("Mono".to_string(), "mono-storage".to_string()),
            ("IL2CPP".to_string(), "il2cpp-storage".to_string()),
        ]);
        let mut item = profile_item();
        item.storage_id = Some("mono-storage".to_string());

        assert_eq!(
            resolve_runtime_switch_storage_id(&[entry], &item, &Runtime::Il2cpp).as_deref(),
            Some("il2cpp-storage")
        );
    }

    #[test]
    fn profile_identity_keeps_nested_paths_runtime_and_storage_distinct() {
        let mut mono = profile_item();
        mono.file_name = Some("Mono/Shared.dll".to_string());
        mono.storage_id = Some("shared-storage".to_string());
        mono.runtime = Some(Runtime::Mono);

        let mut net35 = mono.clone();
        net35.file_name = Some("Net35/Shared.dll.disabled".to_string());
        let mut il2cpp = mono.clone();
        il2cpp.runtime = Some(Runtime::Il2cpp);

        assert_ne!(profile_item_identity(&mono), profile_item_identity(&net35));
        assert_ne!(profile_item_identity(&mono), profile_item_identity(&il2cpp));
        assert_eq!(
            normalize_managed_relative_identity("Mono\\Shared.dll.disabled"),
            "mono/shared.dll"
        );
    }

    #[test]
    fn target_fingerprint_detects_runtime_or_path_replacement() {
        let environment = test_environment(Runtime::Mono);
        let frozen = TargetEnvironmentFingerprint::capture(&environment);
        assert!(frozen.matches(&environment));

        let mut replaced = environment.clone();
        replaced.output_dir = "E:/new-target".to_string();
        assert!(!frozen.matches(&replaced));
        replaced.output_dir = environment.output_dir.clone();
        replaced.runtime = Runtime::Il2cpp;
        assert!(!frozen.matches(&replaced));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn revalidate_target_environment_rejects_a_replaced_target() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let environment_service = EnvironmentService::new(pool.clone())?;
        let environment = environment_service
            .create_environment(
                crate::types::schedule_i_config().app_id,
                "alternate".to_string(),
                temp.path().join("original").to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;
        let frozen = TargetEnvironmentFingerprint::capture(&environment);
        let mut replaced = environment;
        replaced.output_dir = temp
            .path()
            .join("replacement")
            .to_string_lossy()
            .to_string();
        environment_service.upsert_environment(&replaced).await?;

        let error = ModProfilesService::new(pool)
            .revalidate_target_environment(&frozen)
            .await
            .expect_err("a changed target must invalidate the in-flight apply");
        assert!(error.to_string().contains("target changed"));
        Ok(())
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn sync_profile_enabled_state_surfaces_each_toggle_failure() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let mut environment = test_environment(Runtime::Mono);
        environment.output_dir = temp.path().to_string_lossy().to_string();
        let service = ModProfilesService::new(initialize_pool().await?);
        let mut item = profile_item();
        item.file_name = Some("Missing.dll".to_string());
        let plan = ModProfileImportPlan {
            profile: profile_manifest().profile,
            target_environment_id: Some(environment.id.clone()),
            items: vec![ModProfileImportPlanItem {
                item,
                status: ModProfileImportStatus::AlreadyInstalled,
                resolved_storage_id: Some("missing-storage".to_string()),
                message: "fixture".to_string(),
            }],
            summary: ModProfileImportSummary::default(),
        };

        let errors = service
            .sync_profile_enabled_state(&environment, &plan)
            .await?;
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("Missing.dll"));
        Ok(())
    }

    fn test_environment(runtime: Runtime) -> Environment {
        Environment {
            id: "env-1".to_string(),
            name: "Test".to_string(),
            description: None,
            app_id: PROFILE_GAME_ID.to_string(),
            branch: "main".to_string(),
            output_dir: String::new(),
            runtime,
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
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn profiles_include_active_environment_ids() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = ModProfilesService::new(pool.clone());

        let saved = service
            .save_profile(ModProfileSaveRequest {
                profile_id: Some("profile-active".to_string()),
                name: "Active profile".to_string(),
                runtime: Runtime::Mono,
                manifest: profile_manifest(),
            })
            .await?;

        sqlx::query(
            "INSERT INTO environment_profiles (environment_id, active_profile_id, last_applied_at) VALUES (?, ?, NULL)",
        )
        .bind("env-active")
        .bind(&saved.id)
        .execute(pool.as_ref())
        .await?;

        let listed = service.list_profiles().await?;
        let listed_profile = listed
            .iter()
            .find(|profile| profile.id == saved.id)
            .expect("saved profile listed");
        assert_eq!(
            listed_profile.active_environment_ids,
            vec!["env-active".to_string()]
        );

        let loaded = service.get_profile(&saved.id).await?;
        assert_eq!(
            loaded.active_environment_ids,
            vec!["env-active".to_string()]
        );

        let delete_error = service
            .delete_profile(&saved.id)
            .await
            .expect_err("active profile deletion should be rejected");
        assert!(delete_error.to_string().contains("Profile is active"));

        Ok(())
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
    fn plan_item_marks_plugin_with_storage_ready_to_install() {
        let mut item = profile_item();
        item.item_type = ModProfileItemType::Plugin;
        item.name = "MeshVault.Mono".to_string();
        item.file_name = Some("MeshVault.Mono.dll".to_string());
        item.source_id = Some("Author/Example".to_string());

        let library = vec![library_entry("storage-1", "Author/Example", Runtime::Mono)];
        let planned = plan_item(item, None, &library, None);

        assert_eq!(planned.status, ModProfileImportStatus::ReadyToInstall);
        assert_eq!(planned.resolved_storage_id.as_deref(), Some("storage-1"));
    }

    #[test]
    fn plan_item_marks_source_less_managed_plugin_already_installed_by_file() {
        let env = test_environment(Runtime::Mono);
        let mut item = profile_item();
        item.item_type = ModProfileItemType::Plugin;
        item.name = "MeshVault.Mono".to_string();
        item.file_name = Some("MeshVault.Mono.dll".to_string());
        item.source = Some(ModSource::Thunderstore);
        item.source_id = None;
        item.source_version = Some("1.0.9".to_string());
        item.storage_id = None;

        let mut entry = library_entry("meshvault-storage", "hdlmrell/MeshVault", Runtime::Mono);
        entry.display_name = "MeshVault".to_string();
        entry.files = vec!["MeshVault.Mono.dll".to_string()];
        entry.source_version = Some("1.0.9".to_string());
        entry.installed_in = vec![env.id.clone()];

        let planned = plan_item(item, Some(&env), &[entry], Some(&serde_json::json!({})));

        assert_eq!(planned.status, ModProfileImportStatus::AlreadyInstalled);
        assert_eq!(
            planned.resolved_storage_id.as_deref(),
            Some("meshvault-storage")
        );
    }

    #[test]
    fn plan_item_marks_plugin_installed_when_target_file_exists_without_library_install_flag() {
        let env = test_environment(Runtime::Mono);
        let mut item = profile_item();
        item.item_type = ModProfileItemType::Plugin;
        item.name = "MeshVault.Mono".to_string();
        item.file_name = Some("MeshVault.Mono.dll".to_string());
        item.source = Some(ModSource::Thunderstore);
        item.source_id = None;
        item.source_version = Some("1.0.9".to_string());
        item.storage_id = None;

        let mut entry = library_entry("meshvault-storage", "hdlmrell/MeshVault", Runtime::Mono);
        entry.display_name = "MeshVault".to_string();
        entry.files = vec!["MeshVault.Mono.dll".to_string()];
        entry.source_version = Some("1.0.9".to_string());
        entry.installed_in.clear();
        let installed = serde_json::json!({
            "plugins": [{
                "name": "MeshVault.Mono",
                "fileName": "MeshVault.Mono.dll",
                "source": "thunderstore",
                "version": "1.0.9"
            }]
        });

        let planned = plan_item(item, Some(&env), &[entry], Some(&installed));

        assert_eq!(planned.status, ModProfileImportStatus::AlreadyInstalled);
        assert_eq!(
            planned.resolved_storage_id.as_deref(),
            Some("meshvault-storage")
        );
    }

    #[test]
    fn plan_item_marks_mod_installed_when_target_file_exists_without_storage_id_row() {
        let env = test_environment(Runtime::Mono);
        let mut item = profile_item();
        item.name = "S1API".to_string();
        item.file_name = Some("S1API.Mono.MelonLoader.dll".to_string());
        item.source = Some(ModSource::Github);
        item.source_id = Some("ifBars/S1API".to_string());
        item.source_version = Some("v3.0.5".to_string());
        item.storage_id = Some("s1api-v3-0-5".to_string());

        let mut entry = library_entry("s1api-v3-0-5", "ifBars/S1API", Runtime::Mono);
        entry.display_name = "S1API".to_string();
        entry.files = vec!["S1API.Mono.MelonLoader.dll".to_string()];
        entry.source = Some(ModSource::Github);
        entry.source_version = Some("3.0.5".to_string());
        entry.installed_in.clear();
        let installed = serde_json::json!({
            "mods": [{
                "name": "S1API",
                "fileName": "S1API.Mono.MelonLoader.dll",
                "managed": true,
                "source": "github",
                "version": "v3.0.5"
            }]
        });

        let planned = plan_item(item, Some(&env), &[entry], Some(&installed));

        assert_eq!(planned.status, ModProfileImportStatus::AlreadyInstalled);
        assert_eq!(planned.resolved_storage_id.as_deref(), Some("s1api-v3-0-5"));
    }

    #[test]
    fn plan_item_marks_source_less_managed_userlib_ready_to_install_by_file() {
        let mut item = profile_item();
        item.item_type = ModProfileItemType::Userlib;
        item.name = "S1MAPI_Mono.dll".to_string();
        item.file_name = Some("S1MAPI_Mono.dll".to_string());
        item.source = Some(ModSource::Local);
        item.source_id = None;
        item.source_version = None;
        item.storage_id = None;

        let mut entry = library_entry("s1mapi-storage", "ifBars/S1MAPI", Runtime::Mono);
        entry.display_name = "S1MAPI".to_string();
        entry.files.clear();
        entry.attached_userlibs = vec!["S1MAPI_Mono.dll".to_string()];

        let planned = plan_item(item, None, &[entry], None);

        assert_eq!(planned.status, ModProfileImportStatus::ReadyToInstall);
        assert_eq!(
            planned.resolved_storage_id.as_deref(),
            Some("s1mapi-storage")
        );
    }

    #[tokio::test]
    async fn build_plugin_items_exports_managed_storage_identity() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let output_dir = temp.path().join("game");
        let plugins_dir = output_dir.join("Plugins");
        tokio::fs::create_dir_all(&plugins_dir).await?;
        tokio::fs::write(plugins_dir.join("MeshVault.Mono.dll"), b"plugin").await?;

        let mut env = test_environment(Runtime::Mono);
        env.output_dir = output_dir.to_string_lossy().to_string();
        let mut entry = library_entry("meshvault-storage", "hdlmrell/MeshVault", Runtime::Mono);
        entry.display_name = "MeshVault".to_string();
        entry.files = vec!["MeshVault.Mono.dll".to_string()];
        entry.source_version = Some("1.0.9".to_string());
        entry.installed_in = vec![env.id.clone()];

        let pool = Arc::new(SqlitePool::connect(":memory:").await?);
        let items = build_plugin_items(pool, &env, &[entry], false).await?;

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].storage_id.as_deref(), Some("meshvault-storage"));
        assert_eq!(items[0].source_id.as_deref(), Some("hdlmrell/MeshVault"));
        assert_eq!(items[0].source_version.as_deref(), Some("1.0.9"));
        assert!(items[0].manual_reason.is_none());
        Ok(())
    }

    #[tokio::test]
    async fn build_userlib_items_exports_managed_storage_identity() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let output_dir = temp.path().join("game");
        let userlibs_dir = output_dir.join("UserLibs");
        tokio::fs::create_dir_all(&userlibs_dir).await?;
        tokio::fs::write(userlibs_dir.join("S1MAPI_Mono.dll"), b"userlib").await?;

        let mut env = test_environment(Runtime::Mono);
        env.output_dir = output_dir.to_string_lossy().to_string();
        let mut entry = library_entry("s1mapi-storage", "ifBars/S1MAPI", Runtime::Mono);
        entry.display_name = "S1MAPI".to_string();
        entry.files.clear();
        entry.attached_userlibs = vec!["S1MAPI_Mono.dll".to_string()];
        entry.source_version = Some("1.0.0".to_string());
        entry.installed_in = vec![env.id.clone()];

        let items = build_userlib_items(&env, &[entry], false).await?;

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].storage_id.as_deref(), Some("s1mapi-storage"));
        assert!(matches!(items[0].source, Some(ModSource::Thunderstore)));
        assert_eq!(items[0].source_id.as_deref(), Some("ifBars/S1MAPI"));
        assert_eq!(items[0].source_version.as_deref(), Some("1.0.0"));
        assert!(items[0].manual_reason.is_none());
        Ok(())
    }

    #[test]
    fn export_managed_mod_items_uses_live_installed_snapshot() {
        let env = test_environment(Runtime::Il2cpp);
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

        let items =
            build_managed_mod_items(&env, &[visible_entry, stale_entry], &installed_mods, false);

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "Visible Mod");
        assert_eq!(items[0].storage_id.as_deref(), Some("visible-storage"));
    }

    #[test]
    fn export_managed_mod_items_skips_disabled_mods() {
        let env = test_environment(Runtime::Il2cpp);
        let entry = library_entry("disabled-storage", "Author/Disabled", Runtime::Il2cpp);
        let installed_mods = serde_json::json!({
            "mods": [{
                "name": "Disabled Mod",
                "fileName": "Disabled.dll.disabled",
                "managed": true,
                "disabled": true,
                "modStorageId": "disabled-storage"
            }],
            "count": 1
        });

        let items = build_managed_mod_items(&env, &[entry], &installed_mods, false);

        assert!(items.is_empty());
    }

    #[test]
    fn plan_item_does_not_trust_colliding_storage_id() {
        let mut item = profile_item();
        item.storage_id = Some("storage-collision".to_string());

        let library = vec![library_entry(
            "storage-collision",
            "OtherAuthor/OtherMod",
            Runtime::Mono,
        )];
        let planned = plan_item(item, None, &library, None);

        assert_eq!(planned.status, ModProfileImportStatus::NeedsDownload);
        assert_eq!(planned.resolved_storage_id, None);
    }

    #[test]
    fn plan_item_does_not_mark_storage_collision_installed() {
        let env = test_environment(Runtime::Mono);
        let mut item = profile_item();
        item.storage_id = Some("storage-collision".to_string());

        let library = vec![library_entry(
            "storage-collision",
            "OtherAuthor/OtherMod",
            Runtime::Mono,
        )];
        let installed = serde_json::json!({
            "mods": [{
                "name": "Other Mod",
                "fileName": "Other.dll",
                "managed": true,
                "modStorageId": "storage-collision",
                "source": "thunderstore",
                "sourceId": "OtherAuthor/OtherMod",
                "version": "1.0.0"
            }]
        });

        let planned = plan_item(item, Some(&env), &library, Some(&installed));

        assert_eq!(planned.status, ModProfileImportStatus::NeedsDownload);
        assert_eq!(planned.resolved_storage_id, None);
    }

    #[test]
    fn plan_item_blocks_runtime_mismatch_before_install() {
        let item = profile_item();
        let env = test_environment(Runtime::Il2cpp);

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

    #[test]
    fn plan_item_preserves_matching_installed_unmanaged_items() {
        let env = test_environment(Runtime::Mono);

        for (item_type, collection) in [
            (ModProfileItemType::Mod, "mods"),
            (ModProfileItemType::Plugin, "plugins"),
            (ModProfileItemType::Userlib, "userLibs"),
        ] {
            let mut item = profile_item();
            item.item_type = item_type;
            item.source = Some(ModSource::Local);
            item.source_id = None;
            item.storage_id = None;
            item.file_name = Some("Nested\\Local.dll".to_string());
            let installed = serde_json::json!({
                (collection): [{
                    "name": "Local",
                    "fileName": "Nested/Local.dll",
                    "managed": false,
                    "disabled": false
                }]
            });

            let planned = plan_item(item, Some(&env), &[], Some(&installed));

            assert_eq!(planned.status, ModProfileImportStatus::AlreadyInstalled);
            assert_eq!(planned.resolved_storage_id, None);
        }
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
