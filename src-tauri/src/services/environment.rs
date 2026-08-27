use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};

#[cfg(test)]
use std::sync::atomic::{AtomicU8, Ordering};

use crate::types::{
    schedule_i_config, Environment, EnvironmentStatus, EnvironmentType, Runtime,
    RuntimeSwitchResult, Settings,
};
use uuid::Uuid;

fn notify_scheduler_of_environment_change() {
    crate::services::runtime_update_scheduler::notify_environment_changed();
}

// Environment payloads are JSON documents, so callers cannot safely perform a
// stale read/whole-row write concurrently.  Keep the read-modify-write command
// path serialized until all legacy whole-row writers have been migrated to
// field-specific commands. SQLite remains the durable authority.
static ENVIRONMENT_MUTATION_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

const MANAGED_ENVIRONMENT_MARKER_FILE: &str = ".simm-environment-owner.json";
const MANAGED_ENVIRONMENT_MARKER_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedEnvironmentOwnershipMarker {
    schema_version: u32,
    environment_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    environment_uuid: Option<String>,
    canonical_root: String,
}

#[derive(Debug, Default)]
struct ManagedDirectoryClaim {
    marker_path: Option<PathBuf>,
    created_root: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct EnvironmentDeletionJournalEntry {
    environment_id: String,
    original_path: String,
    staged_path: String,
    environment_data: String,
    state: String,
    last_error: Option<String>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct EnvironmentDeletionRecoveryReport {
    pub restored: usize,
    pub finalized: usize,
    pub pending: usize,
}

const DELETE_FAILURE_STAGED_REVALIDATION: u8 = 1 << 0;
const DELETE_FAILURE_REMOVE: u8 = 1 << 1;
const DELETE_FAILURE_DB_COMMIT: u8 = 1 << 2;
const DELETE_FAILURE_RESTORE_RENAME: u8 = 1 << 3;

#[cfg(test)]
static DELETE_FAILURES: AtomicU8 = AtomicU8::new(0);

fn take_delete_failure(flag: u8) -> bool {
    #[cfg(test)]
    {
        return DELETE_FAILURES.fetch_and(!flag, Ordering::SeqCst) & flag != 0;
    }
    #[cfg(not(test))]
    {
        let _ = flag;
        false
    }
}

fn fail_environment_deletion_if_injected(flag: u8, boundary: &str) -> Result<()> {
    if take_delete_failure(flag) {
        anyhow::bail!("Injected environment deletion failure at {boundary}");
    }
    Ok(())
}

pub struct EnvironmentService {
    pool: Arc<SqlitePool>,
    runtime_settings: Option<Settings>,
}

impl EnvironmentService {
    pub fn new(pool: Arc<SqlitePool>) -> Result<Self> {
        Ok(Self {
            pool,
            runtime_settings: None,
        })
    }

    /// Supplies public settings for runtime-switch profile operations. The
    /// ordinary constructor remains for tests and environment-only callers.
    pub fn with_runtime_settings(mut self, settings: Settings) -> Self {
        self.runtime_settings = Some(settings);
        self
    }

    fn mod_profiles_service(&self) -> crate::services::mod_profiles::ModProfilesService {
        let service = crate::services::mod_profiles::ModProfilesService::new(self.pool.clone());
        match &self.runtime_settings {
            Some(settings) => service.with_runtime_settings(settings.clone()),
            None => service,
        }
    }

    pub fn infer_runtime_from_installation_path(path: &Path) -> Runtime {
        // Steam branch switches can leave behind stale binaries. Prefer folder-level markers
        // that reliably indicate the active scripting backend.
        //
        // Mono builds ship `Schedule I_Data/MonoBleedingEdge`, while IL2CPP builds ship
        // `Schedule I_Data/il2cpp_data` and typically `GameAssembly.dll`.
        let data_dir = path.join("Schedule I_Data");
        let has_mono_bleeding_edge = data_dir.join("MonoBleedingEdge").exists();
        let has_il2cpp_data = data_dir.join("il2cpp_data").exists();
        let has_game_assembly = path.join("GameAssembly.dll").exists();
        let has_assembly_csharp = data_dir
            .join("Managed")
            .join("Assembly-CSharp.dll")
            .exists();

        if has_mono_bleeding_edge {
            return Runtime::Mono;
        }

        if has_il2cpp_data || has_game_assembly {
            return Runtime::Il2cpp;
        }

        if has_assembly_csharp {
            return Runtime::Mono;
        }

        // Default to IL2CPP because that's the common case for recent builds.
        Runtime::Il2cpp
    }

    pub fn branch_for_runtime(runtime: &Runtime) -> String {
        match runtime {
            Runtime::Il2cpp => "main".to_string(),
            Runtime::Mono => "alternate".to_string(),
        }
    }

    pub fn runtime_for_branch(branch: &str) -> Option<Runtime> {
        schedule_i_config()
            .branches
            .into_iter()
            .find(|b| b.name.eq_ignore_ascii_case(branch))
            .map(|b| b.runtime)
    }

    /// Re-reads Steam appmanifest (`betakey`) and install-folder markers, then updates
    /// `env.branch` / `env.runtime` and persists when changed. Used before version checks
    /// and update checks so Steam branch switches outside SIMM are reflected.
    pub async fn reconcile_steam_env_branch_runtime_from_disk(
        &self,
        env: &mut Environment,
    ) -> Result<Option<RuntimeSwitchResult>> {
        let is_steam =
            env.environment_type == Some(EnvironmentType::Steam) || env.id.starts_with("steam-");
        if !is_steam || !matches!(env.status, EnvironmentStatus::Completed) {
            return Ok(None);
        }
        if env.output_dir.is_empty() {
            return Ok(None);
        }

        let steam_service = crate::services::steam::SteamService::new();
        let output_path = Path::new(&env.output_dir);
        let runtime_from_files = Self::infer_runtime_from_installation_path(output_path);
        let installation = crate::services::steam::SteamInstallation {
            path: env.output_dir.clone(),
            executable_path: output_path
                .join("Schedule I.exe")
                .to_string_lossy()
                .to_string(),
            app_id: crate::services::steam::SteamService::get_steam_app_id(),
            steamapps_dir: env.steamapps_dir.clone(),
            manifest_path: env.steam_manifest_path.clone(),
        };

        let detected_branch = steam_service
            .detect_installed_branch_for_installation(&installation)
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| Self::branch_for_runtime(&runtime_from_files));

        // The appmanifest identifies the selected branch, but Steam branches can
        // change scripting backend without SIMM's static branch catalog changing.
        // The installed Unity markers are therefore authoritative for runtime.
        let detected_runtime = runtime_from_files;

        let previous_branch = env.branch.clone();
        let previous_runtime = env.runtime.clone();
        let runtime_changed = previous_runtime != detected_runtime;
        let previous_manifest = if runtime_changed {
            match self
                .mod_profiles_service()
                .export_environment_profile_with_options(&env.id, false)
                .await
            {
                Ok(manifest) => Some(manifest),
                Err(error) => {
                    log::warn!(
                        "Failed to capture enabled items before Steam runtime switch for {}: {}",
                        env.id,
                        error
                    );
                    None
                }
            }
        } else {
            None
        };

        let mut changed = false;
        let mut reconciliation_updates = Vec::new();
        if env.branch != detected_branch {
            log::info!(
                "Reconciling Steam env {} branch: {} -> {}",
                env.id,
                env.branch,
                detected_branch
            );
            env.branch = detected_branch;
            reconciliation_updates
                .push(("branch".to_string(), serde_json::json!(env.branch.clone())));
            changed = true;
        }
        if env.runtime != detected_runtime {
            log::info!(
                "Reconciling Steam env {} runtime: {:?} -> {:?}",
                env.id,
                env.runtime,
                detected_runtime
            );
            env.runtime = detected_runtime;
            reconciliation_updates.push((
                "runtime".to_string(),
                serde_json::json!(match env.runtime {
                    Runtime::Il2cpp => "IL2CPP",
                    Runtime::Mono => "Mono",
                }),
            ));
            changed = true;
        }

        if changed {
            self.update_environment(&env.id, reconciliation_updates)
                .await?;
        }

        if !runtime_changed {
            return Ok(None);
        }

        let mut result = RuntimeSwitchResult {
            environment_id: env.id.clone(),
            environment_name: env.name.clone(),
            previous_branch,
            branch: env.branch.clone(),
            previous_runtime,
            runtime: env.runtime.clone(),
            disabled_items: 0,
            installed_items: 0,
            missing_items: Vec::new(),
            errors: Vec::new(),
        };

        if let Some(manifest) = previous_manifest {
            let summary = self
                .mod_profiles_service()
                .switch_environment_runtime_items(manifest, env)
                .await;
            result.disabled_items = summary.disabled_items;
            result.installed_items = summary.installed_items;
            result.missing_items = summary.missing_items;
            result.errors = summary.errors;
        } else {
            result.errors.push(
                "SIMM could not inventory the active mods before changing runtimes. Review this environment before launching."
                    .to_string(),
            );
        }

        Ok(Some(result))
    }

    async fn heal_environment_payload_id(
        &self,
        row_id: &str,
        mut env: Environment,
    ) -> Result<Environment> {
        if env.id == row_id {
            return Ok(env);
        }

        let payload_id = env.id.clone();
        env.id = row_id.to_string();

        let serialized =
            serde_json::to_string(&env).context("Failed to serialize healed environment")?;
        sqlx::query("UPDATE environments SET data = ? WHERE id = ?")
            .bind(&serialized)
            .bind(row_id)
            .execute(&*self.pool)
            .await
            .with_context(|| format!("Failed to heal environment id mismatch for {}", row_id))?;

        log::warn!(
            "Healed environment row id mismatch: row id {} replaced payload id {}",
            row_id,
            payload_id
        );

        Ok(env)
    }

    async fn fetch_environments(&self) -> Result<Vec<Environment>> {
        let rows = sqlx::query_as::<_, (String, String)>("SELECT id, data FROM environments")
            .fetch_all(&*self.pool)
            .await
            .context("Failed to query environments")?;

        let mut envs = Vec::new();
        for (row_id, row_data) in rows {
            match serde_json::from_str::<Environment>(&row_data) {
                Ok(env) => match self.heal_environment_payload_id(&row_id, env).await {
                    Ok(healed) => envs.push(healed),
                    Err(err) => {
                        log::warn!(
                            "Skipping environment {} with unhealable payload id mismatch: {}",
                            row_id,
                            err
                        );
                    }
                },
                Err(err) => {
                    log::warn!("Skipping invalid environment record: {}", err);
                }
            }
        }

        Ok(envs)
    }

    fn is_retryable_write_error(err: &sqlx::Error) -> bool {
        let msg = err.to_string().to_lowercase();
        msg.contains("database is locked") || msg.contains("database is busy")
    }

    fn is_missing_normalized_output_dir_column(err: &sqlx::Error) -> bool {
        let msg = err.to_string().to_lowercase();
        msg.contains("normalized_output_dir")
            && (msg.contains("no such column") || msg.contains("has no column named"))
    }

    async fn ensure_normalized_output_dir_column(&self) -> Result<()> {
        let result = sqlx::query("ALTER TABLE environments ADD COLUMN normalized_output_dir TEXT")
            .execute(&*self.pool)
            .await;

        match result {
            Ok(_) => Ok(()),
            Err(err) => {
                let msg = err.to_string().to_lowercase();
                if msg.contains("duplicate column name") || msg.contains("already exists") {
                    Ok(())
                } else {
                    Err(err).context("Failed to add normalized_output_dir column")
                }
            }
        }
    }

    async fn environment_row_exists(&self, id: &str) -> Result<bool> {
        let exists =
            sqlx::query_scalar::<_, i64>("SELECT 1 FROM environments WHERE id = ? LIMIT 1")
                .bind(id)
                .fetch_optional(&*self.pool)
                .await
                .context("Failed to query environment row existence")?;

        Ok(exists.is_some())
    }

    async fn find_environment_storage_id_by_output_dir(
        &self,
        output_dir: &str,
    ) -> Result<Option<String>> {
        let normalized_output_dir = Self::normalize_path(output_dir);
        let result = sqlx::query_scalar::<_, String>(
            "SELECT id FROM environments WHERE normalized_output_dir = ? OR output_dir = ? LIMIT 1",
        )
        .bind(&normalized_output_dir)
        .bind(output_dir)
        .fetch_optional(&*self.pool)
        .await;

        match result {
            Ok(id) => Ok(id),
            Err(err) if Self::is_missing_normalized_output_dir_column(&err) => {
                let rows = sqlx::query_as::<_, (String, String)>(
                    "SELECT id, output_dir FROM environments",
                )
                .fetch_all(&*self.pool)
                .await
                .context("Failed to query environments by output_dir fallback")?;

                Ok(rows
                    .into_iter()
                    .find(|(_, existing_output_dir)| {
                        Self::normalize_path(existing_output_dir) == normalized_output_dir
                    })
                    .map(|(id, _)| id))
            }
            Err(err) => Err(err).context("Failed to query environment by output_dir"),
        }
    }

    async fn resolve_environment_for_save(&self, env: &Environment) -> Result<Environment> {
        if self.environment_row_exists(&env.id).await? {
            return Ok(env.clone());
        }

        let Some(existing_id) = self
            .find_environment_storage_id_by_output_dir(&env.output_dir)
            .await?
        else {
            return Ok(env.clone());
        };

        if existing_id == env.id {
            return Ok(env.clone());
        }

        let mut canonical_env = env.clone();
        canonical_env.id = existing_id.clone();
        log::info!(
            "Reusing canonical environment id {} for path {} instead of transient id {}",
            existing_id,
            env.output_dir,
            env.id
        );
        Ok(canonical_env)
    }

    async fn save_environment(&self, env: &Environment) -> Result<()> {
        let env = self.resolve_environment_for_save(env).await?;
        let normalized_output_dir = Self::normalize_path(&env.output_dir);
        let serialized = serde_json::to_string(&env).context("Failed to serialize environment")?;
        let upsert_with_normalized = {
            let mut last_error: Option<sqlx::Error> = None;
            let mut success = None;

            for attempt in 0..3 {
                let result = sqlx::query(
                    "INSERT INTO environments (id, output_dir, normalized_output_dir, data) VALUES (?, ?, ?, ?) \
                     ON CONFLICT(id) DO UPDATE SET output_dir = excluded.output_dir, normalized_output_dir = excluded.normalized_output_dir, data = excluded.data",
                )
                .bind(&env.id)
                .bind(&env.output_dir)
                .bind(&normalized_output_dir)
                .bind(&serialized)
                .execute(&*self.pool)
                .await;

                match result {
                    Ok(done) => {
                        success = Some(done);
                        break;
                    }
                    Err(err) if Self::is_retryable_write_error(&err) && attempt < 2 => {
                        let backoff_ms = 25 * (attempt + 1);
                        sleep(Duration::from_millis(backoff_ms)).await;
                    }
                    Err(err) => {
                        last_error = Some(err);
                        break;
                    }
                }
            }

            if success.is_some() {
                Ok(())
            } else {
                Err(last_error.unwrap_or_else(|| {
                    sqlx::Error::Protocol("unknown sqlite write failure".to_string())
                }))
            }
        };

        match upsert_with_normalized {
            Ok(_) => {
                notify_scheduler_of_environment_change();
                Ok(())
            }
            Err(err) if Self::is_missing_normalized_output_dir_column(&err) => {
                if self.ensure_normalized_output_dir_column().await.is_ok() {
                    sqlx::query(
                        "INSERT INTO environments (id, output_dir, normalized_output_dir, data) VALUES (?, ?, ?, ?) \
                         ON CONFLICT(id) DO UPDATE SET output_dir = excluded.output_dir, normalized_output_dir = excluded.normalized_output_dir, data = excluded.data",
                    )
                    .bind(&env.id)
                    .bind(&env.output_dir)
                    .bind(&normalized_output_dir)
                    .bind(&serialized)
                    .execute(&*self.pool)
                    .await
                    .context("Failed to save environment")?;

                    notify_scheduler_of_environment_change();
                    return Ok(());
                }

                let serialized =
                    serde_json::to_string(&env).context("Failed to serialize environment")?;
                sqlx::query(
                    "INSERT INTO environments (id, output_dir, data) VALUES (?, ?, ?) \
                     ON CONFLICT(id) DO UPDATE SET output_dir = excluded.output_dir, data = excluded.data",
                )
                .bind(&env.id)
                .bind(&env.output_dir)
                .bind(serialized)
                .execute(&*self.pool)
                .await
                .context("Failed to save environment")?;

                notify_scheduler_of_environment_change();
                Ok(())
            }
            Err(err)
                if err
                    .to_string()
                    .to_lowercase()
                    .contains("unique constraint failed") =>
            {
                let update_by_normalized = sqlx::query(
                    "UPDATE environments SET output_dir = ?, data = ? WHERE normalized_output_dir = ?",
                )
                .bind(&env.output_dir)
                .bind(&serialized)
                .bind(&normalized_output_dir)
                .execute(&*self.pool)
                .await;

                if let Ok(updated) = update_by_normalized {
                    if updated.rows_affected() > 0 {
                        notify_scheduler_of_environment_change();
                        return Ok(());
                    }
                }

                let update_by_output_dir =
                    sqlx::query("UPDATE environments SET data = ? WHERE output_dir = ?")
                        .bind(&serialized)
                        .bind(&env.output_dir)
                        .execute(&*self.pool)
                        .await
                        .context("Failed to resolve environment save conflict by output_dir")?;

                if update_by_output_dir.rows_affected() > 0 {
                    notify_scheduler_of_environment_change();
                    return Ok(());
                }

                Err(err).context("Failed to save environment")
            }
            Err(err) => Err(err).context("Failed to save environment"),
        }
    }

    pub async fn hard_delete_environment_record(&self, id: &str) -> Result<()> {
        let mut transaction = self
            .pool
            .begin()
            .await
            .context("Failed to begin hard environment delete")?;
        Self::clear_environment_metadata_in_transaction(&mut transaction, id).await?;
        sqlx::query("DELETE FROM environment_profiles WHERE environment_id = ?")
            .bind(id)
            .execute(&mut *transaction)
            .await
            .context("Failed to clear active environment profile mapping")?;
        sqlx::query("DELETE FROM environments WHERE id = ?")
            .bind(id)
            .execute(&mut *transaction)
            .await
            .context("Failed to hard delete environment")?;
        transaction
            .commit()
            .await
            .context("Failed to commit hard environment delete")?;
        crate::services::mods_snapshot_cache::remove(id).await;

        notify_scheduler_of_environment_change();
        Ok(())
    }

    fn normalize_path(path: &str) -> String {
        let trimmed = path.trim_end_matches(['\\', '/']);
        #[cfg(windows)]
        {
            trimmed.replace('/', "\\").to_ascii_lowercase()
        }
        #[cfg(not(windows))]
        {
            trimmed.to_string()
        }
    }

    fn paths_equal(left: &Path, right: &Path) -> bool {
        fn comparison_path(path: &Path) -> String {
            let normalized = EnvironmentService::normalize_path(path.to_string_lossy().as_ref());
            #[cfg(windows)]
            {
                if let Some(unc) = normalized.strip_prefix(r"\\?\unc\") {
                    return format!(r"\\{}", unc);
                }
                normalized
                    .strip_prefix(r"\\?\")
                    .unwrap_or(&normalized)
                    .to_string()
            }
            #[cfg(not(windows))]
            {
                normalized
            }
        }

        comparison_path(left) == comparison_path(right)
    }

    fn managed_environment_uuid(environment_id: &str) -> Option<Uuid> {
        let bytes = environment_id.as_bytes();
        if bytes.len() < 37 || bytes.get(bytes.len() - 37) != Some(&b'-') {
            return None;
        }
        std::str::from_utf8(&bytes[bytes.len() - 36..])
            .ok()
            .and_then(|value| Uuid::parse_str(value).ok())
    }

    fn expected_ownership_marker(
        env: &Environment,
        canonical_root: &Path,
    ) -> Result<ManagedEnvironmentOwnershipMarker> {
        Ok(ManagedEnvironmentOwnershipMarker {
            schema_version: MANAGED_ENVIRONMENT_MARKER_VERSION,
            environment_id: env.id.clone(),
            environment_uuid: Self::managed_environment_uuid(&env.id).map(|uuid| uuid.to_string()),
            canonical_root: canonical_root.to_string_lossy().to_string(),
        })
    }

    async fn write_ownership_marker(env: &Environment, canonical_root: &Path) -> Result<PathBuf> {
        let marker = Self::expected_ownership_marker(env, canonical_root)?;
        let marker_path = canonical_root.join(MANAGED_ENVIRONMENT_MARKER_FILE);
        let content = serde_json::to_vec_pretty(&marker)
            .context("Failed to serialize managed environment ownership marker")?;

        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker_path)
            .await
            .context("Failed to create managed environment ownership marker")?;
        let write_result = async {
            file.write_all(&content)
                .await
                .context("Failed to write managed environment ownership marker")?;
            file.flush()
                .await
                .context("Failed to flush managed environment ownership marker")?;
            file.sync_all()
                .await
                .context("Failed to persist managed environment ownership marker")
        }
        .await;

        if let Err(error) = write_result {
            let _ = tokio::fs::remove_file(&marker_path).await;
            return Err(error);
        }
        Ok(marker_path)
    }

    async fn validate_ownership_marker_at(
        env: &Environment,
        marker_root: &Path,
        expected_canonical_root: &Path,
    ) -> Result<()> {
        let marker_path = marker_root.join(MANAGED_ENVIRONMENT_MARKER_FILE);
        let metadata = tokio::fs::symlink_metadata(&marker_path)
            .await
            .context("Managed environment ownership marker is missing")?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(anyhow::anyhow!(
                "Managed environment ownership marker must be a real file"
            ));
        }

        let content = tokio::fs::read(&marker_path)
            .await
            .context("Failed to read managed environment ownership marker")?;
        let marker: ManagedEnvironmentOwnershipMarker = serde_json::from_slice(&content)
            .context("Managed environment ownership marker is invalid")?;
        let expected = Self::expected_ownership_marker(env, expected_canonical_root)?;
        if marker.schema_version != expected.schema_version
            || marker.environment_id != expected.environment_id
            || marker.environment_uuid != expected.environment_uuid
            || !Self::paths_equal(
                Path::new(&marker.canonical_root),
                Path::new(&expected.canonical_root),
            )
        {
            return Err(anyhow::anyhow!(
                "Managed environment ownership marker does not match this environment or canonical root"
            ));
        }
        Ok(())
    }

