use once_cell::sync::Lazy;
use serde_json::Value;
use std::collections::HashMap;
use tokio::sync::RwLock;

static MODS_SNAPSHOT_CACHE: Lazy<RwLock<HashMap<String, Value>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotReplacement {
    Inserted,
    Unchanged,
    Changed,
}

impl SnapshotReplacement {
    pub fn should_publish(self) -> bool {
        !matches!(self, Self::Unchanged)
    }
}

fn mod_sort_key(value: &Value) -> (String, String, String, String) {
    let field = |name: &str| {
        value
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase()
    };

    (
        field("path"),
        field("fileName"),
        field("name"),
        serde_json::to_string(value).unwrap_or_default(),
    )
}

/// `list_mods` reads directories in filesystem enumeration order, which is not
/// stable across refreshes. The order of the top-level `mods` projection is not
/// semantic, so normalize it before deciding whether clients need an event.
fn canonical_snapshot(snapshot: &Value) -> Value {
    let mut canonical = snapshot.clone();
    if let Some(mods) = canonical.get_mut("mods").and_then(Value::as_array_mut) {
        mods.sort_by_cached_key(mod_sort_key);
    }
    canonical
}

fn snapshots_semantically_equal(current: &Value, candidate: &Value) -> bool {
    canonical_snapshot(current) == canonical_snapshot(candidate)
}

pub async fn get(environment_id: &str) -> Option<Value> {
    let cache = MODS_SNAPSHOT_CACHE.read().await;
    cache.get(environment_id).cloned()
}

pub async fn set(environment_id: String, snapshot: Value) {
    let mut cache = MODS_SNAPSHOT_CACHE.write().await;
    cache.insert(environment_id, snapshot);
}

/// Atomically compares and replaces a snapshot under the cache write lock.
/// The returned decision is the sole authority for publishing refresh events,
/// preventing concurrent refreshes from emitting duplicate unchanged states.
pub async fn replace_if_changed(environment_id: String, snapshot: Value) -> SnapshotReplacement {
    let mut cache = MODS_SNAPSHOT_CACHE.write().await;
    let replacement = match cache.get(&environment_id) {
        None => SnapshotReplacement::Inserted,
        Some(current) if snapshots_semantically_equal(current, &snapshot) => {
            SnapshotReplacement::Unchanged
        }
        Some(_) => SnapshotReplacement::Changed,
    };

    if replacement.should_publish() {
        cache.insert(environment_id, snapshot);
    }

    replacement
}

#[allow(dead_code)]
pub async fn remove(environment_id: &str) {
    let mut cache = MODS_SNAPSHOT_CACHE.write().await;
    cache.remove(environment_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn snapshot(mods: Vec<Value>) -> Value {
        let count = mods.len();
        serde_json::json!({
            "mods": mods,
            "modsDirectory": "C:/game/Mods",
            "count": count
        })
    }

    fn mod_entry(name: &str, version: &str) -> Value {
        serde_json::json!({
            "name": name,
            "fileName": format!("{name}.dll"),
            "path": format!("C:/game/Mods/{name}.dll"),
            "version": version,
            "managed": false
        })
    }

    #[tokio::test]
    async fn replace_if_changed_ignores_filesystem_enumeration_order() {
        let environment_id = format!("env-{}", Uuid::new_v4());
        let alpha = mod_entry("Alpha", "1.0.0");
        let beta = mod_entry("Beta", "2.0.0");

        assert_eq!(
            replace_if_changed(
                environment_id.clone(),
                snapshot(vec![alpha.clone(), beta.clone()])
            )
            .await,
            SnapshotReplacement::Inserted
        );
        assert_eq!(
            replace_if_changed(environment_id.clone(), snapshot(vec![beta, alpha])).await,
            SnapshotReplacement::Unchanged
        );

        remove(&environment_id).await;
    }

    #[tokio::test]
    async fn replace_if_changed_publishes_only_real_content_changes() {
        let environment_id = format!("env-{}", Uuid::new_v4());
        let original = snapshot(vec![mod_entry("Alpha", "1.0.0")]);
        let changed = snapshot(vec![mod_entry("Alpha", "1.0.1")]);

        assert_eq!(
            replace_if_changed(environment_id.clone(), original.clone()).await,
            SnapshotReplacement::Inserted
        );
        assert_eq!(
            replace_if_changed(environment_id.clone(), original).await,
            SnapshotReplacement::Unchanged
        );
        assert_eq!(
            replace_if_changed(environment_id.clone(), changed.clone()).await,
            SnapshotReplacement::Changed
        );
        assert_eq!(get(&environment_id).await, Some(changed));

        remove(&environment_id).await;
    }

    #[tokio::test]
    async fn replace_if_changed_does_not_reorder_nested_semantic_arrays() {
        let environment_id = format!("env-{}", Uuid::new_v4());
        let mut original_mod = mod_entry("Alpha", "1.0.0");
        original_mod["tags"] = serde_json::json!(["utility", "framework"]);
        let mut reordered_tags = original_mod.clone();
        reordered_tags["tags"] = serde_json::json!(["framework", "utility"]);

        assert_eq!(
            replace_if_changed(environment_id.clone(), snapshot(vec![original_mod])).await,
            SnapshotReplacement::Inserted
        );
        assert_eq!(
            replace_if_changed(environment_id.clone(), snapshot(vec![reordered_tags])).await,
            SnapshotReplacement::Changed
        );

        remove(&environment_id).await;
    }

    #[tokio::test]
    async fn concurrent_identical_replacements_publish_once() {
        let environment_id = format!("env-{}", Uuid::new_v4());
        let candidate = snapshot(vec![mod_entry("Alpha", "1.0.0")]);
        let first = replace_if_changed(environment_id.clone(), candidate.clone());
        let second = replace_if_changed(environment_id.clone(), candidate);

        let (first_decision, second_decision) = tokio::join!(first, second);
        let decisions = [first_decision, second_decision];
        assert_eq!(
            decisions
                .into_iter()
                .filter(|decision| decision.should_publish())
                .count(),
            1
        );

        remove(&environment_id).await;
    }
}
