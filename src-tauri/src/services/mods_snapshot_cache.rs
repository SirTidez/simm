use once_cell::sync::Lazy;
use serde_json::Value;
use std::collections::HashMap;
use tokio::sync::RwLock;

static MODS_SNAPSHOT_CACHE: Lazy<RwLock<HashMap<String, Value>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

pub async fn get(environment_id: &str) -> Option<Value> {
    let cache = MODS_SNAPSHOT_CACHE.read().await;
    cache.get(environment_id).cloned()
}

pub async fn set(environment_id: String, snapshot: Value) {
    let mut cache = MODS_SNAPSHOT_CACHE.write().await;
    cache.insert(environment_id, snapshot);
}

#[allow(dead_code)]
pub async fn remove(environment_id: &str) {
    let mut cache = MODS_SNAPSHOT_CACHE.write().await;
    cache.remove(environment_id);
}