    async fn initialize_managed_directory_ownership(
        &self,
        env: &Environment,
    ) -> Result<ManagedDirectoryClaim> {
        let configured_root = Path::new(&env.output_dir);
        let created_root = match tokio::fs::symlink_metadata(configured_root).await {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(anyhow::anyhow!(
                        "Managed environment output must be a real directory"
                    ));
                }
                false
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                tokio::fs::create_dir_all(configured_root)
                    .await
                    .context("Failed to create managed environment directory")?;
                true
            }
            Err(error) => {
                return Err(error).context("Failed to inspect managed environment directory")
            }
        };

        let canonical_root = match tokio::fs::canonicalize(configured_root).await {
            Ok(root) => root,
            Err(error) => {
                if created_root {
                    let _ = tokio::fs::remove_dir(configured_root).await;
                }
                return Err(error).context("Failed to resolve managed environment directory");
            }
        };
        let marker_path = canonical_root.join(MANAGED_ENVIRONMENT_MARKER_FILE);
        match tokio::fs::symlink_metadata(&marker_path).await {
            Ok(_) => {
                Self::validate_ownership_marker_at(env, &canonical_root, &canonical_root).await?;
                return Ok(ManagedDirectoryClaim::default());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).context("Failed to inspect managed environment ownership marker")
            }
        }

        if !created_root {
            let mut entries = tokio::fs::read_dir(&canonical_root)
                .await
                .context("Failed to inspect managed environment directory contents")?;
            if entries
                .next_entry()
                .await
                .context("Failed to inspect managed environment directory contents")?
                .is_some()
            {
                log::warn!(
                    "Environment {} uses a pre-existing non-empty directory; recursive deletion remains disabled until it satisfies the configured-root migration policy",
                    env.id
                );
                return Ok(ManagedDirectoryClaim::default());
            }
        }

        let marker_path = match Self::write_ownership_marker(env, &canonical_root).await {
            Ok(marker_path) => marker_path,
            Err(error) => {
                if created_root {
                    let _ = tokio::fs::remove_dir(&canonical_root).await;
                }
                return Err(error);
            }
        };
        Ok(ManagedDirectoryClaim {
            marker_path: Some(marker_path),
            created_root,
        })
    }

    async fn rollback_managed_directory_claim(&self, claim: ManagedDirectoryClaim) {
        let root = claim
            .marker_path
            .as_ref()
            .and_then(|marker| marker.parent())
            .map(Path::to_path_buf);
        if let Some(marker_path) = claim.marker_path {
            let _ = tokio::fs::remove_file(marker_path).await;
        }
        if claim.created_root {
            if let Some(root) = root {
                let _ = tokio::fs::remove_dir(root).await;
            }
        }
    }

    async fn configured_managed_download_root(&self) -> Result<PathBuf> {
        let settings = match self.runtime_settings.as_ref() {
            Some(settings) => settings.clone(),
            None => {
                let mut service =
                    crate::services::settings::SettingsService::new(self.pool.clone())?;
                service.load_settings().await?
            }
        };
        let configured_root = Path::new(&settings.default_download_dir);
        let metadata = tokio::fs::metadata(configured_root)
            .await
            .context("Configured managed download root is unavailable")?;
        if !metadata.is_dir() {
            return Err(anyhow::anyhow!(
                "Configured managed download root is not a directory"
            ));
        }
        tokio::fs::canonicalize(configured_root)
            .await
            .context("Failed to resolve configured managed download root")
    }

    async fn migrate_legacy_ownership_marker(
        &self,
        env: &Environment,
        canonical_target: &Path,
    ) -> Result<()> {
        let managed_root = self.configured_managed_download_root().await?;
        if Self::paths_equal(canonical_target, &managed_root)
            || !canonical_target.starts_with(&managed_root)
        {
            return Err(anyhow::anyhow!(
                "Managed environment ownership marker is missing; automatic migration is limited to strict children of the configured download root"
            ));
        }

        let metadata = tokio::fs::symlink_metadata(Path::new(&env.output_dir))
            .await
            .context("Failed to re-inspect legacy environment directory")?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(anyhow::anyhow!(
                "Legacy environment directory changed before ownership migration"
            ));
        }
        let revalidated = tokio::fs::canonicalize(&env.output_dir)
            .await
            .context("Failed to re-resolve legacy environment directory")?;
        if !Self::paths_equal(&revalidated, canonical_target)
            || !revalidated.starts_with(&managed_root)
        {
            return Err(anyhow::anyhow!(
                "Legacy environment directory changed before ownership migration"
            ));
        }

        Self::write_ownership_marker(env, &revalidated).await?;
        Self::validate_ownership_marker_at(env, &revalidated, &revalidated).await?;
        log::info!(
            "Migrated legacy managed environment ownership marker for {}",
            env.id
        );
        Ok(())
    }

    async fn ensure_ownership_marker(
        &self,
        env: &Environment,
        canonical_target: &Path,
    ) -> Result<()> {
        let marker_path = canonical_target.join(MANAGED_ENVIRONMENT_MARKER_FILE);
        match tokio::fs::symlink_metadata(&marker_path).await {
            Ok(_) => {
                Self::validate_ownership_marker_at(env, canonical_target, canonical_target).await
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.migrate_legacy_ownership_marker(env, canonical_target)
                    .await
            }
            Err(error) => {
                Err(error).context("Failed to inspect managed environment ownership marker")
            }
        }
    }

    async fn validate_depot_installation_artifacts(canonical_target: &Path) -> Result<()> {
        let receipt = tokio::fs::symlink_metadata(canonical_target.join(".DepotDownloader"))
            .await
            .context("SIMM DepotDownloader receipt is missing")?;
        let executable = tokio::fs::symlink_metadata(canonical_target.join("Schedule I.exe"))
            .await
            .context("Schedule I executable is missing")?;
        if receipt.file_type().is_symlink()
            || !receipt.is_dir()
            || executable.file_type().is_symlink()
            || !executable.is_file()
        {
            return Err(anyhow::anyhow!(
                "Refusing to delete an environment without real DepotDownloader receipt and Schedule I.exe artifacts"
            ));
        }
        Ok(())
    }

    async fn clear_environment_metadata(&self, id: &str) -> Result<()> {
        let mut transaction = self
            .pool
            .begin()
            .await
            .context("Failed to begin environment metadata cleanup")?;
        Self::clear_environment_metadata_in_transaction(&mut transaction, id).await?;
        transaction
            .commit()
            .await
            .context("Failed to commit environment metadata cleanup")?;
        Ok(())
    }

    async fn clear_environment_metadata_in_transaction(
        transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        id: &str,
    ) -> Result<()> {
        sqlx::query("DELETE FROM mod_metadata WHERE environment_id = ?")
            .bind(id)
            .execute(&mut **transaction)
            .await
            .context("Failed to clear environment metadata")?;

        Ok(())
    }

    async fn create_environment_deletion_journal(
        &self,
        env: &Environment,
        original_path: &Path,
        staged_path: &Path,
    ) -> Result<EnvironmentDeletionJournalEntry> {
        let now = Utc::now().to_rfc3339();
        let environment_data =
            serde_json::to_string(env).context("Failed to snapshot environment for deletion")?;
        let entry = EnvironmentDeletionJournalEntry {
            environment_id: env.id.clone(),
            original_path: original_path.to_string_lossy().to_string(),
            staged_path: staged_path.to_string_lossy().to_string(),
            environment_data,
            state: "planned".to_string(),
            last_error: None,
        };

        sqlx::query(
            "INSERT INTO environment_deletion_journal \
             (environment_id, original_path, staged_path, environment_data, state, last_error, created_at, updated_at) \
             VALUES (?, ?, ?, ?, 'planned', NULL, ?, ?)",
        )
        .bind(&entry.environment_id)
        .bind(&entry.original_path)
        .bind(&entry.staged_path)
        .bind(&entry.environment_data)
        .bind(&now)
        .bind(&now)
        .execute(&*self.pool)
        .await
        .with_context(|| {
            format!(
                "Failed to create durable deletion journal for environment {}",
                env.id
            )
        })?;

        Ok(entry)
    }

    async fn update_environment_deletion_journal(
        &self,
        environment_id: &str,
        state: &str,
        last_error: Option<&str>,
    ) -> Result<()> {
        let updated = sqlx::query(
            "UPDATE environment_deletion_journal \
             SET state = ?, last_error = ?, updated_at = ? \
             WHERE environment_id = ?",
        )
        .bind(state)
        .bind(last_error)
        .bind(Utc::now().to_rfc3339())
        .bind(environment_id)
        .execute(&*self.pool)
        .await
        .context("Failed to update environment deletion journal")?;

        if updated.rows_affected() != 1 {
            anyhow::bail!(
                "Deletion journal for environment {} is missing",
                environment_id
            );
        }
        Ok(())
    }

    async fn clear_environment_deletion_journal(&self, environment_id: &str) -> Result<()> {
        sqlx::query("DELETE FROM environment_deletion_journal WHERE environment_id = ?")
            .bind(environment_id)
            .execute(&*self.pool)
            .await
            .context("Failed to clear environment deletion journal")?;
        Ok(())
    }

    async fn list_environment_deletion_journals(
        &self,
    ) -> Result<Vec<EnvironmentDeletionJournalEntry>> {
        sqlx::query_as::<_, EnvironmentDeletionJournalEntry>(
            "SELECT environment_id, original_path, staged_path, environment_data, state, last_error \
             FROM environment_deletion_journal \
             ORDER BY created_at ASC, environment_id ASC",
        )
        .fetch_all(&*self.pool)
        .await
        .context("Failed to list pending environment deletions")
    }

    fn validate_environment_deletion_journal_entry(
        entry: &EnvironmentDeletionJournalEntry,
    ) -> Result<Environment> {
        let env: Environment = serde_json::from_str(&entry.environment_data)
            .context("Deletion journal contains an invalid environment snapshot")?;
        let original = Path::new(&entry.original_path);
        let staged = Path::new(&entry.staged_path);
        let staged_name = staged.file_name().and_then(|name| name.to_str());

        if env.id != entry.environment_id
            || !Self::paths_equal(Path::new(&env.output_dir), original)
            || env.environment_type != Some(EnvironmentType::DepotDownloader)
            || staged_name.is_none_or(|name| !name.starts_with(".simm-delete-"))
            || original.parent().is_none()
            || staged.parent().is_none()
            || !Self::paths_equal(
                original.parent().expect("checked original parent"),
                staged.parent().expect("checked staged parent"),
            )
            || Self::paths_equal(original, staged)
        {
            anyhow::bail!(
                "Deletion journal for environment {} failed identity validation",
                entry.environment_id
            );
        }

        Ok(env)
    }

    async fn filesystem_entry_exists(path: &Path) -> Result<bool> {
        match tokio::fs::symlink_metadata(path).await {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error)
                .with_context(|| format!("Failed to inspect recovery path {}", path.display())),
        }
    }

    async fn restore_staged_environment_deletion(
        &self,
        entry: &EnvironmentDeletionJournalEntry,
        env: &Environment,
    ) -> Result<()> {
        let original = Path::new(&entry.original_path);
        let staged = Path::new(&entry.staged_path);
        if Self::filesystem_entry_exists(original).await? {
            anyhow::bail!(
                "Cannot restore staged environment {} because its original path already exists",
                entry.environment_id
            );
        }
        let verified_staged = self
            .validate_staged_environment_file_deletion(env, original, staged)
            .await?;
        fail_environment_deletion_if_injected(DELETE_FAILURE_RESTORE_RENAME, "restore rename")?;
        tokio::fs::rename(&verified_staged, original)
            .await
            .with_context(|| {
                format!(
                    "Failed to restore staged environment directory {} to {}",
                    verified_staged.display(),
                    original.display()
                )
            })?;
        Ok(())
    }

    async fn finalize_staged_environment_deletion(
        &self,
        entry: &EnvironmentDeletionJournalEntry,
        env: &Environment,
    ) -> Result<()> {
        fail_environment_deletion_if_injected(
            DELETE_FAILURE_STAGED_REVALIDATION,
            "staged revalidation",
        )?;
        let verified_staged = self
            .validate_staged_environment_file_deletion(
                env,
                Path::new(&entry.original_path),
                Path::new(&entry.staged_path),
            )
            .await?;
        fail_environment_deletion_if_injected(DELETE_FAILURE_REMOVE, "staged tree removal")?;
        tokio::fs::remove_dir_all(&verified_staged)
            .await
            .with_context(|| {
                format!(
                    "Failed to remove staged environment directory {}",
                    verified_staged.display()
                )
            })?;
        self.clear_environment_deletion_journal(&entry.environment_id)
            .await?;
        crate::services::mods_snapshot_cache::remove(&entry.environment_id).await;
        Ok(())
    }

    pub async fn recover_pending_environment_deletions(
        &self,
    ) -> Result<EnvironmentDeletionRecoveryReport> {
        let _mutation_guard = ENVIRONMENT_MUTATION_LOCK.lock().await;
        let entries = self.list_environment_deletion_journals().await?;
        let mut report = EnvironmentDeletionRecoveryReport::default();

        for entry in entries {
            let recovery = async {
                let snapshot = Self::validate_environment_deletion_journal_entry(&entry)?;
                let live_environment = self.get_environment(&entry.environment_id).await?;
                let original_exists =
                    Self::filesystem_entry_exists(Path::new(&entry.original_path)).await?;
                let staged_exists =
                    Self::filesystem_entry_exists(Path::new(&entry.staged_path)).await?;

                match (live_environment, original_exists, staged_exists) {
                    (Some(live), true, false) => {
                        if !Self::paths_equal(
                            Path::new(&live.output_dir),
                            Path::new(&entry.original_path),
                        ) {
                            anyhow::bail!(
                                "Live environment path no longer matches deletion journal"
                            );
                        }
                        self.clear_environment_deletion_journal(&entry.environment_id)
                            .await?;
                        Ok((true, false))
                    }
                    (Some(live), false, true) => {
                        if live.id != snapshot.id
                            || !Self::paths_equal(
                                Path::new(&live.output_dir),
                                Path::new(&entry.original_path),
                            )
                        {
                            anyhow::bail!(
                                "Live environment identity no longer matches deletion journal"
                            );
                        }
                        self.restore_staged_environment_deletion(&entry, &snapshot)
                            .await?;
                        self.clear_environment_deletion_journal(&entry.environment_id)
                            .await?;
                        Ok((true, false))
                    }
                    (None, false, true) => {
                        self.finalize_staged_environment_deletion(&entry, &snapshot)
                            .await?;
                        Ok((false, true))
                    }
                    (None, false, false) => {
                        self.clear_environment_deletion_journal(&entry.environment_id)
                            .await?;
                        crate::services::mods_snapshot_cache::remove(&entry.environment_id).await;
                        Ok((false, true))
                    }
                    (Some(_), true, true) => {
                        anyhow::bail!("Both original and staged paths exist for a live environment")
                    }
                    (Some(_), false, false) => anyhow::bail!(
                        "Neither original nor staged path exists for a live environment"
                    ),
                    (None, true, _) => {
                        anyhow::bail!("Original path exists after environment metadata was deleted")
                    }
                }
            }
            .await;

            match recovery {
                Ok((restored, finalized)) => {
                    report.restored += usize::from(restored);
                    report.finalized += usize::from(finalized);
                }
                Err(error) => {
                    report.pending += 1;
                    let state = if self.environment_row_exists(&entry.environment_id).await? {
                        "restore_required"
                    } else {
                        "metadata_deleted"
                    };
                    let error_text = format!("{error:#}");
                    if let Err(update_error) = self
                        .update_environment_deletion_journal(
                            &entry.environment_id,
                            state,
                            Some(&error_text),
                        )
                        .await
                    {
                        log::error!(
                            "Failed to record recovery error for environment {}: {}",
                            entry.environment_id,
                            update_error
                        );
                    }
                    log::error!(
                        "Environment deletion for {} remains pending (journal_state={}, previous_state={}, previous_error={:?}): {}",
                        entry.environment_id,
                        state,
                        entry.state,
                        entry.last_error,
                        error
                    );
                }
            }
        }

        Ok(report)
    }

    pub async fn get_environments(&self) -> Result<Vec<Environment>> {
        self.fetch_environments().await
    }

    pub async fn get_environment(&self, id: &str) -> Result<Option<Environment>> {
        let row = sqlx::query_scalar::<_, String>("SELECT data FROM environments WHERE id = ?")
            .bind(id)
            .fetch_optional(&*self.pool)
            .await
            .context("Failed to query environment")?;

        match row {
            Some(data) => match serde_json::from_str::<Environment>(&data) {
                Ok(env) => Ok(Some(self.heal_environment_payload_id(id, env).await?)),
                Err(err) => {
                    log::warn!("Skipping invalid environment record {}: {}", id, err);
                    Ok(None)
                }
            },
            None => Ok(None),
        }
    }

    #[allow(dead_code)]
    pub async fn upsert_environment(&self, env: &Environment) -> Result<()> {
        self.save_environment(env).await
    }

    pub async fn create_environment(
        &self,
        app_id: String,
        branch: String,
        output_dir: String,
        name: Option<String>,
        description: Option<String>,
    ) -> Result<Environment> {
        let app_config = if app_id == schedule_i_config().app_id {
            schedule_i_config()
        } else {
            return Err(anyhow::anyhow!("Unknown app ID: {}", app_id));
        };

        let branch_config = app_config
            .branches
            .iter()
            .find(|b| b.name == branch)
            .ok_or_else(|| anyhow::anyhow!("Unknown branch: {} for app {}", branch, app_id))?;

        let id = format!("{}-{}-{}", app_id, branch, Uuid::new_v4());

        let branch_name = branch_config
            .display_name
            .replace(" (IL2CPP)", "")
            .replace(" (Mono)", "")
            .trim()
            .to_string();

        let env = Environment {
            id: id.clone(),
            name: name.unwrap_or(branch_name),
            description,
            app_id,
            branch,
            output_dir,
            runtime: branch_config.runtime.clone(),
            status: crate::types::EnvironmentStatus::NotDownloaded,
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
            environment_type: Some(crate::types::EnvironmentType::DepotDownloader),
        };

        let env = self.resolve_environment_for_save(&env).await?;
        let ownership_claim = self.initialize_managed_directory_ownership(&env).await?;
        if let Err(error) = self.save_environment(&env).await {
            self.rollback_managed_directory_claim(ownership_claim).await;
            return Err(error);
        }
        Ok(env)
    }

    pub async fn create_steam_environment(
        &self,
        steam_path: String,
        name: Option<String>,
        description: Option<String>,
    ) -> Result<Environment> {
        let existing_envs = self.fetch_environments().await?;
        if existing_envs.iter().any(|env| {
            env.environment_type == Some(crate::types::EnvironmentType::Steam)
                || env.id.starts_with("steam-")
        }) {
            return Err(anyhow::anyhow!(
                "Steam installation already exists and is managed by Steam"
            ));
        }

        let path = Path::new(&steam_path);
        if !crate::services::steam::SteamService::validate_steam_installation(path)? {
            return Err(anyhow::anyhow!(
                "Invalid Steam installation path: {}",
                steam_path
            ));
        }

        let game_version_service = crate::services::game_version::GameVersionService::new();
        let current_game_version = game_version_service
            .extract_game_version(&steam_path)
            .await?;

        let steam_service = crate::services::steam::SteamService::new();
        let detected_installation = steam_service
            .detect_steam_installations()
            .await
            .ok()
            .and_then(|installations| {
                installations.into_iter().find(|installation| {
                    Self::normalize_path(&installation.path) == Self::normalize_path(&steam_path)
                })
            });
        let runtime_from_files = Self::infer_runtime_from_installation_path(path);
        let detected_branch = if let Some(installation) = detected_installation.as_ref() {
            steam_service
                .detect_installed_branch_for_installation(installation)
                .await
                .ok()
                .flatten()
        } else {
            steam_service
                .detect_installed_branch(path)
                .await
                .ok()
                .flatten()
        };
        let branch =
            detected_branch.unwrap_or_else(|| Self::branch_for_runtime(&runtime_from_files));
        let runtime = runtime_from_files;

        let id = format!("steam-{}", Uuid::new_v4());

        let env = Environment {
            id: id.clone(),
            name: name.unwrap_or_else(|| "Steam Installation".to_string()),
            description,
            app_id: crate::services::steam::SteamService::get_steam_app_id(),
            branch,
            output_dir: steam_path,
            runtime,
            status: crate::types::EnvironmentStatus::Completed,
            last_updated: Some(chrono::Utc::now()),
            size: None,
            last_manifest_id: None,
            last_update_check: None,
            update_available: None,
            remote_manifest_id: None,
            remote_build_id: None,
            current_game_version,
            update_game_version: None,
            melon_loader_version: None,
            steamapps_dir: detected_installation
                .as_ref()
                .and_then(|installation| installation.steamapps_dir.clone()),
            steam_manifest_path: detected_installation
                .as_ref()
                .and_then(|installation| installation.manifest_path.clone()),
            environment_type: Some(crate::types::EnvironmentType::Steam),
        };

        let env = self.resolve_environment_for_save(&env).await?;
        self.save_environment(&env).await?;
        Ok(env)
    }

    pub async fn create_local_environment(
        &self,
        local_path: String,
        name: Option<String>,
        description: Option<String>,
    ) -> Result<Environment> {
        let normalized_local_path = Self::normalize_path(&local_path);
        let existing_envs = self.fetch_environments().await?;
        if existing_envs
            .iter()
            .any(|env| Self::normalize_path(&env.output_dir) == normalized_local_path)
        {
            return Err(anyhow::anyhow!(
                "An environment already exists for this installation path"
            ));
        }

        let path = Path::new(&local_path);

        // Validate installation - check for game executable
        let executable = path.join("Schedule I.exe");
        if !executable.exists() {
            return Err(anyhow::anyhow!(
                "Invalid installation path: Schedule I.exe not found in {}",
                local_path
            ));
        }

        let runtime = Self::infer_runtime_from_installation_path(path);
        let branch = Self::branch_for_runtime(&runtime);

        // Extract game version
        let game_version_service = crate::services::game_version::GameVersionService::new();
        let current_game_version = game_version_service
            .extract_game_version(&local_path)
            .await
            .ok()
            .flatten();

        // Check MelonLoader status
        let melon_loader_version = self.detect_melon_loader_version(path).await;

        let id = format!("local-{}", Uuid::new_v4());

        // Generate default name from folder name
        let default_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "Local Installation".to_string());

        let env = Environment {
            id: id.clone(),
            name: name.unwrap_or(default_name),
            description,
            app_id: crate::services::steam::SteamService::get_steam_app_id(),
            branch,
            output_dir: local_path,
            runtime,
            status: crate::types::EnvironmentStatus::Completed,
            last_updated: Some(chrono::Utc::now()),
            size: None,
            last_manifest_id: None,
            last_update_check: None,
            update_available: None,
            remote_manifest_id: None,
            remote_build_id: None,
            current_game_version,
            update_game_version: None,
            melon_loader_version,
            steamapps_dir: None,
            steam_manifest_path: None,
            environment_type: Some(crate::types::EnvironmentType::Local),
        };

        let env = self.resolve_environment_for_save(&env).await?;
        self.save_environment(&env).await?;

        Ok(env)
    }

    async fn detect_melon_loader_version(&self, game_path: &Path) -> Option<String> {
        // Check for MelonLoader by looking for version.dll or MelonLoader folder
        let melon_loader_dir = game_path.join("MelonLoader");
        if !melon_loader_dir.exists() {
            return None;
        }

        // Try to read version from MelonLoader.dll or net6/MelonLoader.dll
        let possible_paths = [
            melon_loader_dir.join("MelonLoader.dll"),
            melon_loader_dir.join("net6").join("MelonLoader.dll"),
            melon_loader_dir.join("net35").join("MelonLoader.dll"),
        ];

        for dll_path in &possible_paths {
            if dll_path.exists() {
                // MelonLoader is installed, but we can't easily read version from DLL
                // Return a placeholder indicating it's installed
                return Some("installed".to_string());
            }
        }

        // Check for version.dll as another indicator
        if game_path.join("version.dll").exists() {
            return Some("installed".to_string());
        }

        None
    }

    pub async fn update_environment(
        &self,
        id: &str,
        updates: impl IntoIterator<Item = (String, serde_json::Value)>,
    ) -> Result<Environment> {
        let _mutation_guard = ENVIRONMENT_MUTATION_LOCK.lock().await;
        let mut env = self
            .get_environment(id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Environment {} not found", id))?;

        for (key, value) in updates {
            match key.as_str() {
                "name" => {
                    if let Some(v) = value.as_str() {
                        env.name = v.to_string();
                    }
                }
                "description" => {
                    env.description = value.as_str().map(|s| s.to_string());
                }
                // These fields are restricted to backend reconciliation paths;
                // callers update only what they observed instead of saving a
                // stale whole environment payload over user-owned fields.
                "branch" => {
                    if let Some(v) = value.as_str() {
                        env.branch = v.to_string();
                    }
                }
                "runtime" => {
                    if let Some(v) = value.as_str() {
                        env.runtime = match v {
                            "IL2CPP" | "Il2cpp" => Runtime::Il2cpp,
                            "Mono" | "MONO" => Runtime::Mono,
                            _ => return Err(anyhow::anyhow!("Invalid runtime: {}", v)),
                        };
                    }
                }
                "outputDir" => {
                    if let Some(v) = value.as_str() {
                        env.output_dir = v.to_string();
                    }
                }
                "steamappsDir" => {
                    env.steamapps_dir = value.as_str().map(ToString::to_string);
                }
                "steamManifestPath" => {
                    env.steam_manifest_path = value.as_str().map(ToString::to_string);
                }
                "status" => {
                    if let Some(v) = value.as_str() {
                        env.status = match v {
                            "not_downloaded" => crate::types::EnvironmentStatus::NotDownloaded,
                            "downloading" => crate::types::EnvironmentStatus::Downloading,
                            "completed" => crate::types::EnvironmentStatus::Completed,
                            "unavailable" => crate::types::EnvironmentStatus::Unavailable,
                            "error" => crate::types::EnvironmentStatus::Error,
                            _ => return Err(anyhow::anyhow!("Invalid status: {}", v)),
                        };
                    }
                }
                "lastUpdated" => {}
                "size" => {
                    if let Some(v) = value.as_u64() {
                        env.size = Some(v);
                    }
                }
                "lastManifestId" => {
                    if let Some(v) = value.as_str() {
                        env.last_manifest_id = Some(v.to_string());
                    } else if value.is_null() {
                        env.last_manifest_id = None;
                    }
                }
                "lastUpdateCheck" => {
                    if let Some(timestamp) = value.as_i64() {
                        if let Some(dt) = DateTime::from_timestamp(timestamp, 0) {
                            env.last_update_check = Some(dt.with_timezone(&Utc));
                        } else {
                            log::warn!("Invalid timestamp for lastUpdateCheck: {}", timestamp);
                        }
                    } else if value.is_null() {
                        env.last_update_check = None;
                    } else {
                        log::warn!("Unexpected type for lastUpdateCheck: {:?}", value);
                    }
                }
                "updateAvailable" => {
                    if let Some(v) = value.as_bool() {
                        env.update_available = Some(v);
                    }
                }
                "remoteManifestId" => {
                    if let Some(v) = value.as_str() {
                        env.remote_manifest_id = Some(v.to_string());
                    } else if value.is_null() {
                        env.remote_manifest_id = None;
                    }
                }
                "remoteBuildId" => {
                    if let Some(v) = value.as_str() {
                        env.remote_build_id = Some(v.to_string());
                    } else if value.is_null() {
                        env.remote_build_id = None;
                    }
                }
                "currentGameVersion" => {
                    if let Some(v) = value.as_str() {
                        env.current_game_version = Some(v.to_string());
                    } else if value.is_null() {
                        env.current_game_version = None;
                    }
                }
                "updateGameVersion" => {
                    if let Some(v) = value.as_str() {
                        env.update_game_version = Some(v.to_string());
                    } else if value.is_null() {
                        env.update_game_version = None;
                    }
                }
                "melonLoaderVersion" => {
                    if let Some(v) = value.as_str() {
                        env.melon_loader_version = Some(v.to_string());
                    }
                }
                _ => {}
            }
        }

        self.save_environment(&env).await?;
        Ok(env)
    }

    pub async fn delete_environment(&self, id: &str, delete_files: bool) -> Result<bool> {
        let _mutation_guard = ENVIRONMENT_MUTATION_LOCK.lock().await;
        let env = self.get_environment(id).await?;

        if let Some(env) = env {
            if env.environment_type == Some(crate::types::EnvironmentType::Steam)
                || env.id.starts_with("steam-")
            {
                self.clear_environment_metadata(id).await?;

                let mut updated_env = env.clone();
                let current_path_valid =
                    crate::services::steam::SteamService::validate_steam_installation(Path::new(
                        &updated_env.output_dir,
                    ))
                    .unwrap_or(false);

                if current_path_valid {
                    updated_env.status = crate::types::EnvironmentStatus::Completed;
                } else {
                    let steam_service = crate::services::steam::SteamService::new();
                    if let Ok(installations) = steam_service.detect_steam_installations().await {
                        if let Some(installation) = installations.first() {
                            updated_env.output_dir = installation.path.clone();
                            updated_env.status = crate::types::EnvironmentStatus::Completed;
                        } else {
                            updated_env.status = crate::types::EnvironmentStatus::Unavailable;
                        }
                    } else {
                        updated_env.status = crate::types::EnvironmentStatus::Unavailable;
                    }
                }

                updated_env.last_updated = Some(chrono::Utc::now());
                self.save_environment(&updated_env).await?;
                return Ok(true);
            }

            // Only delete files if explicitly requested.  An environment record can
            // originate from stale JSON or a malformed IPC caller, so the record is
            // not itself authority to recursively remove its output directory.
            let should_delete_files = delete_files
                && env.environment_type != Some(crate::types::EnvironmentType::Steam)
                && Path::new(&env.output_dir).exists();

            // Record intent durably before the first filesystem mutation. The
            // journal survives every later boundary and is removed only after
            // the staged tree is either restored or deleted successfully.
            let staged_directory = if should_delete_files {
                let deletion_target = self.validate_environment_file_deletion(&env).await?;
                let parent = deletion_target
                    .parent()
                    .ok_or_else(|| anyhow::anyhow!("Environment directory has no parent"))?;
                let staged = parent.join(format!(".simm-delete-{}", Uuid::new_v4()));
                let entry = self
                    .create_environment_deletion_journal(&env, &deletion_target, &staged)
                    .await?;
                if let Err(stage_error) = tokio::fs::rename(&deletion_target, &staged).await {
                    let clear_result = self.clear_environment_deletion_journal(id).await;
                    return match clear_result {
                        Ok(()) => Err(stage_error).with_context(|| {
                            format!(
                                "Failed to stage environment directory {}",
                                deletion_target.display()
                            )
                        }),
                        Err(clear_error) => Err(anyhow::anyhow!(
                            "Failed to stage environment directory {}; deletion journal remains for recovery: {:#}; journal cleanup also failed: {:#}",
                            deletion_target.display(),
                            stage_error,
                            clear_error
                        )),
                    };
                }
                if let Err(state_error) = self
                    .update_environment_deletion_journal(id, "staged", None)
                    .await
                {
                    let restore_result =
                        self.restore_staged_environment_deletion(&entry, &env).await;
                    if restore_result.is_ok() {
                        let _ = self.clear_environment_deletion_journal(id).await;
                    }
                    return Err(match restore_result {
                        Ok(()) => anyhow::anyhow!(
                            "Failed to record staged environment deletion and restored the original directory: {state_error:#}"
                        ),
                        Err(restore_error) => anyhow::anyhow!(
                            "Failed to record staged environment deletion; recovery journal retained after restore failure: {state_error:#}; restore error: {restore_error:#}"
                        ),
                    });
                }
                Some(entry)
            } else {
                None
            };

            let mutation = async {
                let mut transaction = self
                    .pool
                    .begin()
                    .await
                    .context("Failed to begin environment deletion")?;
                Self::clear_environment_metadata_in_transaction(&mut transaction, id).await?;
                sqlx::query("DELETE FROM environment_profiles WHERE environment_id = ?")
                    .bind(id)
                    .execute(&mut *transaction)
                    .await
                    .context("Failed to clear environment profile mapping")?;
                let deleted = sqlx::query("DELETE FROM environments WHERE id = ?")
                    .bind(id)
                    .execute(&mut *transaction)
                    .await
                    .context("Failed to delete environment")?;
                if deleted.rows_affected() != 1 {
                    anyhow::bail!("Environment {} disappeared during deletion", id);
                }
                if staged_directory.is_some() {
                    let updated = sqlx::query(
                        "UPDATE environment_deletion_journal \
                         SET state = 'metadata_deleted', last_error = NULL, updated_at = ? \
                         WHERE environment_id = ?",
                    )
                    .bind(Utc::now().to_rfc3339())
                    .bind(id)
                    .execute(&mut *transaction)
                    .await
                    .context("Failed to commit environment deletion recovery state")?;
                    if updated.rows_affected() != 1 {
                        anyhow::bail!("Environment deletion journal disappeared before commit");
                    }
                }
                if take_delete_failure(DELETE_FAILURE_DB_COMMIT) {
                    transaction
                        .rollback()
                        .await
                        .context("Failed to roll back injected environment deletion failure")?;
                    anyhow::bail!("Injected environment deletion failure at database commit");
                }
                transaction
                    .commit()
                    .await
                    .context("Failed to commit environment deletion")
            }
            .await;

            if let Err(error) = mutation {
                if let Some(entry) = staged_directory.as_ref() {
                    let error_text = format!("{error:#}");
                    let _ = self
                        .update_environment_deletion_journal(
                            id,
                            "restore_required",
                            Some(&error_text),
                        )
                        .await;
                    match self.restore_staged_environment_deletion(entry, &env).await {
                        Ok(()) => {
                            if let Err(clear_error) =
                                self.clear_environment_deletion_journal(id).await
                            {
                                return Err(anyhow::anyhow!(
                                    "Environment deletion failed and files were restored, but its recovery journal remains: {error:#}; journal error: {clear_error:#}"
                                ));
                            }
                        }
                        Err(restore_error) => {
                            let restore_text = format!("{restore_error:#}");
                            let _ = self
                                .update_environment_deletion_journal(
                                    id,
                                    "restore_required",
                                    Some(&restore_text),
                                )
                                .await;
                            return Err(anyhow::anyhow!(
                                "Environment deletion transaction failed and the staged directory could not be restored; durable recovery is pending: {error:#}; restore error: {restore_error:#}"
                            ));
                        }
                    }
                }
                return Err(error);
            }

            crate::services::mods_snapshot_cache::remove(id).await;
            if let Some(entry) = staged_directory {
                if let Err(error) = self
                    .finalize_staged_environment_deletion(&entry, &env)
                    .await
                {
                    let error_text = format!("{error:#}");
                    let journal_error = self
                        .update_environment_deletion_journal(
                            id,
                            "metadata_deleted",
                            Some(&error_text),
                        )
                        .await
                        .err();
                    notify_scheduler_of_environment_change();
                    return Err(match journal_error {
                        Some(journal_error) => anyhow::anyhow!(
                            "Environment metadata was deleted, but staged file finalization failed and recovery-state update also failed: {error:#}; journal error: {journal_error:#}"
                        ),
                        None => anyhow::anyhow!(
                            "Environment metadata was deleted, but staged files remain under durable recovery state at {}: {error:#}",
                            entry.staged_path
                        ),
                    });
                }
            }
            notify_scheduler_of_environment_change();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Validates a recursive-deletion target without mutating the database. The
    /// only filesystem mutation it may perform is a constrained one-time ownership
    /// marker migration for a strict child of the configured managed download root.
    /// The command wrapper calls this before stopping watchers and
    /// `delete_environment` calls it again immediately before staging.
    pub async fn validate_environment_file_deletion(&self, env: &Environment) -> Result<PathBuf> {
        if env.environment_type != Some(EnvironmentType::DepotDownloader) {
            return Err(anyhow::anyhow!(
                "File deletion is only supported for SIMM-managed DepotDownloader environments"
            ));
        }

        let configured_path = Path::new(&env.output_dir);
        let metadata = tokio::fs::symlink_metadata(configured_path)
            .await
            .context("Failed to inspect environment directory")?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(anyhow::anyhow!(
                "Environment directory must be a real directory before deletion"
            ));
        }

        let canonical_target = tokio::fs::canonicalize(configured_path)
            .await
            .context("Failed to resolve environment directory")?;
        if canonical_target.parent().is_none() {
            return Err(anyhow::anyhow!("Refusing to delete a filesystem root"));
        }

        let protected_roots = self.protected_deletion_roots().await?;
        if protected_roots.iter().any(|protected| {
            canonical_target == *protected || protected.starts_with(&canonical_target)
        }) {
            return Err(anyhow::anyhow!(
                "Refusing to delete a protected SIMM, home, or filesystem root"
            ));
        }

        if Self::is_below_steam_library(&canonical_target) {
            return Err(anyhow::anyhow!(
                "Refusing to delete a path inside a Steam library"
            ));
        }

        Self::validate_depot_installation_artifacts(&canonical_target).await?;
        self.ensure_ownership_marker(env, &canonical_target).await?;

        // Resolve and validate once more after any legacy migration. This is the
        // final lookup before the caller stages the directory for deletion.
        let final_metadata = tokio::fs::symlink_metadata(configured_path)
            .await
            .context("Failed to re-inspect environment directory before deletion")?;
        if final_metadata.file_type().is_symlink() || !final_metadata.is_dir() {
            return Err(anyhow::anyhow!(
                "Environment directory changed before deletion"
            ));
        }
        let final_target = tokio::fs::canonicalize(configured_path)
            .await
            .context("Failed to re-resolve environment directory before deletion")?;
        if !Self::paths_equal(&canonical_target, &final_target) {
            return Err(anyhow::anyhow!(
                "Environment directory changed before deletion"
            ));
        }
        Self::validate_depot_installation_artifacts(&final_target).await?;
        Self::validate_ownership_marker_at(env, &final_target, &final_target).await?;

        Ok(final_target)
    }

    async fn validate_staged_environment_file_deletion(
        &self,
        env: &Environment,
        original_canonical_root: &Path,
        staged_path: &Path,
    ) -> Result<PathBuf> {
        let metadata = tokio::fs::symlink_metadata(staged_path)
            .await
            .context("Failed to inspect staged environment directory")?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(anyhow::anyhow!(
                "Staged environment directory must be a real directory"
            ));
        }
        let canonical_staged = tokio::fs::canonicalize(staged_path)
            .await
            .context("Failed to resolve staged environment directory")?;
        let original_parent = original_canonical_root
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Environment directory has no parent"))?;
        let staged_parent = canonical_staged
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Staged environment directory has no parent"))?;
        if !Self::paths_equal(&canonical_staged, staged_path)
            || !Self::paths_equal(staged_parent, original_parent)
        {
            return Err(anyhow::anyhow!(
                "Staged environment directory escaped its validated parent"
            ));
        }

        Self::validate_depot_installation_artifacts(&canonical_staged).await?;
        Self::validate_ownership_marker_at(env, &canonical_staged, original_canonical_root).await?;
        Ok(canonical_staged)
    }

    async fn protected_deletion_roots(&self) -> Result<Vec<PathBuf>> {
        let mut roots = Vec::new();
        if let Ok(data_dir) = crate::db::get_data_dir() {
            if let Ok(canonical) = tokio::fs::canonicalize(data_dir).await {
                roots.push(canonical);
            }
        }
        if let Some(home_dir) = dirs::home_dir() {
            if let Ok(canonical) = tokio::fs::canonicalize(home_dir).await {
                roots.push(canonical);
            }
        }

        if let Ok(current_dir) = std::env::current_dir() {
            if let Some(root) = current_dir.ancestors().last() {
                roots.push(root.to_path_buf());
            }
        }

        Ok(roots)
    }

    fn is_below_steam_library(path: &Path) -> bool {
        path.ancestors().any(|ancestor| {
            ancestor
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("steamapps"))
        })
    }
}

