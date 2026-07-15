use anyhow::{anyhow, Result};

const DEFAULT_UPLOAD_BASE_URL: &str = "https://telemetry.lockwirelabs.com";

pub fn upload_base_url() -> Result<String> {
    let base_url = option_env!("TELEMETRY_UPLOAD_BASE_URL").unwrap_or(DEFAULT_UPLOAD_BASE_URL);
    validate_upload_base_url(base_url)
}

pub fn validate_upload_base_url(base_url: &str) -> Result<String> {
    let parsed =
        reqwest::Url::parse(base_url).map_err(|_| anyhow!("Invalid telemetry upload base URL"))?;
    if !cfg!(debug_assertions) && parsed.scheme() != "https" {
        return Err(anyhow!(
            "Telemetry upload base URL must use HTTPS outside development builds"
        ));
    }
    Ok(parsed.to_string().trim_end_matches('/').to_string())
}
