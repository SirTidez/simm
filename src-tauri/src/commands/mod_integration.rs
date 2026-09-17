use crate::services::mod_integration::ModIntegrationService;
use crate::types::{ModIntegrationConfig, ModIntegrationPolicy, ModIntegrationRequestRecord};
use tauri::State;

#[tauri::command]
pub async fn get_mod_integration_config(
    service: State<'_, ModIntegrationService>,
    environment_id: String,
) -> Result<ModIntegrationConfig, String> {
    service
        .get_config(&environment_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn set_mod_integration_policy(
    service: State<'_, ModIntegrationService>,
    environment_id: String,
    policy: ModIntegrationPolicy,
) -> Result<ModIntegrationConfig, String> {
    service
        .set_policy(&environment_id, policy)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn list_mod_integration_requests(
    service: State<'_, ModIntegrationService>,
    environment_id: String,
) -> Result<Vec<ModIntegrationRequestRecord>, String> {
    service
        .list_requests(&environment_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn resolve_mod_integration_request(
    service: State<'_, ModIntegrationService>,
    request_id: String,
    approve: bool,
) -> Result<ModIntegrationRequestRecord, String> {
    service
        .resolve_user_request(&request_id, approve)
        .await
        .map_err(|error| error.to_string())
}