#[cfg(test)]
mod runtime_detection_tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn infer_runtime_prefers_mono_bleeding_edge_over_stale_gameassembly() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();

        // Simulate stale IL2CPP binary leftover.
        std::fs::write(root.join("GameAssembly.dll"), b"stale").expect("write GameAssembly");

        // Simulate Mono backend markers.
        let mono_dir = root.join("Schedule I_Data").join("MonoBleedingEdge");
        std::fs::create_dir_all(&mono_dir).expect("create MonoBleedingEdge");
        std::fs::create_dir_all(root.join("Schedule I_Data").join("Managed"))
            .expect("create Managed");
        std::fs::write(
            root.join("Schedule I_Data")
                .join("Managed")
                .join("Assembly-CSharp.dll"),
            b"mono",
        )
        .expect("write Assembly-CSharp");

        assert!(matches!(
            EnvironmentService::infer_runtime_from_installation_path(root),
            Runtime::Mono
        ));
    }

    #[test]
    fn infer_runtime_detects_il2cpp_data_folder() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();

        std::fs::create_dir_all(root.join("Schedule I_Data").join("il2cpp_data"))
            .expect("create il2cpp_data");

        assert!(matches!(
            EnvironmentService::infer_runtime_from_installation_path(root),
            Runtime::Il2cpp
        ));
    }
}

