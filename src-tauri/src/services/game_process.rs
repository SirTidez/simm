use crate::types::GameProcessState;
use anyhow::{Context, Result};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

struct ProcessDiscovery {
    directories: Vec<PathBuf>,
    incomplete: bool,
}

pub(crate) async fn inspect_game_process(game_dir: &Path) -> (GameProcessState, Option<String>) {
    classify_process(game_dir, discover_schedule_process_paths().await)
}

fn classify_process(
    game_dir: &Path,
    discovery: Result<ProcessDiscovery>,
) -> (GameProcessState, Option<String>) {
    match discovery {
        Ok(discovery)
            if discovery
                .directories
                .iter()
                .any(|path| normalize_path(path) == normalize_path(game_dir)) =>
        {
            (GameProcessState::Running, None)
        }
        Ok(discovery) if !discovery.incomplete => (GameProcessState::NotRunning, None),
        Ok(_) => (
            GameProcessState::Unknown,
            Some("Some game process paths could not be inspected.".into()),
        ),
        Err(error) => (
            GameProcessState::Unknown,
            Some(format!("Could not inspect Schedule I processes: {error:#}")),
        ),
    }
}

pub(crate) async fn running_schedule_directories() -> Result<HashSet<String>> {
    let discovery = discover_schedule_process_paths().await?;
    anyhow::ensure!(
        !discovery.incomplete,
        "Some game process paths could not be inspected"
    );
    Ok(discovery
        .directories
        .into_iter()
        .map(|path| normalize_path(&path))
        .collect())
}

#[cfg(windows)]
async fn discover_schedule_process_paths() -> Result<ProcessDiscovery> {
    let script = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"Name = 'Schedule I.exe'\" | Select-Object ExecutablePath) | ConvertTo-Json -Compress";
    let mut command = tokio::process::Command::new("powershell");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x08000000)
        .kill_on_drop(true);
    let output = run_process_query(&mut command, std::time::Duration::from_secs(5)).await?;
    anyhow::ensure!(
        output.status.success(),
        "Schedule I process discovery command failed"
    );
    parse_windows_processes(&output.stdout)
}

#[cfg(windows)]
async fn run_process_query(
    command: &mut tokio::process::Command,
    timeout: std::time::Duration,
) -> Result<std::process::Output> {
    command.kill_on_drop(true);
    tokio::time::timeout(timeout, command.output())
        .await
        .context("Schedule I process discovery timed out")?
        .context("Failed to start Schedule I process discovery")
}

#[cfg(any(windows, test))]
fn parse_windows_processes(bytes: &[u8]) -> Result<ProcessDiscovery> {
    use serde_json::Value;
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(ProcessDiscovery {
            directories: vec![],
            incomplete: false,
        });
    }
    let value: Value = serde_json::from_slice(bytes)
        .context("Schedule I process discovery returned invalid JSON")?;
    let values = match value {
        Value::Array(values) => values,
        Value::Object(_) => vec![value],
        Value::Null => vec![],
        _ => anyhow::bail!("Unexpected process discovery response"),
    };
    let mut discovery = ProcessDiscovery {
        directories: vec![],
        incomplete: false,
    };
    for value in values {
        if let Some(directory) = value
            .get("ExecutablePath")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .and_then(|value| Path::new(value).parent())
        {
            discovery.directories.push(directory.to_path_buf());
        } else {
            discovery.incomplete = true;
        }
    }
    Ok(discovery)
}

#[cfg(target_os = "linux")]
async fn discover_schedule_process_paths() -> Result<ProcessDiscovery> {
    tokio::task::spawn_blocking(|| -> Result<ProcessDiscovery> {
        let mut discovery = ProcessDiscovery {
            directories: vec![],
            incomplete: false,
        };
        for entry in std::fs::read_dir("/proc").context("Failed to read process list")? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    discovery.incomplete = true;
                    continue;
                }
            };
            if !entry
                .file_name()
                .to_string_lossy()
                .chars()
                .all(|ch| ch.is_ascii_digit())
            {
                continue;
            }
            let name = match std::fs::read_to_string(entry.path().join("comm")) {
                Ok(name) => name,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    discovery.incomplete = true;
                    continue;
                }
            };
            if !is_linux_game_process(name.trim()) {
                continue;
            }
            let command_line = match std::fs::read(entry.path().join("cmdline")) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    discovery.incomplete = true;
                    continue;
                }
            };
            for value in command_line
                .split(|byte| *byte == 0)
                .filter(|arg| !arg.is_empty())
            {
                let argument = match std::str::from_utf8(value) {
                    Ok(arg) => arg,
                    Err(_) => {
                        discovery.incomplete = true;
                        continue;
                    }
                };
                if let Some(path) = linux_schedule_process_directory(argument) {
                    discovery.directories.push(path);
                    break;
                } else if argument
                    .replace('\\', "/")
                    .rsplit('/')
                    .next()
                    .is_some_and(|name| name.eq_ignore_ascii_case("Schedule I.exe"))
                {
                    // An unmapped Wine drive or relative executable does not establish absence.
                    discovery.incomplete = true;
                }
            }
        }
        Ok(discovery)
    })
    .await
    .context("Schedule I process discovery task failed")?
}

