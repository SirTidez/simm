use anyhow::Result;
use sqlx::SqlitePool;
use std::path::PathBuf;

pub struct EnvVarGuard {
    key: &'static str,
    original: Option<String>,
}

impl EnvVarGuard {
    pub fn set(key: &'static str, value: &str) -> Self {
        let original = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, original }
    }

    pub fn unset(key: &'static str) -> Self {
        let original = std::env::var(key).ok();
        std::env::remove_var(key);
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

pub async fn init_test_pool_with_temp_data_dir() -> Result<(tempfile::TempDir, EnvVarGuard, std::sync::Arc<SqlitePool>)> {
    let temp = tempfile::tempdir()?;
    let data_dir: PathBuf = temp.path().join("simmrust");
    let guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
    let pool = crate::db::initialize_pool().await?;
    Ok((temp, guard, pool))
}