impl Clone for EnvironmentService {
    fn clone(&self) -> Self {
        Self {
            pool: Arc::clone(&self.pool),
            runtime_settings: self.runtime_settings.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::initialize_pool;
    use crate::types::{EnvironmentStatus, EnvironmentType, Runtime};
    use serial_test::serial;
    use tempfile::tempdir;
    use tokio::fs;

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

    struct DeleteFailureGuard;

    impl DeleteFailureGuard {
        fn inject(flags: u8) -> Self {
            DELETE_FAILURES.store(flags, Ordering::SeqCst);
            Self
        }
    }

    impl Drop for DeleteFailureGuard {
        fn drop(&mut self) {
            DELETE_FAILURES.store(0, Ordering::SeqCst);
        }
    }

    fn depot_environment(id: impl Into<String>, output_dir: &Path) -> Environment {
        Environment {
            id: id.into(),
            name: "Managed fixture".to_string(),
            description: None,
            app_id: schedule_i_config().app_id,
            branch: "main".to_string(),
            output_dir: output_dir.to_string_lossy().to_string(),
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::Completed,
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
            environment_type: Some(EnvironmentType::DepotDownloader),
        }
    }

    fn settings_with_download_root(root: &Path) -> Settings {
        let mut settings = crate::services::settings::SettingsService::default_settings();
        settings.default_download_dir = root.to_string_lossy().to_string();
        settings
    }

    async fn create_deletable_environment(
        service: &EnvironmentService,
        output_dir: &Path,
    ) -> Result<Environment> {
        let env = service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;
        fs::create_dir_all(output_dir.join(".DepotDownloader")).await?;
        fs::write(output_dir.join("Schedule I.exe"), b"game").await?;
        Ok(env)
    }

    async fn assert_finalization_failure_is_restart_recoverable(
        failure: u8,
        expected_boundary: &str,
    ) -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool.clone())?;
        let output_dir = temp.path().join("managed").join("recover-finalize");
        let env = create_deletable_environment(&service, &output_dir).await?;

        let failure_guard = DeleteFailureGuard::inject(failure);
        let error = service
            .delete_environment(&env.id, true)
            .await
            .expect_err("finalization failure must be returned to the caller");
        assert!(error.to_string().contains(expected_boundary));
        assert!(service.get_environment(&env.id).await?.is_none());
        assert!(!output_dir.exists());

        let entry = service
            .list_environment_deletion_journals()
            .await?
            .into_iter()
            .find(|entry| entry.environment_id == env.id)
            .expect("committed deletion must retain a recovery journal");
        assert_eq!(entry.state, "metadata_deleted");
        assert!(Path::new(&entry.staged_path).exists());

        drop(failure_guard);
        let report = service.recover_pending_environment_deletions().await?;
        assert_eq!(report.finalized, 1);
        assert_eq!(report.restored, 0);
        assert_eq!(report.pending, 0);
        assert!(!Path::new(&entry.staged_path).exists());
        assert!(service
            .list_environment_deletion_journals()
            .await?
            .is_empty());
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn create_and_fetch_environment() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool)?;

