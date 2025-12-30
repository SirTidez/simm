use crate::services::nexus_mods::NexusModsService;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;

static NEXUS_MODS_SERVICE: Lazy<AsyncMutex<Option<Arc<NexusModsService>>>> = Lazy::new(|| AsyncMutex::new(None));

async fn get_nexus_mods_service() -> Result<Arc<NexusModsService>, String> {
    let mut service = NEXUS_MODS_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(NexusModsService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

#[tauri::command]
pub async fn validate_nexus_mods_api_key(api_key: String) -> Result<serde_json::Value, String> {
    let service = get_nexus_mods_service().await?;
    service.set_api_key(api_key).await;
    
    match service.validate_api_key().await {
        Ok(validation) => {
            let rate_limits = service.get_rate_limits().await
                .unwrap_or_else(|_| serde_json::json!({ "daily": 0, "hourly": 0 }));
            
            Ok(serde_json::json!({
                "success": true,
                "rateLimits": rate_limits,
                "user": validation.get("name").and_then(|n| n.as_str()).map(|n| serde_json::json!({
                    "name": n,
                    "isPremium": validation.get("is_premium").and_then(|p| p.as_bool()).unwrap_or(false),
                    "isSupporter": validation.get("is_supporter").and_then(|s| s.as_bool()).unwrap_or(false)
                }))
            }))
        }
        Err(e) => {
            Ok(serde_json::json!({
                "success": false,
                "error": e.to_string()
            }))
        }
    }
}

#[tauri::command]
pub async fn get_nexus_mods_rate_limits() -> Result<serde_json::Value, String> {
    let service = get_nexus_mods_service().await?;
    service.get_rate_limits()
        .await
        .map_err(|e| e.to_string())
}

