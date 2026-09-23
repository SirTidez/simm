use crate::commands::mod_update::{check_mod_updates_for_environment, update_mod_for_environment};
use crate::commands::mods::{
    emit_environment_payload_changed_for_envs, invalidate_mod_library_cache,
    sync_active_profiles_for_envs, upload_mod_impl,
};
use crate::services::environment::EnvironmentService;
use crate::services::game_session_monitor::{normalize_path, running_schedule_directories};
use crate::services::mods::ModsService;
use crate::services::settings::RuntimeSettingsState;
use crate::types::{
    ModIntegrationConfig, ModIntegrationOperation, ModIntegrationPolicy,
    ModIntegrationRequestRecord, ModIntegrationRequestStatus, ModIntegrationWireRequest,
    ModIntegrationWireResponse, ModMetadata, ModSource,
};
use anyhow::{Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use std::collections::{HashMap, VecDeque};
use std::io::ErrorKind;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

pub const MOD_INTEGRATION_PROTOCOL_VERSION: u32 = 1;
pub const DEFAULT_MOD_INTEGRATION_PORT: u16 = 43871;
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const REQUESTS_PER_MINUTE: usize = 30;
const REQUEST_RETENTION_PER_ENVIRONMENT: i64 = 200;
// Integration callbacks often arrive in a burst when the game starts. Keep
// that burst on one provider scan while allowing normal checks to refresh soon.
const UPDATE_CHECK_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const PORT_SEARCH_SPACE: u32 = u16::MAX as u32;

pub(crate) fn is_mod_integration_infrastructure_file(file_name: &str) -> bool {
    let normalized = file_name
        .strip_suffix(".disabled")
        .unwrap_or(file_name)
        .to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "simm.modintegration.bridge.melonloader.dll"
            | "simm.modintegration.abstractions.dll"
            | "simm.modintegration.bridge.core.dll"
    )
}

fn strip_runtime_suffix_from_mod_name(name: &str) -> String {
    let mut normalized = name.trim().to_string();

    loop {
        let lower = normalized.to_ascii_lowercase();
        let mut stripped = None;

        for suffix in ["(il2cpp)", "[il2cpp]", "(mono)", "[mono]"] {
            if lower.ends_with(suffix) && normalized.len() > suffix.len() {
                stripped = Some(normalized[..normalized.len() - suffix.len()].to_string());
                break;
            }
        }

        if stripped.is_none() {
            for suffix in ["il2cpp", "mono"] {
                if !lower.ends_with(suffix) || normalized.len() <= suffix.len() {
                    continue;
                }
                let prefix = &normalized[..normalized.len() - suffix.len()];
                if prefix.chars().last().is_some_and(|character| {
                    character.is_whitespace() || matches!(character, '-' | '_')
                }) {
                    stripped = Some(prefix.to_string());
                    break;
                }
            }
        }

        let Some(next) = stripped else {
            break;
        };
        let next = next
            .trim_end_matches(|character: char| {
                character.is_whitespace() || matches!(character, '-' | '_')
            })
            .to_string();
        if next.is_empty() || next == normalized {
            break;
        }
        normalized = next;
    }

    normalized
}

#[derive(Clone)]
pub struct ModIntegrationService {
    pool: Arc<SqlitePool>,
    app: AppHandle,
    runtime_settings: RuntimeSettingsState,
    rate_limits: Arc<Mutex<HashMap<String, VecDeque<Instant>>>>,
    update_check_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    listener_tasks: Arc<Mutex<HashMap<u16, JoinHandle<()>>>>,
    background_tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
    shutdown_started: Arc<AtomicBool>,
}

#[derive(Debug, Clone)]
struct ResolvedIntegrationMod {
    file_name: String,
    name: String,
    version: Option<String>,
    source: Option<String>,
    managed: bool,
    metadata: ModMetadata,
    local_test_fixture_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeConfigFile {
    protocol_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    endpoint: Option<String>,
    environment_id: String,
    capability_token: String,
}

impl BridgeConfigFile {
    fn configured_port(&self) -> Result<u16> {
        if let Some(port) = self.port {
            if port == 0 {
                anyhow::bail!("The bridge port must be between 1 and 65535");
            }
            return Ok(port);
        }

        let endpoint = self
            .endpoint
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("The bridge configuration does not contain a port"))?;
        let address = SocketAddr::from_str(endpoint)
            .context("The legacy bridge endpoint is not a valid socket address")?;
        if !address.ip().is_loopback() || address.port() == 0 {
            anyhow::bail!("The legacy bridge endpoint must use a loopback address and valid port");
        }
        Ok(address.port())
    }
}