        let output_dir = temp.path().join("envs").join("env-1");
        let env = service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                Some("Test env".to_string()),
            )
            .await?;

        assert!(env.id.starts_with("3164500-main-"));
        assert_eq!(env.name, "Main");
        assert_eq!(env.description.as_deref(), Some("Test env"));
        assert_eq!(env.branch, "main");
        assert!(matches!(env.runtime, Runtime::Il2cpp));
        assert!(matches!(env.status, EnvironmentStatus::NotDownloaded));
        assert!(matches!(
            env.environment_type,
            Some(EnvironmentType::DepotDownloader)
        ));

        let stored = service.get_environment(&env.id).await?;
        assert!(stored.is_some());
        let canonical_root = fs::canonicalize(&output_dir).await?;
        let marker_content = fs::read(canonical_root.join(MANAGED_ENVIRONMENT_MARKER_FILE)).await?;
        let marker: ManagedEnvironmentOwnershipMarker = serde_json::from_slice(&marker_content)?;
        assert_eq!(marker.environment_id, env.id);
        assert_eq!(
            marker.environment_uuid,
            EnvironmentService::managed_environment_uuid(&env.id).map(|uuid| uuid.to_string())
        );
        assert_eq!(
            EnvironmentService::normalize_path(&marker.canonical_root),
            EnvironmentService::normalize_path(canonical_root.to_string_lossy().as_ref())
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn delete_environment_rejects_arbitrary_directory_with_generic_depot_artifacts(
    ) -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let managed_root = temp.path().join("managed-downloads");
        fs::create_dir_all(&managed_root).await?;
        let service = EnvironmentService::new(pool.clone())?
            .with_runtime_settings(settings_with_download_root(&managed_root));

        let arbitrary_dir = temp.path().join("arbitrary-custom-install");
        fs::create_dir_all(arbitrary_dir.join(".DepotDownloader")).await?;
        fs::write(arbitrary_dir.join("Schedule I.exe"), b"game").await?;
        let env = depot_environment(format!("3164500-main-{}", Uuid::new_v4()), &arbitrary_dir);
        service.upsert_environment(&env).await?;

        let error = service
            .delete_environment(&env.id, true)
            .await
            .expect_err("generic artifacts outside the managed root must not grant deletion");
        assert!(error.to_string().contains("ownership marker is missing"));
        assert!(arbitrary_dir.exists());
        assert!(service.get_environment(&env.id).await?.is_some());
        assert!(!arbitrary_dir.join(MANAGED_ENVIRONMENT_MARKER_FILE).exists());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn delete_environment_migrates_legacy_timestamp_id_only_under_managed_root() -> Result<()>
    {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let managed_root = temp.path().join("managed-downloads");
        let legacy_dir = managed_root.join("legacy-main");
        fs::create_dir_all(legacy_dir.join(".DepotDownloader")).await?;
        fs::write(legacy_dir.join("Schedule I.exe"), b"game").await?;
        let service = EnvironmentService::new(pool.clone())?
            .with_runtime_settings(settings_with_download_root(&managed_root));
        let env = depot_environment("3164500-main-1712345678901", &legacy_dir);
        service.upsert_environment(&env).await?;

        let validated = service.validate_environment_file_deletion(&env).await?;
        assert!(EnvironmentService::paths_equal(&validated, &legacy_dir));
        let marker_content = fs::read(legacy_dir.join(MANAGED_ENVIRONMENT_MARKER_FILE)).await?;
        let marker: ManagedEnvironmentOwnershipMarker = serde_json::from_slice(&marker_content)?;
        assert_eq!(marker.environment_id, env.id);
        assert_eq!(marker.environment_uuid, None);

        assert!(service.delete_environment(&env.id, true).await?);
        assert!(!legacy_dir.exists());
        assert!(service.get_environment(&env.id).await?.is_none());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn delete_environment_rejects_ownership_marker_for_another_environment() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool.clone())?;
        let output_dir = temp.path().join("managed").join("marker-mismatch");
        let env = service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;
        fs::create_dir_all(output_dir.join(".DepotDownloader")).await?;
        fs::write(output_dir.join("Schedule I.exe"), b"game").await?;

        let marker_path = output_dir.join(MANAGED_ENVIRONMENT_MARKER_FILE);
        let mut marker: ManagedEnvironmentOwnershipMarker =
            serde_json::from_slice(&fs::read(&marker_path).await?)?;
        marker.environment_id = format!("3164500-main-{}", Uuid::new_v4());
        fs::write(&marker_path, serde_json::to_vec_pretty(&marker)?).await?;

        let error = service
            .delete_environment(&env.id, true)
            .await
            .expect_err("a mismatched ownership marker must be rejected");
        assert!(error.to_string().contains("does not match"));
        assert!(output_dir.exists());
        assert!(service.get_environment(&env.id).await?.is_some());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn delete_environment_rejects_a_moved_managed_root() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool.clone())?;
        let original_dir = temp.path().join("managed").join("original");
        let moved_dir = temp.path().join("managed").join("moved");
        let env = service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                original_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;
        fs::create_dir_all(original_dir.join(".DepotDownloader")).await?;
        fs::write(original_dir.join("Schedule I.exe"), b"game").await?;
        fs::rename(&original_dir, &moved_dir).await?;

        let mut moved_env = env.clone();
        moved_env.output_dir = moved_dir.to_string_lossy().to_string();
        service.upsert_environment(&moved_env).await?;
        let error = service
            .delete_environment(&env.id, true)
            .await
            .expect_err("a marker bound to the original canonical root must reject a move");
        assert!(error.to_string().contains("does not match"));
        assert!(moved_dir.exists());
        assert!(service.get_environment(&env.id).await?.is_some());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn steam_reconcile_uses_installed_runtime_markers_when_public_branch_changes_backend(
    ) -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool)?;
        let game_dir = temp
            .path()
            .join("steamapps")
            .join("common")
            .join("Schedule I");
        fs::create_dir_all(game_dir.join("Schedule I_Data").join("MonoBleedingEdge")).await?;
        for folder in ["Mods", "Plugins", "UserLibs"] {
            fs::create_dir_all(game_dir.join(folder)).await?;
        }
        fs::write(game_dir.join("Schedule I.exe"), b"game").await?;
        let manifest_path = temp
            .path()
            .join("steamapps")
            .join("appmanifest_3164500.acf");
        fs::write(
            &manifest_path,
            "\"AppState\"\n{\n  \"installdir\" \"Schedule I\"\n}\n",
        )
        .await?;

        let mut environment = Environment {
            id: "steam-main".to_string(),
            name: "Steam Installation".to_string(),
            description: None,
            app_id: "3164500".to_string(),
            branch: "closed-beta".to_string(),
            output_dir: game_dir.to_string_lossy().to_string(),
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::Completed,
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
            steamapps_dir: Some(temp.path().join("steamapps").to_string_lossy().to_string()),
            steam_manifest_path: Some(manifest_path.to_string_lossy().to_string()),
            environment_type: Some(EnvironmentType::Steam),
        };
        service.save_environment(&environment).await?;

        let result = service
            .reconcile_steam_env_branch_runtime_from_disk(&mut environment)
            .await?
            .expect("runtime switch result");

        assert_eq!(environment.branch, "main");
        assert_eq!(environment.runtime, Runtime::Mono);
        assert_eq!(result.previous_runtime, Runtime::Il2cpp);
        assert_eq!(result.runtime, Runtime::Mono);
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn update_environment_updates_fields() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool)?;

        let output_dir = temp.path().join("envs").join("env-2");
        let env = service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let timestamp = 1_700_000_000i64;
        let updates = vec![
            ("name".to_string(), serde_json::json!("Updated")),
            ("description".to_string(), serde_json::json!("New desc")),
            ("status".to_string(), serde_json::json!("completed")),
            ("size".to_string(), serde_json::json!(1234)),
            ("lastManifestId".to_string(), serde_json::json!("manifest")),
            ("lastUpdateCheck".to_string(), serde_json::json!(timestamp)),
            ("updateAvailable".to_string(), serde_json::json!(true)),
            ("remoteManifestId".to_string(), serde_json::json!("remote")),
            ("remoteBuildId".to_string(), serde_json::json!("build")),
            ("currentGameVersion".to_string(), serde_json::json!("1.0.0")),
            ("updateGameVersion".to_string(), serde_json::json!("1.0.1")),
            ("melonLoaderVersion".to_string(), serde_json::json!("0.6.0")),
        ];

        let updated = service.update_environment(&env.id, updates).await?;
        assert_eq!(updated.name, "Updated");
        assert_eq!(updated.description.as_deref(), Some("New desc"));
        assert!(matches!(updated.status, EnvironmentStatus::Completed));
        assert_eq!(updated.size, Some(1234));
        assert_eq!(updated.last_manifest_id.as_deref(), Some("manifest"));
        assert_eq!(
            updated.last_update_check.map(|dt| dt.timestamp()),
            Some(timestamp)
        );
        assert_eq!(updated.update_available, Some(true));
        assert_eq!(updated.remote_manifest_id.as_deref(), Some("remote"));
        assert_eq!(updated.remote_build_id.as_deref(), Some("build"));
        assert_eq!(updated.current_game_version.as_deref(), Some("1.0.0"));
        assert_eq!(updated.update_game_version.as_deref(), Some("1.0.1"));
        assert_eq!(updated.melon_loader_version.as_deref(), Some("0.6.0"));

        let unavailable = service
            .update_environment(
                &env.id,
                vec![("status".to_string(), serde_json::json!("unavailable"))],
            )
            .await?;
        assert!(matches!(unavailable.status, EnvironmentStatus::Unavailable));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn update_environment_rejects_invalid_status() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool)?;

        let output_dir = temp.path().join("envs").join("env-3");
        let env = service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let updates = vec![("status".to_string(), serde_json::json!("bad"))];
        let err = service
            .update_environment(&env.id, updates)
            .await
            .expect_err("expected invalid status error");
        assert!(err.to_string().contains("Invalid status"));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn delete_environment_removes_dir_and_row() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool.clone())?;

        let output_dir = temp.path().join("envs").join("env-4");
        let env = service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                Some("Delete".to_string()),
                None,
            )
            .await?;
        fs::write(output_dir.join("file.txt"), b"test").await?;
        fs::create_dir_all(output_dir.join(".DepotDownloader")).await?;
        fs::write(output_dir.join("Schedule I.exe"), b"game").await?;
        assert!(output_dir.join(MANAGED_ENVIRONMENT_MARKER_FILE).is_file());

        sqlx::query(
            "INSERT INTO mod_metadata (environment_id, kind, file_name, data) VALUES (?, 'mods', ?, ?)",
        )
        .bind(&env.id)
        .bind("example.dll")
        .bind("{}")
        .execute(&*pool)
        .await?;
        sqlx::query(
            "INSERT INTO profiles (id, name, runtime, is_default, manifest, created_at, updated_at) \
             VALUES ('profile-delete-test', 'Delete test', 'IL2CPP', 0, '{}', '2026-01-01', '2026-01-01')",
        )
        .execute(&*pool)
        .await?;
        sqlx::query(
            "INSERT INTO environment_profiles (environment_id, active_profile_id) VALUES (?, 'profile-delete-test')",
        )
        .bind(&env.id)
        .execute(&*pool)
        .await?;

        let deleted = service.delete_environment(&env.id, true).await?;
        assert!(deleted);
        assert!(!output_dir.exists());
        assert!(service.get_environment(&env.id).await?.is_none());

        let metadata_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM mod_metadata WHERE environment_id = ?")
                .bind(&env.id)
                .fetch_one(&*pool)
                .await?;
        assert_eq!(metadata_count, 0);
        let profile_mapping_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM environment_profiles WHERE environment_id = ?",
        )
        .bind(&env.id)
        .fetch_one(&*pool)
        .await?;
        assert_eq!(profile_mapping_count, 0);

        let deleted_missing = service.delete_environment("missing", true).await?;
        assert!(!deleted_missing);

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn delete_environment_journals_staged_revalidation_failure_for_restart() -> Result<()> {
        assert_finalization_failure_is_restart_recoverable(
            DELETE_FAILURE_STAGED_REVALIDATION,
            "staged revalidation",
        )
        .await
    }

    #[tokio::test]
    #[serial]
    async fn delete_environment_journals_remove_failure_for_restart() -> Result<()> {
        assert_finalization_failure_is_restart_recoverable(
            DELETE_FAILURE_REMOVE,
            "staged tree removal",
        )
        .await
    }

    #[tokio::test]
    #[serial]
    async fn delete_environment_db_commit_failure_restores_files_and_row() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool.clone())?;
        let output_dir = temp.path().join("managed").join("commit-rollback");
        let env = create_deletable_environment(&service, &output_dir).await?;

        let _failure_guard = DeleteFailureGuard::inject(DELETE_FAILURE_DB_COMMIT);
        let error = service
            .delete_environment(&env.id, true)
            .await
            .expect_err("injected commit failure must be returned");

        assert!(error.to_string().contains("database commit"));
        assert!(service.get_environment(&env.id).await?.is_some());
        assert!(output_dir.exists());
        assert!(service
            .list_environment_deletion_journals()
            .await?
            .is_empty());
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn delete_environment_restore_failure_remains_journaled_and_restart_repairs_it(
    ) -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool.clone())?;
        let output_dir = temp.path().join("managed").join("restore-retry");
        let env = create_deletable_environment(&service, &output_dir).await?;

        let failure_guard =
            DeleteFailureGuard::inject(DELETE_FAILURE_DB_COMMIT | DELETE_FAILURE_RESTORE_RENAME);
        let error = service
            .delete_environment(&env.id, true)
            .await
            .expect_err("commit plus restore failure must remain recoverable");

        assert!(error.to_string().contains("durable recovery is pending"));
        assert!(service.get_environment(&env.id).await?.is_some());
        assert!(!output_dir.exists());
        let entry = service
            .list_environment_deletion_journals()
            .await?
            .into_iter()
            .find(|entry| entry.environment_id == env.id)
            .expect("restore failure must retain its journal");
        assert_eq!(entry.state, "restore_required");
        assert!(Path::new(&entry.staged_path).exists());

        drop(failure_guard);
        let report = service.recover_pending_environment_deletions().await?;
        assert_eq!(report.restored, 1);
        assert_eq!(report.finalized, 0);
        assert_eq!(report.pending, 0);
        assert!(output_dir.exists());
        assert!(!Path::new(&entry.staged_path).exists());
        assert!(service.get_environment(&env.id).await?.is_some());
        assert!(service
            .list_environment_deletion_journals()
            .await?
            .is_empty());
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn concurrent_field_updates_preserve_disjoint_environment_changes() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool)?;
        let environment = service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                temp.path()
                    .join("environment")
                    .to_string_lossy()
                    .to_string(),
                Some("Original".to_string()),
                None,
            )
            .await?;

        let first = service.update_environment(
            &environment.id,
            vec![("name".to_string(), serde_json::json!("Renamed"))],
        );
        let second = service.update_environment(
            &environment.id,
            vec![("status".to_string(), serde_json::json!("downloading"))],
        );
        let (first_result, second_result) = tokio::join!(first, second);
        first_result?;
        second_result?;

        let persisted = service
            .get_environment(&environment.id)
            .await?
            .expect("environment should still exist");
        assert_eq!(persisted.name, "Renamed");
        assert!(matches!(persisted.status, EnvironmentStatus::Downloading));
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn delete_environment_rejects_unmanaged_or_protected_directories() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool.clone())?;

        let local_dir = temp.path().join("local-install");
        fs::create_dir_all(&local_dir).await?;
        fs::write(local_dir.join("Schedule I.exe"), b"game").await?;
        let local_env = Environment {
            id: "local-delete-guard".to_string(),
            name: "Local".to_string(),
            description: None,
            app_id: schedule_i_config().app_id,
            branch: "main".to_string(),
            output_dir: local_dir.to_string_lossy().to_string(),
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::Completed,
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
            environment_type: Some(EnvironmentType::Local),
        };
        service.upsert_environment(&local_env).await?;

        let err = service
            .delete_environment(&local_env.id, true)
            .await
            .expect_err("local imports must never receive recursive cleanup");
        assert!(err.to_string().contains("SIMM-managed DepotDownloader"));
        assert!(local_dir.exists());
        assert!(service.get_environment(&local_env.id).await?.is_some());

        fs::create_dir_all(data_dir.join(".DepotDownloader")).await?;
        fs::write(data_dir.join("Schedule I.exe"), b"game").await?;
        let protected_env = Environment {
            id: "protected-delete-guard".to_string(),
            name: "Protected".to_string(),
            description: None,
            app_id: schedule_i_config().app_id,
            branch: "main".to_string(),
            output_dir: data_dir.to_string_lossy().to_string(),
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::Completed,
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
            environment_type: Some(EnvironmentType::DepotDownloader),
        };
        service.upsert_environment(&protected_env).await?;
        let err = service
            .delete_environment(&protected_env.id, true)
            .await
            .expect_err("SIMM data root must be protected");
        assert!(err.to_string().contains("protected"));
        assert!(data_dir.exists());
        assert!(service.get_environment(&protected_env.id).await?.is_some());

        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    #[serial]
    async fn delete_environment_rejects_a_symlinked_depot_target() -> Result<()> {
        use std::os::unix::fs::symlink;

        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool.clone())?;

        let target = temp.path().join("outside");
        fs::create_dir_all(target.join(".DepotDownloader")).await?;
        fs::write(target.join("Schedule I.exe"), b"game").await?;
        let link = temp.path().join("environment-link");
        symlink(&target, &link)?;

        let env = Environment {
            id: "symlink-delete-guard".to_string(),
            name: "Linked".to_string(),
            description: None,
            app_id: schedule_i_config().app_id,
            branch: "main".to_string(),
            output_dir: link.to_string_lossy().to_string(),
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::Completed,
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
            environment_type: Some(EnvironmentType::DepotDownloader),
        };
        service.upsert_environment(&env).await?;

        let err = service
            .delete_environment(&env.id, true)
            .await
            .expect_err("symlinked environment must be rejected");
        assert!(err.to_string().contains("real directory"));
        assert!(target.exists());
        assert!(service.get_environment(&env.id).await?.is_some());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn delete_environment_for_steam_clears_mod_metadata_but_keeps_record() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;

        let steam_path = temp.path().join("steam");
        fs::create_dir_all(&steam_path).await?;
        fs::write(steam_path.join("Schedule I.exe"), b"").await?;

        let steam_env = Environment {
            id: "steam-1".to_string(),
            name: "Steam Installation".to_string(),
            description: None,
            app_id: schedule_i_config().app_id,
            branch: "main".to_string(),
            output_dir: steam_path.to_string_lossy().to_string(),
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::Completed,
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
            environment_type: Some(EnvironmentType::Steam),
        };

        let serialized = serde_json::to_string(&steam_env)?;
        sqlx::query("INSERT INTO environments (id, output_dir, data) VALUES (?, ?, ?)")
            .bind(&steam_env.id)
            .bind(&steam_env.output_dir)
            .bind(serialized)
            .execute(&*pool)
            .await?;

        sqlx::query(
            "INSERT INTO mod_metadata (environment_id, kind, file_name, data) VALUES (?, 'mods', ?, ?)",
        )
        .bind(&steam_env.id)
        .bind("steammod.dll")
        .bind("{}")
        .execute(&*pool)
        .await?;

        let service = EnvironmentService::new(pool.clone())?;
        let deleted = service.delete_environment(&steam_env.id, true).await?;
        assert!(deleted);
        let after = service.get_environment(&steam_env.id).await?;
        assert!(after.is_some());

        let metadata_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM mod_metadata WHERE environment_id = ?")
                .bind(&steam_env.id)
                .fetch_one(&*service.pool)
                .await?;
        assert_eq!(metadata_count, 0);

        assert!(matches!(
            after.expect("steam env should remain").status,
            EnvironmentStatus::Completed
        ));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn create_local_environment_rejects_duplicate_path() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool.clone())?;

        let local_dir = temp.path().join("local");
        fs::create_dir_all(&local_dir).await?;
        fs::write(local_dir.join("Schedule I.exe"), b"").await?;
        fs::write(local_dir.join("GameAssembly.dll"), b"").await?;

        let created = service
            .create_local_environment(local_dir.to_string_lossy().to_string(), None, None)
            .await?;
        assert!(created.id.starts_with("local-"));

        let err = service
            .create_local_environment(local_dir.to_string_lossy().to_string(), None, None)
            .await
            .expect_err("expected duplicate path error");
        assert!(err
            .to_string()
            .contains("already exists for this installation path"));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn get_environments_heals_payload_id_mismatch() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool.clone())?;

        let row_id = "stored-id";
        let payload_id = "payload-id";
        let output_dir = temp.path().join("envs").join("mismatched");
        let env = Environment {
            id: payload_id.to_string(),
            name: "Mismatched".to_string(),
            description: Some("corrupted".to_string()),
            app_id: schedule_i_config().app_id,
            branch: "main".to_string(),
            output_dir: output_dir.to_string_lossy().to_string(),
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::Completed,
            last_updated: Some(chrono::Utc::now()),
            size: None,
            last_manifest_id: None,
            last_update_check: None,
            update_available: None,
            remote_manifest_id: None,
            remote_build_id: None,
            current_game_version: Some("0.1.0".to_string()),
            update_game_version: None,
            melon_loader_version: None,
            steamapps_dir: None,
            steam_manifest_path: None,
            environment_type: Some(EnvironmentType::DepotDownloader),
        };

        sqlx::query(
            "INSERT INTO environments (id, output_dir, normalized_output_dir, data) VALUES (?, ?, ?, ?)",
        )
        .bind(row_id)
        .bind(&env.output_dir)
        .bind(EnvironmentService::normalize_path(&env.output_dir))
        .bind(serde_json::to_string(&env)?)
        .execute(&*pool)
        .await?;

        let envs = service.get_environments().await?;
        assert_eq!(envs.len(), 1);
        assert_eq!(envs[0].id, row_id);

        let healed = service
            .get_environment(row_id)
            .await?
            .expect("healed environment");
        assert_eq!(healed.id, row_id);

        let stored_payload: String =
            sqlx::query_scalar("SELECT data FROM environments WHERE id = ?")
                .bind(row_id)
                .fetch_one(&*pool)
                .await?;
        let stored_env: Environment = serde_json::from_str(&stored_payload)?;
        assert_eq!(stored_env.id, row_id);

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn create_steam_environment_reuses_existing_storage_id_for_same_path() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool.clone())?;

        let steam_path = temp.path().join("steam-shared");
        fs::create_dir_all(&steam_path).await?;
        fs::write(steam_path.join("Schedule I.exe"), b"").await?;

        let existing = service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                steam_path.to_string_lossy().to_string(),
                Some("Legacy env".to_string()),
                None,
            )
            .await?;

        let steam_env = service
            .create_steam_environment(steam_path.to_string_lossy().to_string(), None, None)
            .await?;

        assert_eq!(steam_env.id, existing.id);
        assert_eq!(service.get_environments().await?.len(), 1);

        let stored = service
            .get_environment(&existing.id)
            .await?
            .expect("stored environment");
        assert_eq!(stored.id, existing.id);
        assert!(matches!(
            stored.environment_type,
            Some(EnvironmentType::Steam)
        ));
        assert!(matches!(stored.status, EnvironmentStatus::Completed));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn create_steam_environment_rejects_invalid_path() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool)?;

        let err = service
            .create_steam_environment(temp.path().to_string_lossy().to_string(), None, None)
            .await
            .expect_err("expected invalid steam path error");
        assert!(err.to_string().contains("Invalid Steam installation path"));

        Ok(())
    }
}