#[cfg(any(target_os = "linux", test))]
fn is_linux_game_process(name: &str) -> bool {
    [
        "Schedule I.exe",
        "Schedule I",
        "wine",
        "wine64",
        "wine-preloader",
        "wine64-preloader",
        "wine64-preloade",
    ]
    .iter()
    .any(|candidate| name.eq_ignore_ascii_case(candidate))
}

#[cfg(any(target_os = "linux", test))]
fn linux_schedule_process_directory(argument: &str) -> Option<PathBuf> {
    let normalized = argument.replace('\\', "/");
    let normalized = if normalized.len() >= 3
        && normalized.as_bytes()[0].is_ascii_alphabetic()
        && normalized.as_bytes()[1] == b':'
        && normalized.as_bytes()[2] == b'/'
    {
        if normalized.as_bytes()[0].eq_ignore_ascii_case(&b'z') {
            normalized[2..].to_string()
        } else {
            return None;
        }
    } else {
        normalized
    };
    if !normalized.starts_with('/') {
        return None;
    }
    let (parent, name) = normalized.rsplit_once('/')?;
    if !name.eq_ignore_ascii_case("Schedule I.exe") && !name.eq_ignore_ascii_case("Schedule I") {
        return None;
    }
    Some(PathBuf::from(if parent.is_empty() { "/" } else { parent }))
}

#[cfg(not(any(windows, target_os = "linux")))]
async fn discover_schedule_process_paths() -> Result<ProcessDiscovery> {
    anyhow::bail!("Process inspection is not supported on this platform")
}

pub(crate) fn normalize_path(path: &Path) -> String {
    normalize_path_for_platform(&path.to_string_lossy(), cfg!(windows))
}

fn normalize_path_for_platform(path: &str, windows: bool) -> String {
    if windows {
        path.trim_start_matches(r"\\?\")
            .trim_end_matches(['\\', '/'])
            .replace('/', "\\")
            .to_ascii_lowercase()
    } else {
        path.trim_end_matches('/').to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_installation_and_preserves_unknown_discovery() {
        let game = Path::new("C:/Games/one");
        let discovery = ProcessDiscovery {
            directories: vec![game.to_path_buf()],
            incomplete: false,
        };
        assert_eq!(
            classify_process(game, Ok(discovery)).0,
            GameProcessState::Running
        );
        let other = ProcessDiscovery {
            directories: vec![PathBuf::from("C:/Games/two")],
            incomplete: false,
        };
        assert_eq!(
            classify_process(game, Ok(other)).0,
            GameProcessState::NotRunning
        );
        assert_eq!(
            classify_process(game, Err(anyhow::anyhow!("access denied"))).0,
            GameProcessState::Unknown
        );
        let inaccessible = ProcessDiscovery {
            directories: vec![],
            incomplete: true,
        };
        assert_eq!(
            classify_process(game, Ok(inaccessible)).0,
            GameProcessState::Unknown
        );
    }

    #[test]
    fn inaccessible_windows_executable_is_not_an_absent_process() {
        let discovery = parse_windows_processes(br#"[{"ExecutablePath":null}]"#).unwrap();
        assert!(discovery.incomplete);
        assert!(parse_windows_processes(b"invalid json").is_err());
    }

    #[test]
    fn preserves_windows_and_proton_path_rules() {
        assert_eq!(
            normalize_path_for_platform("C:/Games/Schedule I/", true),
            normalize_path_for_platform("c:\\games\\schedule i", true)
        );
        assert_ne!(
            normalize_path_for_platform("/games/Schedule I", false),
            normalize_path_for_platform("/games/schedule i", false)
        );
        assert_eq!(
            linux_schedule_process_directory(r"Z:\home\player\Schedule I\Schedule I.exe"),
            Some(PathBuf::from("/home/player/Schedule I"))
        );
        assert!(linux_schedule_process_directory(r"C:\Games\Schedule I.exe").is_none());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn owned_process_query_is_bounded() {
        let mut command = tokio::process::Command::new("powershell");
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ])
            .creation_flags(0x08000000);
        let result = run_process_query(&mut command, std::time::Duration::from_millis(100)).await;
        assert!(result.unwrap_err().to_string().contains("timed out"));
    }

    #[test]
    fn non_game_linux_processes_do_not_match_an_executable_argument() {
        assert!(!is_linux_game_process("code"));
        assert!(!is_linux_game_process("steam"));
        assert!(is_linux_game_process("Schedule I.exe"));
        assert!(is_linux_game_process("wine64-preloader"));
    }
}