impl ModIntegrationService {
    pub fn new(
        pool: Arc<SqlitePool>,
        app: AppHandle,
        runtime_settings: RuntimeSettingsState,
    ) -> Self {
        Self {
            pool,
            app,
            runtime_settings,
            rate_limits: Arc::new(Mutex::new(HashMap::new())),
            update_check_locks: Arc::new(Mutex::new(HashMap::new())),
            listener_tasks: Arc::new(Mutex::new(HashMap::new())),
            background_tasks: Arc::new(Mutex::new(Vec::new())),
            shutdown_started: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn start(&self) {
        let listener_service = self.clone();
        let listener_task = tokio::spawn(async move {
            listener_service.run_listener_supervisor().await;
        });

        let queue_service = self.clone();
        let queue_task = tokio::spawn(async move {
            queue_service.run_queue_worker().await;
        });

        self.background_tasks
            .lock()
            .await
            .extend([listener_task, queue_task]);
    }

    pub async fn shutdown(&self) {
        if self.shutdown_started.swap(true, Ordering::AcqRel) {
            return;
        }

        let background_tasks = {
            let mut tasks = self.background_tasks.lock().await;
            tasks.drain(..).collect::<Vec<_>>()
        };
        for task in background_tasks {
            task.abort();
            let _ = task.await;
        }

        let listener_tasks = {
            let mut listeners = self.listener_tasks.lock().await;
            listeners.drain().map(|(_, task)| task).collect::<Vec<_>>()
        };
        for task in listener_tasks {
            task.abort();
            let _ = task.await;
        }

        log::info!("Local mod integration listeners and workers stopped");
    }

    pub async fn get_config(&self, environment_id: &str) -> Result<ModIntegrationConfig> {
        let environment = EnvironmentService::new(self.pool.clone())?
            .get_environment(environment_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Environment not found"))?;
        let row = sqlx::query(
            "SELECT policy, token_hash FROM mod_integration_config WHERE environment_id = ?",
        )
        .bind(environment_id)
        .fetch_optional(&*self.pool)
        .await
        .context("Failed to load mod integration configuration")?;

        let (policy, token_hash) = match row {
            Some(row) => {
                let policy =
                    ModIntegrationPolicy::from_str(row.get::<String, _>("policy").as_str())
                        .map_err(anyhow::Error::msg)?;
                let token_hash = row.get::<Option<String>, _>("token_hash");
                (policy, token_hash)
            }
            None => (ModIntegrationPolicy::Disabled, None),
        };
        let config_path = Self::bridge_config_path(&environment.output_dir);
        let mut port = DEFAULT_MOD_INTEGRATION_PORT;
        let mut configured = false;
        let mut listening = false;
        let mut connection_error = None;
        if policy != ModIntegrationPolicy::Disabled {
            match token_hash.as_deref().filter(|value| !value.is_empty()) {
                None => connection_error = Some("The private bridge token is missing.".to_string()),
                Some(token_hash) => match Self::read_bridge_config(&config_path).await {
                    Ok(bridge_config) => {
                        if let Ok(configured_port) = bridge_config.configured_port() {
                            port = configured_port;
                        }
                        match Self::validate_bridge_config(
                            &bridge_config,
                            environment_id,
                            token_hash,
                        ) {
                            Ok(validated_port) => {
                                port = validated_port;
                                configured = true;
                                match self.reconcile_listener_ports().await {
                                    Ok(()) => {
                                        if let Ok(updated) =
                                            Self::read_bridge_config(&config_path).await
                                        {
                                            port = updated.configured_port().unwrap_or(port);
                                        }
                                        listening = self.listener_is_running(port).await;
                                    }
                                    Err(error) => connection_error = Some(error.to_string()),
                                }
                            }
                            Err(error) => connection_error = Some(error.to_string()),
                        }
                    }
                    Err(error) => connection_error = Some(error.to_string()),
                },
            }
        }
        let pending_request_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM mod_integration_requests WHERE environment_id = ? AND status IN ('queued', 'awaiting-user-approval', 'awaiting-user-source')",
        )
        .bind(environment_id)
        .fetch_one(&*self.pool)
        .await
        .context("Failed to count pending mod integration requests")?;

        Ok(ModIntegrationConfig {
            environment_id: environment_id.to_string(),
            configured,
            policy,
            protocol_version: MOD_INTEGRATION_PROTOCOL_VERSION,
            port,
            bridge_config_path: (!environment.output_dir.trim().is_empty())
                .then(|| config_path.to_string_lossy().to_string()),
            listening,
            connection_error,
            pending_request_count: pending_request_count.max(0) as u64,
        })
    }

    pub async fn set_policy(
        &self,
        environment_id: &str,
        policy: ModIntegrationPolicy,
    ) -> Result<ModIntegrationConfig> {
        let environment = EnvironmentService::new(self.pool.clone())?
            .get_environment(environment_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Environment not found"))?;
        if environment.output_dir.trim().is_empty() {
            anyhow::bail!("This environment does not have an installation directory");
        }

        let config_path = Self::bridge_config_path(&environment.output_dir);
        let now = Utc::now().to_rfc3339();
        if policy == ModIntegrationPolicy::Disabled {
            sqlx::query(
                r#"INSERT INTO mod_integration_config (environment_id, policy, token_hash, created_at, updated_at)
                   VALUES (?, 'disabled', NULL, ?, ?)
                   ON CONFLICT(environment_id) DO UPDATE SET policy = 'disabled', token_hash = NULL, updated_at = excluded.updated_at"#,
            )
            .bind(environment_id)
            .bind(&now)
            .bind(&now)
            .execute(&*self.pool)
            .await
            .context("Failed to disable mod integration")?;
            if config_path.exists() {
                tokio::fs::remove_file(&config_path)
                    .await
                    .with_context(|| format!("Failed to remove {}", config_path.display()))?;
            }
            sqlx::query(
                "UPDATE mod_integration_requests SET status = 'denied', message = 'Integration was disabled', updated_at = ? WHERE environment_id = ? AND status IN ('queued', 'awaiting-user-approval', 'awaiting-user-source')",
            )
            .bind(&now)
            .bind(environment_id)
            .execute(&*self.pool)
            .await
            .context("Failed to close pending integration requests")?;
        } else {
            let port = self
                .ensure_application_listener(DEFAULT_MOD_INTEGRATION_PORT)
                .await?;
            let capability_token = Self::new_capability_token();
            let token_hash = Self::hash_token(&capability_token);
            sqlx::query(
                r#"INSERT INTO mod_integration_config (environment_id, policy, token_hash, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(environment_id) DO UPDATE SET policy = excluded.policy, token_hash = excluded.token_hash, updated_at = excluded.updated_at"#,
            )
            .bind(environment_id)
            .bind(policy.as_str())
            .bind(token_hash)
            .bind(&now)
            .bind(&now)
            .execute(&*self.pool)
            .await
            .context("Failed to save mod integration policy")?;
            Self::write_bridge_config(
                &config_path,
                BridgeConfigFile {
                    protocol_version: MOD_INTEGRATION_PROTOCOL_VERSION,
                    port: Some(port),
                    endpoint: None,
                    environment_id: environment_id.to_string(),
                    capability_token,
                },
            )
            .await?;
        }

        self.reconcile_listener_ports().await?;
        let config = self.get_config(environment_id).await?;
        self.emit_changed(environment_id);
        Ok(config)
    }

    pub async fn list_requests(
        &self,
        environment_id: &str,
    ) -> Result<Vec<ModIntegrationRequestRecord>> {
        EnvironmentService::new(self.pool.clone())?
            .get_environment(environment_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Environment not found"))?;
        let rows = sqlx::query(
            r#"SELECT id, environment_id, operation, status, mod_file_name, mod_name,
                      current_version, target_version, source, message, created_at, updated_at
               FROM mod_integration_requests
               WHERE environment_id = ?
               ORDER BY updated_at DESC, created_at DESC
               LIMIT 200"#,
        )
        .bind(environment_id)
        .fetch_all(&*self.pool)
        .await
        .context("Failed to load mod integration requests")?;

        rows.into_iter()
            .map(Self::request_record_from_row)
            .collect()
    }

    pub async fn resolve_user_request(
        &self,
        request_id: &str,
        approve: bool,
    ) -> Result<ModIntegrationRequestRecord> {
        let row = sqlx::query(
            "SELECT environment_id, operation, status, mod_file_name FROM mod_integration_requests WHERE id = ?",
        )
                .bind(request_id)
                .fetch_optional(&*self.pool)
                .await
                .context("Failed to load mod integration request")?
                .ok_or_else(|| anyhow::anyhow!("Integration request not found"))?;
        let environment_id = row.get::<String, _>("environment_id");
        let operation = serde_json::from_value::<ModIntegrationOperation>(
            serde_json::Value::String(row.get("operation")),
        )
        .context("Invalid integration operation")?;
        let current_status = row.get::<String, _>("status");
        let mod_file_name = row.get::<String, _>("mod_file_name");
        let (next_status, message, source, current_version) = match operation {
            ModIntegrationOperation::RequestManagement => {
                if current_status != ModIntegrationRequestStatus::AwaitingUserSource.as_str()
                    && current_status != ModIntegrationRequestStatus::AwaitingUserApproval.as_str()
                {
                    anyhow::bail!("Only management requests awaiting a source can be changed");
                }
                if !approve {
                    (
                        ModIntegrationRequestStatus::Denied,
                        "Management request denied by the user.",
                        None,
                        None,
                    )
                } else {
                    let resolved = self
                        .resolve_mod_by_file_name(&environment_id, &mod_file_name)
                        .await
                        .map_err(anyhow::Error::msg)?
                        .ok_or_else(|| {
                            anyhow::anyhow!("The requesting mod is no longer installed")
                        })?;
                    if !resolved.managed {
                        anyhow::bail!(
                            "Choose and link a source before completing this management request"
                        );
                    }
                    (
                        ModIntegrationRequestStatus::Managed,
                        "The existing installation is now managed by SIMM.",
                        resolved.source,
                        resolved.version,
                    )
                }
            }
            ModIntegrationOperation::RequestUpdate => {
                if current_status != ModIntegrationRequestStatus::AwaitingUserApproval.as_str() {
                    anyhow::bail!("Only update requests awaiting approval can be changed");
                }
                if approve {
                    (
                        ModIntegrationRequestStatus::Queued,
                        "Approved. SIMM will recheck and install the update after the game exits.",
                        None,
                        None,
                    )
                } else {
                    (
                        ModIntegrationRequestStatus::Denied,
                        "Denied by the user.",
                        None,
                        None,
                    )
                }
            }
            ModIntegrationOperation::CheckForUpdate => {
                anyhow::bail!("Update checks do not create approval requests");
            }
        };
        sqlx::query(
            "UPDATE mod_integration_requests SET status = ?, message = ?, source = COALESCE(?, source), current_version = COALESCE(?, current_version), updated_at = ? WHERE id = ?",
        )
        .bind(next_status.as_str())
        .bind(message)
        .bind(source)
        .bind(current_version)
        .bind(Utc::now().to_rfc3339())
        .bind(request_id)
        .execute(&*self.pool)
        .await
        .context("Failed to update mod integration request")?;
        self.emit_changed(&environment_id);
        self.get_request(request_id).await
    }

    async fn run_listener_supervisor(&self) {
        let mut last_error = None;
        loop {
            if self.shutdown_started.load(Ordering::Acquire) {
                break;
            }
            match self.reconcile_listener_ports().await {
                Ok(()) => {
                    if last_error.take().is_some() {
                        log::info!("Local mod integration listener reconciliation recovered");
                    }
                }
                Err(error) => {
                    let message = error.to_string();
                    if last_error.as_deref() != Some(message.as_str()) {
                        log::warn!("Could not reconcile local mod integration listener: {error}");
                        last_error = Some(message);
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    async fn reconcile_listener_ports(&self) -> Result<()> {
        let bridge_configs = self.enabled_bridge_configs().await?;
        if bridge_configs.is_empty() {
            self.stop_all_listeners().await;
            return Ok(());
        }

        let port = self
            .ensure_application_listener(DEFAULT_MOD_INTEGRATION_PORT)
            .await?;
        for (environment_id, config_path, mut config) in bridge_configs {
            if config.port != Some(port) || config.endpoint.is_some() {
                config.port = Some(port);
                config.endpoint = None;
                Self::write_bridge_config(&config_path, config).await?;
                self.emit_changed(&environment_id);
                log::info!(
                    "Synchronized local mod integration bridge for {environment_id} to port {port}"
                );
            }
        }
        Ok(())
    }

    async fn enabled_bridge_configs(&self) -> Result<Vec<(String, PathBuf, BridgeConfigFile)>> {
        let rows = sqlx::query(
            r#"SELECT mic.environment_id, mic.token_hash, e.output_dir
               FROM mod_integration_config mic
               JOIN environments e ON e.id = mic.environment_id
               WHERE mic.policy != 'disabled' AND mic.token_hash IS NOT NULL"#,
        )
        .fetch_all(&*self.pool)
        .await
        .context("Failed to load configured mod integration ports")?;

        let mut configs = Vec::new();
        for row in rows {
            let environment_id = row.get::<String, _>("environment_id");
            let token_hash = row.get::<String, _>("token_hash");
            let output_dir = row.get::<String, _>("output_dir");
            let config_path = Self::bridge_config_path(&output_dir);
            let config = match Self::read_bridge_config(&config_path).await {
                Ok(config) => config,
                Err(error) => {
                    log::debug!("Skipping bridge configuration for {environment_id}: {error:#}");
                    continue;
                }
            };
            if let Err(error) = Self::validate_bridge_config(&config, &environment_id, &token_hash)
            {
                log::debug!(
                    "Skipping invalid bridge configuration for {environment_id}: {error:#}"
                );
                continue;
            }
            configs.push((environment_id, config_path, config));
        }
        Ok(configs)
    }

    async fn ensure_application_listener(&self, requested_port: u16) -> Result<u16> {
        let mut listeners = self.listener_tasks.lock().await;
        let finished_ports = listeners
            .iter()
            .filter_map(|(port, task)| task.is_finished().then_some(*port))
            .collect::<Vec<_>>();
        for port in finished_ports {
            if let Some(finished) = listeners.remove(&port) {
                let _ = finished.await;
            }
        }
        if let Some(port) = listeners.keys().next().copied() {
            return Ok(port);
        }

        let (port, listener) = Self::bind_next_available_port(requested_port).await?;
        let service = self.clone();
        let task = tokio::spawn(async move {
            if let Err(error) = service.run_listener_on_port(listener, port).await {
                log::error!("Local mod integration listener on port {port} stopped: {error}");
            }
        });
        listeners.insert(port, task);
        log::info!(
            "Local mod integration API listening on loopback port {} (protocol v{})",
            port,
            MOD_INTEGRATION_PROTOCOL_VERSION
        );
        if port != requested_port {
            log::warn!(
                "Local mod integration port {requested_port} was unavailable; using port {port}"
            );
        }
        Ok(port)
    }

    async fn bind_next_available_port(requested_port: u16) -> Result<(u16, TcpListener)> {
        let mut last_unavailable = None;
        for offset in 0..PORT_SEARCH_SPACE {
            let port = Self::port_in_sequence(requested_port, offset);
            match TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await {
                Ok(listener) => return Ok((port, listener)),
                Err(error)
                    if matches!(
                        error.kind(),
                        ErrorKind::AddrInUse | ErrorKind::PermissionDenied
                    ) =>
                {
                    last_unavailable = Some((port, error));
                }
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!(
                            "Failed to bind the local mod integration API to loopback port {port}"
                        )
                    });
                }
            }
        }

        let detail = last_unavailable
            .map(|(port, error)| format!("; last attempt was port {port}: {error}"))
            .unwrap_or_default();
        anyhow::bail!(
            "No available local mod integration port was found after {PORT_SEARCH_SPACE} attempts starting at {requested_port}{detail}"
        )
    }

    fn port_in_sequence(requested_port: u16, offset: u32) -> u16 {
        (((requested_port as u32 - 1 + offset) % u16::MAX as u32) + 1) as u16
    }

    async fn listener_is_running(&self, port: u16) -> bool {
        self.listener_tasks
            .lock()
            .await
            .get(&port)
            .is_some_and(|task| !task.is_finished())
    }

    async fn stop_all_listeners(&self) {
        let listener_tasks = {
            let mut listeners = self.listener_tasks.lock().await;
            listeners
                .drain()
                .map(|(port, task)| (port, task))
                .collect::<Vec<_>>()
        };
        for (port, task) in listener_tasks {
            task.abort();
            let _ = task.await;
            log::info!("Stopped local mod integration listener on port {port}");
        }
    }

    async fn run_listener_on_port(&self, listener: TcpListener, port: u16) -> Result<()> {
        loop {
            let (stream, peer) = listener.accept().await?;
            if !peer.ip().is_loopback() {
                log::warn!("Rejected non-loopback mod integration client on port {port}: {peer}");
                continue;
            }
            let service = self.clone();
            tokio::spawn(async move {
                if let Err(error) = service.handle_connection(stream).await {
                    log::warn!("Local mod integration request failed: {error}");
                }
            });
        }
    }

    async fn handle_connection(&self, stream: TcpStream) -> Result<()> {
        let (reader, mut writer) = stream.into_split();
        let mut bytes = Vec::new();
        let mut limited_reader = BufReader::new(reader).take(MAX_REQUEST_BYTES + 1);
        tokio::time::timeout(
            Duration::from_secs(15),
            limited_reader.read_until(b'\n', &mut bytes),
        )
        .await
        .context("Timed out reading mod integration request")??;

        let response = if bytes.len() as u64 > MAX_REQUEST_BYTES {
            Self::error_response(
                String::new(),
                ModIntegrationRequestStatus::Invalid,
                "Request exceeds the 64 KiB protocol limit",
            )
        } else {
            let json_bytes = Self::strip_utf8_bom(&bytes);
            match serde_json::from_slice::<ModIntegrationWireRequest>(json_bytes) {
                Ok(request) => self.handle_wire_request(request).await,
                Err(_) => Self::error_response(
                    String::new(),
                    ModIntegrationRequestStatus::Invalid,
                    "Request is not valid protocol JSON",
                ),
            }
        };
        let mut payload = serde_json::to_vec(&response)?;
        payload.push(b'\n');
        writer.write_all(&payload).await?;
        writer.shutdown().await?;
        Ok(())
    }

    async fn handle_wire_request(
        &self,
        request: ModIntegrationWireRequest,
    ) -> ModIntegrationWireResponse {
        if request.protocol_version != MOD_INTEGRATION_PROTOCOL_VERSION {
            return Self::error_response(
                request.request_id,
                ModIntegrationRequestStatus::Invalid,
                "Unsupported integration protocol version",
            );
        }
        if request.request_id.trim().is_empty()
            || request.request_id.len() > 128
            || request.environment_id.trim().is_empty()
            || request.environment_id.len() > 256
            || request.capability_token.len() < 32
            || request.capability_token.len() > 256
        {
            return Self::error_response(
                request.request_id,
                ModIntegrationRequestStatus::Invalid,
                "Required request fields are missing or invalid",
            );
        }

        let config_row = match sqlx::query(
            "SELECT policy, token_hash FROM mod_integration_config WHERE environment_id = ?",
        )
        .bind(&request.environment_id)
        .fetch_optional(&*self.pool)
        .await
        {
            Ok(row) => row,
            Err(_) => {
                return Self::error_response(
                    request.request_id,
                    ModIntegrationRequestStatus::SimmUnavailable,
                    "SIMM could not read the integration policy",
                )
            }
        };
        let Some(config_row) = config_row else {
            return Self::error_response(
                request.request_id,
                ModIntegrationRequestStatus::IntegrationDisabled,
                "Mod integration is disabled for this installation",
            );
        };
        let policy =
            match ModIntegrationPolicy::from_str(config_row.get::<String, _>("policy").as_str()) {
                Ok(policy) => policy,
                Err(_) => {
                    return Self::error_response(
                        request.request_id,
                        ModIntegrationRequestStatus::Invalid,
                        "The stored integration policy is invalid",
                    )
                }
            };
        if policy == ModIntegrationPolicy::Disabled {
            return Self::error_response(
                request.request_id,
                ModIntegrationRequestStatus::IntegrationDisabled,
                "Mod integration is disabled for this installation",
            );
        }
        let stored_hash = config_row
            .get::<Option<String>, _>("token_hash")
            .unwrap_or_default();
        if !Self::constant_time_eq(
            stored_hash.as_bytes(),
            Self::hash_token(&request.capability_token).as_bytes(),
        ) {
            return Self::error_response(
                request.request_id,
                ModIntegrationRequestStatus::Invalid,
                "The capability token is invalid",
            );
        }
        if !self.allow_request(&request.environment_id).await {
            return Self::error_response(
                request.request_id,
                ModIntegrationRequestStatus::Invalid,
                "Too many integration requests; retry in one minute",
            );
        }

        let resolved = match self.resolve_mod(&request).await {
            Ok(Some(resolved)) => resolved,
            Ok(None) => {
                return Self::error_response(
                    request.request_id,
                    ModIntegrationRequestStatus::NotManagedBySimm,
                    "The calling mod is not managed by SIMM in this installation",
                )
            }
            Err(message) => {
                return Self::error_response(
                    request.request_id,
                    ModIntegrationRequestStatus::Invalid,
                    &message,
                )
            }
        };

        if request.operation == ModIntegrationOperation::RequestManagement {
            if resolved.managed {
                return ModIntegrationWireResponse {
                    protocol_version: MOD_INTEGRATION_PROTOCOL_VERSION,
                    request_id: request.request_id,
                    status: ModIntegrationRequestStatus::AlreadyManaged,
                    message: "This mod is already managed by SIMM.".to_string(),
                    current_version: resolved.version,
                    target_version: None,
                    source: resolved.source,
                    queued_request_id: None,
                };
            }

            let message =
                "SIMM is waiting for you to choose and confirm a source for this local mod."
                    .to_string();
            let existing = match self
                .find_pending_management_request(&request.environment_id, &resolved.file_name)
                .await
            {
                Ok(record) => record,
                Err(error) => {
                    return Self::error_response(
                        request.request_id,
                        ModIntegrationRequestStatus::SimmUnavailable,
                        &format!("SIMM could not check pending management requests: {error}"),
                    )
                }
            };
            let record = match existing {
                Some(record) => record,
                None => match self
                    .persist_request(
                        &request,
                        &resolved,
                        ModIntegrationRequestStatus::AwaitingUserSource,
                        Some(message.clone()),
                    )
                    .await
                {
                    Ok(record) => {
                        self.emit_changed(&request.environment_id);
                        record
                    }
                    Err(error) => {
                        return Self::error_response(
                            request.request_id,
                            ModIntegrationRequestStatus::SimmUnavailable,
                            &format!("SIMM could not store the management request: {error}"),
                        )
                    }
                },
            };
            return ModIntegrationWireResponse {
                protocol_version: MOD_INTEGRATION_PROTOCOL_VERSION,
                request_id: request.request_id,
                status: ModIntegrationRequestStatus::AwaitingUserSource,
                message: record.message.unwrap_or(message),
                current_version: record.current_version,
                target_version: None,
                source: record.source,
                queued_request_id: Some(record.id),
            };
        }

        if !resolved.managed && resolved.local_test_fixture_path.is_none() {
            return Self::error_response(
                request.request_id,
                ModIntegrationRequestStatus::NotManagedBySimm,
                "The calling mod is not managed by SIMM in this installation",
            );
        }

        let update = match self
            .refresh_requested_mod(&request.environment_id, &resolved.file_name)
            .await
        {
            Ok(update) => update,
            Err(error) => {
                return Self::error_response(
                    request.request_id,
                    ModIntegrationRequestStatus::SimmUnavailable,
                    &format!("SIMM could not check for an update: {error}"),
                )
            }
        };

        let (status, message, queued_request_id) = match request.operation {
            ModIntegrationOperation::CheckForUpdate => {
                if update.metadata.update_available == Some(true) {
                    (
                        ModIntegrationRequestStatus::UpdateAvailable,
                        "An update is available through SIMM.".to_string(),
                        None,
                    )
                } else {
                    (
                        ModIntegrationRequestStatus::UpToDate,
                        "The installed mod is up to date.".to_string(),
                        None,
                    )
                }
            }
            ModIntegrationOperation::RequestUpdate => {
                if update.metadata.update_available != Some(true) {
                    (
                        ModIntegrationRequestStatus::UpdateNotAvailable,
                        "No update is currently available.".to_string(),
                        None,
                    )
                } else {
                    let status = if policy == ModIntegrationPolicy::Ask {
                        ModIntegrationRequestStatus::AwaitingUserApproval
                    } else {
                        ModIntegrationRequestStatus::Queued
                    };
                    let message = if status == ModIntegrationRequestStatus::AwaitingUserApproval {
                        "SIMM is waiting for the user to approve this update.".to_string()
                    } else {
                        "The update is queued and will be rechecked after the game exits."
                            .to_string()
                    };
                    let record = match self
                        .persist_request(&request, &update, status.clone(), Some(message.clone()))
                        .await
                    {
                        Ok(record) => record,
                        Err(error) => {
                            return Self::error_response(
                                request.request_id,
                                ModIntegrationRequestStatus::SimmUnavailable,
                                &format!("SIMM could not queue the update: {error}"),
                            )
                        }
                    };
                    self.emit_changed(&request.environment_id);
                    (status, message, Some(record.id))
                }
            }
            ModIntegrationOperation::RequestManagement => {
                unreachable!("management requests return before update metadata is refreshed")
            }
        };

        ModIntegrationWireResponse {
            protocol_version: MOD_INTEGRATION_PROTOCOL_VERSION,
            request_id: request.request_id,
            status,
            message,
            current_version: update.version,
            target_version: update.metadata.remote_version,
            source: update.source,
            queued_request_id,
        }
    }

    async fn refresh_requested_mod(
        &self,
        environment_id: &str,
        mod_file_name: &str,
    ) -> std::result::Result<ResolvedIntegrationMod, String> {
        let update_check_lock = {
            let mut locks = self.update_check_locks.lock().await;
            Arc::clone(
                locks
                    .entry(environment_id.to_string())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let _update_check_guard = update_check_lock.lock().await;
        let synthetic_request = ModIntegrationWireRequest {
            protocol_version: MOD_INTEGRATION_PROTOCOL_VERSION,
            request_id: "internal-refresh".to_string(),
            capability_token: String::new(),
            environment_id: environment_id.to_string(),
            operation: ModIntegrationOperation::CheckForUpdate,
            mod_identity: crate::types::ModIntegrationIdentity {
                assembly_path: None,
                simm_storage_id: None,
                guid: None,
                name: None,
                version: None,
            },
        };
        let mut resolved = self
            .resolve_mod_by_file_name(&synthetic_request.environment_id, mod_file_name)
            .await?
            .ok_or_else(|| "The requested mod is no longer installed".to_string())?;
        self.apply_local_test_fixture(environment_id, &mut resolved)
            .await?;
        if !Self::has_recent_update_check(&resolved.metadata) {
            check_mod_updates_for_environment(
                self.pool.clone(),
                &self.app,
                environment_id,
                self.runtime_settings.snapshot().await,
            )
            .await?;
            resolved = self
                .resolve_mod_by_file_name(&synthetic_request.environment_id, mod_file_name)
                .await?
                .ok_or_else(|| "The requested mod is no longer installed".to_string())?;
            self.apply_local_test_fixture(environment_id, &mut resolved)
                .await?;
        }
        Ok(resolved)
    }

    fn has_recent_update_check(metadata: &ModMetadata) -> bool {
        metadata.last_update_check.is_some_and(|checked_at| {
            let age = Utc::now().signed_duration_since(checked_at);
            age >= chrono::Duration::zero()
                && age
                    .to_std()
                    .is_ok_and(|elapsed| elapsed < UPDATE_CHECK_CACHE_TTL)
        })
    }

    async fn resolve_mod(
        &self,
        request: &ModIntegrationWireRequest,
    ) -> std::result::Result<Option<ResolvedIntegrationMod>, String> {
        let identity = &request.mod_identity;
        if identity.assembly_path.is_none() {
            return Err("A verified calling assembly path is required".to_string());
        }
        let environment = EnvironmentService::new(self.pool.clone())
            .map_err(|error| error.to_string())?
            .get_environment(&request.environment_id)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Environment not found".to_string())?;
        if environment.output_dir.trim().is_empty() {
            return Err("The environment has no installation directory".to_string());
        }
        let mods_service = ModsService::new(self.pool.clone())
            .with_runtime_settings(self.runtime_settings.snapshot().await);
        let listing = mods_service
            .list_mods(&environment.output_dir)
            .await
            .map_err(|error| error.to_string())?;
        let entries = listing
            .get("mods")
            .and_then(|value| value.as_array())
            .ok_or_else(|| "SIMM returned an invalid mod inventory".to_string())?;
        let requested_path = identity
            .assembly_path
            .as_deref()
            .map(Path::new)
            .map(normalize_path);
        let matched = entries.iter().find(|entry| {
            requested_path.as_ref().is_some_and(|requested| {
                entry
                    .get("path")
                    .and_then(|value| value.as_str())
                    .is_some_and(|path| normalize_path(Path::new(path)) == *requested)
            })
        });
        let Some(entry) = matched else {
            return Ok(None);
        };
        let file_name = entry
            .get("fileName")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "The matched mod has no file name".to_string())?;
        let local_test_fixture_path = Self::local_test_fixture_path(file_name);
        if let Some(requested_storage_id) = identity
            .simm_storage_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            if entry.get("modStorageId").and_then(|value| value.as_str())
                != Some(requested_storage_id)
            {
                return Err(
                    "The SIMM storage identifier does not match the calling assembly".to_string(),
                );
            }
        }
        let mut resolved = self
            .resolved_mod_from_entry(&environment.output_dir, file_name, entry)
            .await?;
        if let Some(path) = local_test_fixture_path {
            resolved.source = Some("local".to_string());
            resolved.metadata.source = Some(ModSource::Local);
            resolved.local_test_fixture_path = Some(path);
        }
        if let Some(name) = identity
            .name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            if !name.eq_ignore_ascii_case(&resolved.name) {
                return Err(
                    "The calling mod name does not match the installed assembly".to_string()
                );
            }
        }
        if let (Some(requested_version), Some(installed_version)) = (
            identity
                .version
                .as_deref()
                .filter(|value| !value.trim().is_empty()),
            resolved.version.as_deref(),
        ) {
            if requested_version.trim() != installed_version.trim() {
                return Err(
                    "The calling mod version does not match SIMM's installed metadata".to_string(),
                );
            }
        }
        Ok(Some(resolved))
    }

    async fn apply_local_test_fixture(
        &self,
        environment_id: &str,
        resolved: &mut ResolvedIntegrationMod,
    ) -> std::result::Result<(), String> {
        let Some(fixture_path) = resolved.local_test_fixture_path.as_ref() else {
            return Ok(());
        };
        let environment = EnvironmentService::new(self.pool.clone())
            .map_err(|error| error.to_string())?
            .get_environment(environment_id)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Environment not found".to_string())?;
        let mods_service = ModsService::new(self.pool.clone())
            .with_runtime_settings(self.runtime_settings.snapshot().await);
        let installed_path = Path::new(&environment.output_dir)
            .join("Mods")
            .join(&resolved.file_name);
        let current_version = mods_service
            .extract_mod_version(&installed_path)
            .await
            .ok_or_else(|| {
                format!(
                    "The local integration test mod has no readable assembly version: {}",
                    installed_path.display()
                )
            })?;
        let target_version = mods_service
            .extract_mod_version(fixture_path)
            .await
            .ok_or_else(|| {
                format!(
                    "The local integration test fixture has no readable assembly version: {}",
                    fixture_path.display()
                )
            })?;
        let update_available = current_version != target_version;
        resolved.version = Some(current_version.clone());
        resolved.metadata.source_version = Some(current_version.clone());
        resolved.metadata.installed_version = Some(current_version);
        resolved.metadata.update_available = Some(update_available);
        resolved.metadata.remote_version = Some(target_version);
        resolved.metadata.last_update_check = Some(Utc::now());
        resolved.source = Some("local".to_string());
        Ok(())
    }

    #[cfg(debug_assertions)]
    fn local_test_fixture_path(file_name: &str) -> Option<PathBuf> {
        const ENVIRONMENT_VARIABLE: &str = "SIMMRUST_MOD_INTEGRATION_TEST_LOCAL_UPDATE_DIR";
        let leaf_name = Path::new(file_name).file_name()?.to_str()?;
        if leaf_name != file_name {
            return None;
        }
        let root = std::env::var_os(ENVIRONMENT_VARIABLE)
            .map(PathBuf::from)?
            .canonicalize()
            .ok()?;
        let fixture = root.join(leaf_name).canonicalize().ok()?;
        (fixture.is_file() && fixture.starts_with(&root)).then_some(fixture)
    }

    #[cfg(not(debug_assertions))]
    fn local_test_fixture_path(_file_name: &str) -> Option<PathBuf> {
        None
    }

    async fn resolve_mod_by_file_name(
        &self,
        environment_id: &str,
        mod_file_name: &str,
    ) -> std::result::Result<Option<ResolvedIntegrationMod>, String> {
        let environment = EnvironmentService::new(self.pool.clone())
            .map_err(|error| error.to_string())?
            .get_environment(environment_id)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Environment not found".to_string())?;
        let mods_service = ModsService::new(self.pool.clone())
            .with_runtime_settings(self.runtime_settings.snapshot().await);
        let listing = mods_service
            .list_mods(&environment.output_dir)
            .await
            .map_err(|error| error.to_string())?;
        let entry = listing
            .get("mods")
            .and_then(|value| value.as_array())
            .and_then(|entries| {
                entries.iter().find(|entry| {
                    entry.get("fileName").and_then(|value| value.as_str()) == Some(mod_file_name)
                })
            });
        match entry {
            Some(entry) => self
                .resolved_mod_from_entry(&environment.output_dir, mod_file_name, entry)
                .await
                .map(Some),
            None => Ok(None),
        }
    }

    async fn resolved_mod_from_entry(
        &self,
        output_dir: &str,
        file_name: &str,
        entry: &serde_json::Value,
    ) -> std::result::Result<ResolvedIntegrationMod, String> {
        let mods_service = ModsService::new(self.pool.clone())
            .with_runtime_settings(self.runtime_settings.snapshot().await);
        let metadata = mods_service
            .load_mod_metadata(&Path::new(output_dir).join("Mods"))
            .await
            .map_err(|error| error.to_string())?
            .get(file_name)
            .cloned()
            .unwrap_or(ModMetadata {
                source: None,
                source_id: None,
                source_version: None,
                author: None,
                mod_name: None,
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
                last_update_check: None,
                metadata_last_refreshed: None,
                update_available: None,
                remote_version: None,
                detected_runtime: None,
                runtime_match: None,
                mod_storage_id: None,
                managed_paths: None,
                security_scan: None,
            });
        let raw_name = metadata
            .mod_name
            .clone()
            .or_else(|| {
                entry
                    .get("name")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| file_name.trim_end_matches(".dll").to_string());
        let name = strip_runtime_suffix_from_mod_name(&raw_name);
        let mut version = metadata.source_version.clone().or_else(|| {
            metadata.installed_version.clone().or_else(|| {
                entry
                    .get("version")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
            })
        });
        if version.is_none() {
            version = mods_service
                .extract_mod_version(&Path::new(output_dir).join("Mods").join(file_name))
                .await;
        }
        let source = metadata.source.as_ref().map(Self::source_label);
        Ok(ResolvedIntegrationMod {
            file_name: file_name.to_string(),
            name,
            version,
            source,
            managed: entry.get("managed").and_then(|value| value.as_bool()) == Some(true),
            metadata,
            local_test_fixture_path: Self::local_test_fixture_path(file_name),
        })
    }

    async fn persist_request(
        &self,
        request: &ModIntegrationWireRequest,
        resolved: &ResolvedIntegrationMod,
        status: ModIntegrationRequestStatus,
        message: Option<String>,
    ) -> Result<ModIntegrationRequestRecord> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"INSERT INTO mod_integration_requests
               (id, environment_id, operation, status, mod_file_name, mod_name,
                current_version, target_version, source, message, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&id)
        .bind(&request.environment_id)
        .bind(request.operation.as_str())
        .bind(status.as_str())
        .bind(&resolved.file_name)
        .bind(&resolved.name)
        .bind(&resolved.version)
        .bind(&resolved.metadata.remote_version)
        .bind(&resolved.source)
        .bind(message)
        .bind(&now)
        .bind(&now)
        .execute(&*self.pool)
        .await
        .context("Failed to store mod integration request")?;
        self.prune_requests(&request.environment_id).await?;
        self.get_request(&id).await
    }

    async fn find_pending_management_request(
        &self,
        environment_id: &str,
        mod_file_name: &str,
    ) -> Result<Option<ModIntegrationRequestRecord>> {
        let row = sqlx::query(
            r#"SELECT id, environment_id, operation, status, mod_file_name, mod_name,
                      current_version, target_version, source, message, created_at, updated_at
               FROM mod_integration_requests
               WHERE environment_id = ? AND mod_file_name = ?
                 AND operation = 'requestManagement'
                 AND status IN ('awaiting-user-source', 'awaiting-user-approval')
               ORDER BY updated_at DESC LIMIT 1"#,
        )
        .bind(environment_id)
        .bind(mod_file_name)
        .fetch_optional(&*self.pool)
        .await
        .context("Failed to load pending management request")?;
        row.map(Self::request_record_from_row).transpose()
    }

    async fn get_request(&self, request_id: &str) -> Result<ModIntegrationRequestRecord> {
        let row = sqlx::query(
            r#"SELECT id, environment_id, operation, status, mod_file_name, mod_name,
                      current_version, target_version, source, message, created_at, updated_at
               FROM mod_integration_requests WHERE id = ?"#,
        )
        .bind(request_id)
        .fetch_optional(&*self.pool)
        .await
        .context("Failed to load mod integration request")?
        .ok_or_else(|| anyhow::anyhow!("Integration request not found"))?;
        Self::request_record_from_row(row)
    }

    fn request_record_from_row(
        row: sqlx::sqlite::SqliteRow,
    ) -> Result<ModIntegrationRequestRecord> {
        Ok(ModIntegrationRequestRecord {
            id: row.get("id"),
            environment_id: row.get("environment_id"),
            operation: serde_json::from_value(serde_json::Value::String(row.get("operation")))
                .context("Invalid integration operation")?,
            status: ModIntegrationRequestStatus::from_str(row.get::<String, _>("status").as_str())
                .map_err(anyhow::Error::msg)?,
            mod_file_name: row.get("mod_file_name"),
            mod_name: row.get("mod_name"),
            current_version: row.get("current_version"),
            target_version: row.get("target_version"),
            source: row.get("source"),
            message: row.get("message"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        })
    }

    async fn prune_requests(&self, environment_id: &str) -> Result<()> {
        sqlx::query(
            r#"DELETE FROM mod_integration_requests
               WHERE environment_id = ? AND id NOT IN (
                   SELECT id FROM mod_integration_requests
                   WHERE environment_id = ? ORDER BY updated_at DESC LIMIT ?
               )"#,
        )
        .bind(environment_id)
        .bind(environment_id)
        .bind(REQUEST_RETENTION_PER_ENVIRONMENT)
        .execute(&*self.pool)
        .await
        .context("Failed to prune old mod integration requests")?;
        Ok(())
    }

    async fn run_queue_worker(&self) {
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if self.shutdown_started.load(Ordering::Acquire) {
                break;
            }
            if let Err(error) = self.process_queued_requests().await {
                log::warn!("Mod integration queue will retry: {error}");
            }
        }
    }

    async fn process_queued_requests(&self) -> Result<()> {
        let rows = sqlx::query(
            r#"SELECT id, environment_id, mod_file_name
               FROM mod_integration_requests
               WHERE status = 'queued' ORDER BY created_at ASC LIMIT 20"#,
        )
        .fetch_all(&*self.pool)
        .await
        .context("Failed to load queued integration requests")?;
        if rows.is_empty() {
            return Ok(());
        }
        let running = running_schedule_directories()
            .await
            .context("Failed to determine whether Schedule I is running")?;
        for row in rows {
            let id = row.get::<String, _>("id");
            let environment_id = row.get::<String, _>("environment_id");
            let mod_file_name = row.get::<String, _>("mod_file_name");
            let environment = EnvironmentService::new(self.pool.clone())?
                .get_environment(&environment_id)
                .await?;
            let Some(environment) = environment else {
                self.finish_request(
                    &id,
                    ModIntegrationRequestStatus::Failed,
                    "The target installation no longer exists",
                )
                .await?;
                continue;
            };
            if running.contains(&normalize_path(Path::new(&environment.output_dir))) {
                continue;
            }
            match self
                .refresh_requested_mod(&environment_id, &mod_file_name)
                .await
            {
                Ok(mod_info) if mod_info.metadata.update_available == Some(true) => {
                    let result =
                        if let Some(fixture_path) = mod_info.local_test_fixture_path.as_ref() {
                            self.install_local_test_fixture_update(
                                &environment,
                                &mod_info,
                                fixture_path,
                            )
                            .await
                        } else {
                            update_mod_for_environment(
                                self.pool.clone(),
                                &self.app,
                                &environment_id,
                                &mod_file_name,
                                self.runtime_settings.snapshot().await,
                                false,
                            )
                            .await
                        };
                    match result {
                        Ok(_) => {
                            self.finish_request(
                                &id,
                                ModIntegrationRequestStatus::UpToDate,
                                "The update was installed successfully",
                            )
                            .await?;
                        }
                        Err(error) => {
                            self.finish_request(
                                &id,
                                ModIntegrationRequestStatus::Failed,
                                &format!("The update could not be installed: {error}"),
                            )
                            .await?;
                        }
                    }
                }
                Ok(_) => {
                    self.finish_request(
                        &id,
                        ModIntegrationRequestStatus::UpdateNotAvailable,
                        "The update was rechecked and is no longer available",
                    )
                    .await?;
                }
                Err(error) => {
                    self.finish_request(
                        &id,
                        ModIntegrationRequestStatus::Failed,
                        &format!("The queued update could not be rechecked: {error}"),
                    )
                    .await?;
                }
            }
            self.emit_changed(&environment_id);
        }
        Ok(())
    }

    async fn install_local_test_fixture_update(
        &self,
        environment: &crate::types::Environment,
        mod_info: &ResolvedIntegrationMod,
        fixture_path: &Path,
    ) -> std::result::Result<serde_json::Value, String> {
        let target_version = mod_info.metadata.remote_version.clone().ok_or_else(|| {
            "The local integration test fixture has no target version".to_string()
        })?;
        let metadata = serde_json::json!({
            "source": "local",
            "sourceId": format!("simm-integration-test:{}", mod_info.file_name),
            "sourceVersion": target_version,
            "installedVersion": mod_info.metadata.remote_version,
            "modName": mod_info.name,
            "detectedRuntime": environment.runtime.canonical_label(),
        });
        let result = upload_mod_impl(
            self.pool.clone(),
            &self.runtime_settings.snapshot().await,
            environment.id.clone(),
            fixture_path.to_string_lossy().to_string(),
            mod_info.file_name.clone(),
            environment.runtime.canonical_label().to_string(),
            environment.branch.clone(),
            Some(metadata),
            Some(false),
        )
        .await?;
        if result.get("success").and_then(|value| value.as_bool()) != Some(true) {
            return Err(result
                .get("error")
                .and_then(|value| value.as_str())
                .unwrap_or("The local integration test update did not install")
                .to_string());
        }
        invalidate_mod_library_cache("local mod integration test update").await;
        sync_active_profiles_for_envs(self.pool.clone(), [environment.id.clone()]).await;
        emit_environment_payload_changed_for_envs(&self.app, [environment.id.clone()]);
        Ok(result)
    }

    async fn finish_request(
        &self,
        request_id: &str,
        status: ModIntegrationRequestStatus,
        message: &str,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE mod_integration_requests SET status = ?, message = ?, updated_at = ? WHERE id = ?",
        )
        .bind(status.as_str())
        .bind(message)
        .bind(Utc::now().to_rfc3339())
        .bind(request_id)
        .execute(&*self.pool)
        .await
        .context("Failed to finish mod integration request")?;
        Ok(())
    }

    async fn allow_request(&self, environment_id: &str) -> bool {
        let now = Instant::now();
        let mut limits = self.rate_limits.lock().await;
        let requests = limits.entry(environment_id.to_string()).or_default();
        while requests
            .front()
            .is_some_and(|instant| now.duration_since(*instant) >= Duration::from_secs(60))
        {
            requests.pop_front();
        }
        if requests.len() >= REQUESTS_PER_MINUTE {
            return false;
        }
        requests.push_back(now);
        true
    }

    fn error_response(
        request_id: String,
        status: ModIntegrationRequestStatus,
        message: &str,
    ) -> ModIntegrationWireResponse {
        ModIntegrationWireResponse {
            protocol_version: MOD_INTEGRATION_PROTOCOL_VERSION,
            request_id,
            status,
            message: message.to_string(),
            current_version: None,
            target_version: None,
            source: None,
            queued_request_id: None,
        }
    }

    fn bridge_config_path(output_dir: &str) -> PathBuf {
        Path::new(output_dir)
            .join("UserData")
            .join("SIMM")
            .join("mod-integration.json")
    }

    async fn read_bridge_config(path: &Path) -> Result<BridgeConfigFile> {
        let payload = tokio::fs::read(path)
            .await
            .with_context(|| format!("Failed to read {}", path.display()))?;
        serde_json::from_slice(Self::strip_utf8_bom(&payload))
            .with_context(|| format!("Failed to parse {}", path.display()))
    }

    fn validate_bridge_config(
        config: &BridgeConfigFile,
        environment_id: &str,
        stored_token_hash: &str,
    ) -> Result<u16> {
        if config.protocol_version != MOD_INTEGRATION_PROTOCOL_VERSION {
            anyhow::bail!(
                "The bridge configuration uses unsupported protocol v{}",
                config.protocol_version
            );
        }
        if config.environment_id != environment_id {
            anyhow::bail!("The bridge configuration belongs to a different environment");
        }
        if config.capability_token.len() < 32 || config.capability_token.len() > 256 {
            anyhow::bail!("The bridge configuration contains an invalid private token");
        }
        if !Self::constant_time_eq(
            Self::hash_token(&config.capability_token).as_bytes(),
            stored_token_hash.as_bytes(),
        ) {
            anyhow::bail!("The bridge configuration private token does not match SIMM");
        }
        config.configured_port()
    }

    async fn write_bridge_config(path: &Path, config: BridgeConfigFile) -> Result<()> {
        let parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Invalid bridge configuration path"))?;
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("Failed to create {}", parent.display()))?;
        let temporary = path.with_extension("json.tmp");
        let payload = serde_json::to_vec_pretty(&config)?;
        tokio::fs::write(&temporary, payload)
            .await
            .with_context(|| format!("Failed to write {}", temporary.display()))?;
        if path.exists() {
            tokio::fs::remove_file(path)
                .await
                .with_context(|| format!("Failed to replace {}", path.display()))?;
        }
        tokio::fs::rename(&temporary, path)
            .await
            .with_context(|| format!("Failed to finalize {}", path.display()))?;
        Ok(())
    }

    fn new_capability_token() -> String {
        format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )
    }

    fn strip_utf8_bom(bytes: &[u8]) -> &[u8] {
        bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes)
    }

    fn hash_token(token: &str) -> String {
        hex::encode(Sha256::digest(token.as_bytes()))
    }

    fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
        if left.len() != right.len() {
            return false;
        }
        left.iter()
            .zip(right.iter())
            .fold(0_u8, |difference, (left, right)| {
                difference | (left ^ right)
            })
            == 0
    }

