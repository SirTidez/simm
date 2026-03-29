pub fn route_stderr_log(message: String) {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return;
    }

    let uppercase = trimmed.to_ascii_uppercase();

    if uppercase.contains("[ERROR]")
        || uppercase.starts_with("ERROR")
        || uppercase.contains("FAILED")
        || uppercase.contains("FAILURE")
    {
        log::error!("{}", trimmed);
    } else if uppercase.contains("[WARN]")
        || uppercase.starts_with("WARN")
        || uppercase.contains("WARNING")
    {
        log::warn!("{}", trimmed);
    } else {
        log::info!("{}", trimmed);
    }
}

#[track_caller]
pub fn warn_with_location(message: impl AsRef<str>) {
    let location = std::panic::Location::caller();
    let message = crate::services::logger::LoggerService::sanitize_log_text(message.as_ref());
    route_stderr_log(format!(
        "[WARN] [{}:{}:{}] {}",
        location.file(),
        location.line(),
        location.column(),
        message
    ));
}

#[track_caller]
pub fn error_with_location(message: impl AsRef<str>) {
    let location = std::panic::Location::caller();
    let message = crate::services::logger::LoggerService::sanitize_log_text(message.as_ref());
    route_stderr_log(format!(
        "[ERROR] [{}:{}:{}] {}",
        location.file(),
        location.line(),
        location.column(),
        message
    ));
}
