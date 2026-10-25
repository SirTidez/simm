//! Shared interpretation of MelonLoader headers and the known interop startup notice.
pub(crate) fn is_level(tag: &str) -> bool {
    matches!(
        tag.to_ascii_uppercase().as_str(),
        "ERROR" | "FATAL" | "WARN" | "WARNING" | "INFO" | "DEBUG" | "TRACE" | "MSG"
    )
}

pub(crate) fn header(mut line: &str) -> (Option<&str>, Vec<&str>, &str) {
    let mut timestamp = None;
    let mut tags: Vec<&str> = Vec::new();
    for _ in 0..8 {
        // MelonLoader writes [time] [severity] [source], or [time] [source] for info.
        // Every bracket after the source is message text, even a literal [ERROR].
        if tags.iter().any(|tag| !is_level(tag)) {
            break;
        }
        let Some(rest) = line.strip_prefix('[') else {
            break;
        };
        let Some((tag, rest)) = rest.split_once(']') else {
            break;
        };
        if tag.len() > 160 {
            break;
        }
        if timestamp.is_none()
            && tags.is_empty()
            && tag.len() >= 8
            && tag.as_bytes().get(2) == Some(&b':')
            && tag.as_bytes().get(5) == Some(&b':')
        {
            timestamp = Some(tag);
        } else {
            if is_level(tag) && tags.iter().any(|tag| is_level(tag)) {
                break;
            }
            tags.push(tag);
        }
        line = rest.trim_start();
    }
    (timestamp, tags, line)
}

pub(crate) fn severity(tags: &[&str]) -> &'static str {
    match tags.first().map(|tag| tag.to_ascii_uppercase()).as_deref() {
        Some("ERROR" | "FATAL") => "ERROR",
        Some("WARN" | "WARNING") => "WARN",
        Some("DEBUG" | "TRACE") => "DEBUG",
        _ => "INFO",
    }
}

pub(crate) fn expected_interop_notice(
    level: &str,
    source: Option<&str>,
    message: &str,
    truncated: bool,
) -> bool {
    let message = message.trim();
    matches!(level, "warning" | "WARN" | "WARNING")
        && !truncated
        && source.is_some_and(|source| source.eq_ignore_ascii_case("Il2CppInterop"))
        && message
            .strip_suffix('!')
            .unwrap_or(message)
            .eq_ignore_ascii_case("Class::Init signatures have been exhausted, using a substitute")
}
