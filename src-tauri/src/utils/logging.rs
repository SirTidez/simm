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