    fn source_label(source: &ModSource) -> String {
        match source {
            ModSource::Thunderstore => "thunderstore",
            ModSource::Nexusmods => "nexusmods",
            ModSource::Github => "github",
            ModSource::Local => "local",
            ModSource::Unknown => "unknown",
        }
        .to_string()
    }

    fn emit_changed(&self, environment_id: &str) {
        let _ = self.app.emit(
            "mod_integration_requests_changed",
            serde_json::json!({ "environmentId": environment_id }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_mod_integration_infrastructure_file, strip_runtime_suffix_from_mod_name,
        BridgeConfigFile, ModIntegrationService, MOD_INTEGRATION_PROTOCOL_VERSION,
    };
    use serial_test::serial;
    use tempfile::tempdir;

    const LOCAL_FIXTURE_ENV: &str = "SIMMRUST_MOD_INTEGRATION_TEST_LOCAL_UPDATE_DIR";

    struct FixtureEnvironmentGuard(Option<std::ffi::OsString>);

    impl FixtureEnvironmentGuard {
        fn set(path: &std::path::Path) -> Self {
            let previous = std::env::var_os(LOCAL_FIXTURE_ENV);
            std::env::set_var(LOCAL_FIXTURE_ENV, path);
            Self(previous)
        }
    }

    impl Drop for FixtureEnvironmentGuard {
        fn drop(&mut self) {
            if let Some(previous) = self.0.take() {
                std::env::set_var(LOCAL_FIXTURE_ENV, previous);
            } else {
                std::env::remove_var(LOCAL_FIXTURE_ENV);
            }
        }
    }

    #[test]
    fn capability_tokens_are_long_and_unique() {
        let first = ModIntegrationService::new_capability_token();
        let second = ModIntegrationService::new_capability_token();
        assert_eq!(first.len(), 64);
        assert_eq!(second.len(), 64);
        assert_ne!(first, second);
    }

    #[test]
    fn token_comparison_rejects_different_values() {
        assert!(ModIntegrationService::constant_time_eq(b"same", b"same"));
        assert!(!ModIntegrationService::constant_time_eq(b"same", b"diff"));
        assert!(!ModIntegrationService::constant_time_eq(
            b"short", b"longer"
        ));
    }

    #[test]
    fn protocol_accepts_windows_utf8_bom() {
        assert_eq!(
            ModIntegrationService::strip_utf8_bom(b"\xEF\xBB\xBF{\"protocolVersion\":1}"),
            b"{\"protocolVersion\":1}"
        );
        assert_eq!(
            ModIntegrationService::strip_utf8_bom(b"{\"protocolVersion\":1}"),
            b"{\"protocolVersion\":1}"
        );
    }

    #[test]
    fn bridge_config_prefers_a_numeric_loopback_port() {
        let config = BridgeConfigFile {
            protocol_version: MOD_INTEGRATION_PROTOCOL_VERSION,
            port: Some(43872),
            endpoint: Some("192.168.1.20:1234".to_string()),
            environment_id: "environment".to_string(),
            capability_token: "a".repeat(64),
        };

        assert_eq!(config.configured_port().unwrap(), 43872);
    }

    #[test]
    fn bridge_config_accepts_only_loopback_legacy_endpoints() {
        let legacy = |endpoint: &str| BridgeConfigFile {
            protocol_version: MOD_INTEGRATION_PROTOCOL_VERSION,
            port: None,
            endpoint: Some(endpoint.to_string()),
            environment_id: "environment".to_string(),
            capability_token: "a".repeat(64),
        };

        assert_eq!(legacy("127.0.0.1:43871").configured_port().unwrap(), 43871);
        assert_eq!(legacy("[::1]:43872").configured_port().unwrap(), 43872);
        assert!(legacy("192.168.1.20:43871").configured_port().is_err());
        assert!(legacy("127.0.0.1:0").configured_port().is_err());
    }

    #[test]
    fn bridge_port_sequence_advances_and_wraps_without_using_zero() {
        assert_eq!(ModIntegrationService::port_in_sequence(43_871, 0), 43_871);
        assert_eq!(ModIntegrationService::port_in_sequence(43_871, 1), 43_872);
        assert_eq!(ModIntegrationService::port_in_sequence(65_535, 1), 1);
    }

    #[tokio::test]
    async fn bridge_port_selection_skips_an_occupied_loopback_port() {
        let occupied = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("occupied listener");
        let requested = occupied.local_addr().expect("occupied address").port();

        let (selected, available) = ModIntegrationService::bind_next_available_port(requested)
            .await
            .expect("next available listener");

        assert_ne!(selected, requested);
        drop(available);
        drop(occupied);
    }

    #[test]
    fn bridge_runtime_files_are_identified_as_simm_infrastructure() {
        for file_name in [
            "Simm.ModIntegration.Bridge.MelonLoader.dll",
            "Simm.ModIntegration.Abstractions.dll",
            "Simm.ModIntegration.Bridge.Core.dll",
            "SIMM.MODINTEGRATION.BRIDGE.CORE.DLL.disabled",
        ] {
            assert!(is_mod_integration_infrastructure_file(file_name));
        }
        assert!(!is_mod_integration_infrastructure_file("PackRat-Mono.dll"));
    }

    #[test]
    fn runtime_suffix_is_not_part_of_the_mod_source_identity() {
        for name in [
            "PackRat-IL2CPP",
            "PackRat_IL2CPP",
            "PackRat IL2CPP",
            "PackRat - IL2CPP",
            "PackRat (IL2CPP)",
            "PackRat [IL2CPP]",
            "PackRat-Mono",
        ] {
            assert_eq!(strip_runtime_suffix_from_mod_name(name), "PackRat");
        }
        assert_eq!(strip_runtime_suffix_from_mod_name("Mono"), "Mono");
        assert_eq!(
            strip_runtime_suffix_from_mod_name("MonoBehaviour Tools"),
            "MonoBehaviour Tools"
        );
    }

    #[test]
    #[serial]
    fn local_test_fixture_requires_an_exact_file_inside_the_configured_directory() {
        let temp = tempdir().expect("fixture directory");
        let fixture = temp.path().join("PackRat-Mono.dll");
        std::fs::write(&fixture, b"fixture").expect("fixture file");
        let _guard = FixtureEnvironmentGuard::set(temp.path());

        assert_eq!(
            ModIntegrationService::local_test_fixture_path("PackRat-Mono.dll"),
            fixture.canonicalize().ok()
        );
        assert!(ModIntegrationService::local_test_fixture_path("../PackRat-Mono.dll").is_none());
        assert!(ModIntegrationService::local_test_fixture_path("Missing.dll").is_none());
    }
}
