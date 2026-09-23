use crate::services::environment::EnvironmentService;
use crate::services::filesystem::FileSystemService;
use crate::services::game_session_monitor::{normalize_path, running_schedule_directories};
use crate::services::settings::SettingsService;
use crate::types::{Environment, EnvironmentStatus, EnvironmentType};
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::json;
use std::ffi::OsString;
use std::path::Path;

const GAME_ID: &str = "schedule1";
const SCHEDULE_I_APP_ID: &str = "3164500";

#[derive(Debug, Clone, PartialEq, Eq)]
enum CliCommand {
    Help,
    Version,
    GameList,
    GameInfo {
        selector: String,
        profile: Option<String>,
    },
    GamePath {
        selector: String,
        profile: Option<String>,
    },
    Launch {
        selector: String,
        profile: Option<String>,
        launch_method: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CliRequest {
    command: CliCommand,
    json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum StartupMode {
    Gui,
    Cli(CliRequest),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentInfo {
    game: &'static str,
    app_id: String,
    environment_id: String,
    name: String,
    path: String,
    valid: bool,
    status: String,
    branch: String,
    runtime: String,
    game_version: Option<String>,
    melon_loader_version: Option<String>,
    mod_directory: String,
    running: bool,
    environment_type: String,
}

pub fn run_if_requested() -> Option<i32> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    let json_requested = args.iter().any(|arg| arg == "--json");
    let mode = match parse_startup_args(args) {
        Ok(mode) => mode,
        Err(error) => {
            prepare_console();
            if json_requested {
                emit_cli_error(true, "invalid-arguments", &error);
            } else {
                eprintln!("SIMM: {error}\n\n{}", help_text());
            }
            return Some(2);
        }
    };

    let StartupMode::Cli(request) = mode else {
        return None;
    };

    prepare_console();
    match request.command {
        CliCommand::Help => {
            println!("{}", help_text());
            Some(0)
        }
        CliCommand::Version => {
            if request.json {
                println!(
                    "{}",
                    json!({ "name": "SIMM", "version": env!("CARGO_PKG_VERSION") })
                );
            } else {
                println!("SIMM {}", env!("CARGO_PKG_VERSION"));
            }
            Some(0)
        }
        command => {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    emit_cli_error(request.json, "runtime-unavailable", &error.to_string());
                    return Some(1);
                }
            };
            match runtime.block_on(execute(command, request.json)) {
                Ok(output) => {
                    println!("{output}");
                    Some(0)
                }
                Err(error) => {
                    emit_cli_error(request.json, "command-failed", &error.to_string());
                    Some(1)
                }
            }
        }
    }
}

fn emit_cli_error(json_output: bool, code: &str, message: &str) {
    if json_output {
        eprintln!(
            "{}",
            json!({ "ok": false, "error": { "code": code, "message": message } })
        );
    } else {
        eprintln!("SIMM: {message}");
    }
}

#[cfg(target_os = "windows")]
fn prepare_console() {
    // Release builds use the Windows GUI subsystem so the normal application
    // never opens a console window. When explicitly invoked as a CLI, attach to
    // the caller's console so stdout/stderr remain usable from terminals.
    unsafe {
        let _ = winapi::um::wincon::AttachConsole(u32::MAX);
    }
}

#[cfg(not(target_os = "windows"))]
fn prepare_console() {}

fn parse_startup_args(args: Vec<OsString>) -> std::result::Result<StartupMode, String> {
    let args = args
        .into_iter()
        .map(|value| value.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    if args.is_empty() {
        return Ok(StartupMode::Gui);
    }

    if args.iter().any(|arg| is_desktop_uri(arg)) {
        return Ok(StartupMode::Gui);
    }

    let json_output = args.iter().any(|arg| arg == "--json");
    let filtered = args
        .iter()
        .filter(|arg| arg.as_str() != "--json")
        .cloned()
        .collect::<Vec<_>>();
    let Some(root) = filtered.first().map(|value| value.as_str()) else {
        return Err("--json must be used with a command".to_string());
    };

    let command = match root {
        "help" | "--help" | "-h" => CliCommand::Help,
        "version" | "--version" | "-V" => CliCommand::Version,
        "launch" => parse_launch_command(&filtered[1..])?,
        "game" => parse_game_command(&filtered[1..])?,
        unknown => return Err(format!("unknown command '{unknown}'")),
    };

    Ok(StartupMode::Cli(CliRequest {
        command,
        json: json_output,
    }))
}

fn is_desktop_uri(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    normalized.starts_with("simm://") || normalized.starts_with("nxm://")
}

fn parse_launch_command(args: &[String]) -> std::result::Result<CliCommand, String> {
    let (positionals, profile, launch_method) = parse_options(args, true)?;
    if positionals.len() > 1 {
        return Err("launch accepts at most one game or environment identifier".to_string());
    }
    Ok(CliCommand::Launch {
        selector: positionals
            .first()
            .cloned()
            .unwrap_or_else(|| GAME_ID.to_string()),
        profile,
        launch_method,
    })
}

fn parse_game_command(args: &[String]) -> std::result::Result<CliCommand, String> {
    let Some(action) = args.first().map(|value| value.as_str()) else {
        return Err("game requires one of: list, info, path".to_string());
    };
    if action == "list" {
        if args.len() != 1 {
            return Err("game list does not accept a game or profile identifier".to_string());
        }
        return Ok(CliCommand::GameList);
    }

    if action != "info" && action != "path" {
        return Err(format!("unknown game action '{action}'"));
    }
    let (positionals, profile, launch_method) = parse_options(&args[1..], false)?;
    if launch_method.is_some() {
        return Err("--launch-method is only valid with launch".to_string());
    }
    if positionals.len() > 1 {
        return Err(format!("game {action} accepts at most one identifier"));
    }
    let selector = positionals
        .first()
        .cloned()
        .unwrap_or_else(|| GAME_ID.to_string());
    Ok(if action == "info" {
        CliCommand::GameInfo { selector, profile }
    } else {
        CliCommand::GamePath { selector, profile }
    })
}

fn parse_options(
    args: &[String],
    allow_launch_method: bool,
) -> std::result::Result<(Vec<String>, Option<String>, Option<String>), String> {
    let mut positionals = Vec::new();
    let mut profile = None;
    let mut launch_method = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--profile" => {
                index += 1;
                let value = args
                    .get(index)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "--profile requires a value".to_string())?;
                profile = Some(value.clone());
            }
            "--launch-method" if allow_launch_method => {
                index += 1;
                let value = args.get(index).ok_or_else(|| {
                    "--launch-method requires steam, steam_restart, or direct".to_string()
                })?;
                if !matches!(value.as_str(), "steam" | "steam_restart" | "direct") {
                    return Err(format!("unsupported launch method '{value}'"));
                }
                launch_method = Some(value.clone());
            }
            option if option.starts_with('-') => {
                return Err(format!("unknown option '{option}'"));
            }
            positional => positionals.push(positional.to_string()),
        }
        index += 1;
    }
    Ok((positionals, profile, launch_method))
}

async fn execute(command: CliCommand, json_output: bool) -> Result<String> {
    let (pool, _) = crate::db::initialize_pool_with_startup_state()
        .await
        .context("failed to initialize SIMM data")?;
    let environment_service = EnvironmentService::new(pool.clone())?;
    let environments = environment_service.get_environments().await?;

    match command {
        CliCommand::GameList => render_environment_list(&environments, json_output).await,
        CliCommand::GameInfo { selector, profile } => {
            let environment = resolve_environment(&environments, &selector, profile.as_deref())?;
            let running_directories = running_schedule_directories().await?;
            let info = environment_info(environment, &running_directories);
            if json_output {
                Ok(serde_json::to_string_pretty(&info)?)
            } else {
                Ok(render_environment_info(&info))
            }
        }
        CliCommand::GamePath { selector, profile } => {
            let environment = resolve_environment(&environments, &selector, profile.as_deref())?;
            let valid = Path::new(&environment.output_dir).is_dir();
            if json_output {
                Ok(serde_json::to_string_pretty(&json!({
                    "game": GAME_ID,
                    "environmentId": environment.id,
                    "path": environment.output_dir,
                    "valid": valid,
                }))?)
            } else {
                Ok(environment.output_dir.clone())
            }
        }
        CliCommand::Launch {
            selector,
            profile,
            launch_method,
        } => {
            let selected = resolve_environment(&environments, &selector, profile.as_deref())?;
            let selected_id = selected.id.clone();
            let mut settings_service = SettingsService::new(pool.clone())?;
            let settings = settings_service.load_settings().await?;
            let environment_service =
                EnvironmentService::new(pool)?.with_runtime_settings(settings);
            let mut environment = environment_service
                .get_environment(&selected_id)
                .await?
                .ok_or_else(|| anyhow!("environment '{selected_id}' no longer exists"))?;

            validate_launch_environment(&environment)?;
            let runtime_switch = environment_service
                .reconcile_steam_env_branch_runtime_from_disk(&mut environment)
                .await?;
            if let Some(runtime_switch) = &runtime_switch {
                if !runtime_switch.errors.is_empty() {
                    return Err(anyhow!(
                        "runtime reconciliation failed: {}",
                        runtime_switch.errors.join(" ")
                    ));
                }
            }

            let method = resolve_launch_method(launch_method.as_deref(), &environment)?;
            let is_steam = environment.environment_type == Some(EnvironmentType::Steam);
            let game_dir = if method == "steam" && is_steam {
                None
            } else {
                Some(environment.output_dir.as_str())
            };
            let executable_path = FileSystemService::new()
                .launch_game(game_dir, Some(method))
                .await?;

            if json_output {
                Ok(serde_json::to_string_pretty(&json!({
                    "ok": true,
                    "game": GAME_ID,
                    "environmentId": environment.id,
                    "environmentName": environment.name,
                    "launchMethod": method,
                    "executablePath": executable_path,
                    "runtimeSwitch": runtime_switch,
                }))?)
            } else {
                Ok(format!(
                    "Launching {} ({}) via {}",
                    environment.name,
                    environment.runtime.canonical_label(),
                    method
                ))
            }
        }
        CliCommand::Help | CliCommand::Version => unreachable!("handled before database startup"),
    }
}

async fn render_environment_list(
    environments: &[Environment],
    json_output: bool,
) -> Result<String> {
    let running_directories = running_schedule_directories().await?;
    let mut items = Vec::with_capacity(environments.len());
    for environment in environments {
        items.push(environment_info(environment, &running_directories));
    }
    if json_output {
        return Ok(serde_json::to_string_pretty(&json!({
            "game": GAME_ID,
            "environments": items,
        }))?);
    }
    if items.is_empty() {
        return Ok("No SIMM game environments are configured.".to_string());
    }

    let mut lines = vec!["ID\tNAME\tRUNTIME\tBRANCH\tVALID\tRUNNING".to_string()];
    lines.extend(items.into_iter().map(|item| {
        format!(
            "{}\t{}\t{}\t{}\t{}\t{}",
            item.environment_id,
            item.name,
            item.runtime,
            item.branch,
            yes_no(item.valid),
            yes_no(item.running),
        )
    }));
    Ok(lines.join("\n"))
}

fn environment_info(
    environment: &Environment,
    running_directories: &std::collections::HashSet<String>,
) -> EnvironmentInfo {
    let running = !environment.output_dir.trim().is_empty()
        && running_directories.contains(&normalize_path(Path::new(&environment.output_dir)));
    let environment_type = match environment.environment_type {
        Some(EnvironmentType::Steam) => "steam",
        Some(EnvironmentType::DepotDownloader) => "depotDownloader",
        Some(EnvironmentType::Local) => "local",
        None => "unknown",
    };
    EnvironmentInfo {
        game: GAME_ID,
        app_id: environment.app_id.clone(),
        environment_id: environment.id.clone(),
        name: environment.name.clone(),
        path: environment.output_dir.clone(),
        valid: Path::new(&environment.output_dir).is_dir(),
        status: environment_status_label(&environment.status).to_string(),
        branch: environment.branch.clone(),
        runtime: environment.runtime.canonical_label().to_string(),
        game_version: environment.current_game_version.clone(),
        melon_loader_version: environment.melon_loader_version.clone(),
        mod_directory: Path::new(&environment.output_dir)
            .join("Mods")
            .to_string_lossy()
            .into_owned(),
        running,
        environment_type: environment_type.to_string(),
    }
}

fn render_environment_info(info: &EnvironmentInfo) -> String {
    [
        format!("Game: {}", info.game),
        format!("Environment: {} ({})", info.name, info.environment_id),
        format!("Path: {}", info.path),
        format!("Valid: {}", yes_no(info.valid)),
        format!("Status: {}", info.status),
        format!("Branch: {}", info.branch),
        format!("Runtime: {}", info.runtime),
        format!(
            "Game version: {}",
            info.game_version.as_deref().unwrap_or("unknown")
        ),
        format!(
            "MelonLoader: {}",
            info.melon_loader_version
                .as_deref()
                .unwrap_or("not recorded")
        ),
        format!("Mods: {}", info.mod_directory),
        format!("Running: {}", yes_no(info.running)),
    ]
    .join("\n")
}

fn resolve_environment<'a>(
    environments: &'a [Environment],
    selector: &str,
    profile: Option<&str>,
) -> Result<&'a Environment> {
    let game_candidates = if is_schedule_i_selector(selector) {
        environments
            .iter()
            .filter(|environment| environment.app_id == SCHEDULE_I_APP_ID)
            .collect::<Vec<_>>()
    } else {
        let exact = matching_environments(environments.iter(), selector);
        if exact.is_empty() {
            return Err(anyhow!("no environment matches '{selector}'"));
        }
        exact
    };

    let candidates = match profile {
        Some(profile) => matching_environments(game_candidates, profile),
        None => game_candidates,
    };

    match candidates.as_slice() {
        [environment] => Ok(*environment),
        [] => Err(anyhow!(
            "no environment matches profile '{}'",
            profile.unwrap_or(selector)
        )),
        many => Err(anyhow!(
            "'{}' matches multiple environments: {}. Choose one with --profile <id-or-name>.",
            profile.unwrap_or(selector),
            many.iter()
                .map(|environment| format!("{} ({})", environment.name, environment.id))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

fn matching_environments<'a>(
    environments: impl IntoIterator<Item = &'a Environment>,
    selector: &str,
) -> Vec<&'a Environment> {
    let environments = environments.into_iter().collect::<Vec<_>>();
    let exact = environments
        .iter()
        .copied()
        .filter(|environment| {
            environment.id.eq_ignore_ascii_case(selector)
                || environment.name.eq_ignore_ascii_case(selector)
        })
        .collect::<Vec<_>>();
    if !exact.is_empty() {
        return exact;
    }
    environments
        .into_iter()
        .filter(|environment| environment.branch.eq_ignore_ascii_case(selector))
        .collect()
}

fn is_schedule_i_selector(selector: &str) -> bool {
    matches!(
        selector.trim().to_ascii_lowercase().as_str(),
        GAME_ID | "schedule-i" | "schedule i" | SCHEDULE_I_APP_ID
    )
}

fn validate_launch_environment(environment: &Environment) -> Result<()> {
    if environment.output_dir.trim().is_empty() {
        return Err(anyhow!(
            "environment '{}' has no installation path",
            environment.name
        ));
    }
    if !matches!(environment.status, EnvironmentStatus::Completed) {
        return Err(anyhow!(
            "environment '{}' is not ready (status: {})",
            environment.name,
            environment_status_label(&environment.status)
        ));
    }
    Ok(())
}

fn resolve_launch_method<'a>(
    requested: Option<&'a str>,
    environment: &Environment,
) -> Result<&'a str> {
    let method = match requested {
        Some(method) => method,
        None if cfg!(target_os = "linux") => "steam",
        None if environment.environment_type == Some(EnvironmentType::Steam) => "steam",
        None => "direct",
    };
    if cfg!(target_os = "linux") && method == "direct" {
        return Err(anyhow!(
            "direct launch is not supported on Linux; use --launch-method steam"
        ));
    }
    Ok(method)
}

fn environment_status_label(status: &EnvironmentStatus) -> &'static str {
    match status {
        EnvironmentStatus::NotDownloaded => "not_downloaded",
        EnvironmentStatus::Downloading => "downloading",
        EnvironmentStatus::Completed => "completed",
        EnvironmentStatus::Unavailable => "unavailable",
        EnvironmentStatus::Error => "error",
    }
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "no"
    }
}

fn help_text() -> &'static str {
    "SIMM command line\n\nUSAGE:\n  simm launch [schedule1|environment] [--profile <id-or-name>] [--launch-method <method>] [--json]\n  simm game list [--json]\n  simm game info [schedule1|environment] [--profile <id-or-name>] [--json]\n  simm game path [schedule1|environment] [--profile <id-or-name>] [--json]\n  simm --version [--json]\n\nLAUNCH METHODS:\n  steam, steam_restart, direct\n\nWhen more than one installation matches, use --profile with its exact ID or name.\nRunning SIMM without arguments opens the normal desktop application."
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Runtime;
    use chrono::Utc;

    fn environment(id: &str, name: &str, branch: &str) -> Environment {
        Environment {
            id: id.to_string(),
            name: name.to_string(),
            description: None,
            app_id: SCHEDULE_I_APP_ID.to_string(),
            branch: branch.to_string(),
            output_dir: format!("C:\\Games\\{id}"),
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::Completed,
            last_updated: Some(Utc::now()),
            size: None,
            last_manifest_id: None,
            last_update_check: None,
            update_available: None,
            remote_manifest_id: None,
            remote_build_id: None,
            current_game_version: Some("0.4.6f13".to_string()),
            update_game_version: None,
            melon_loader_version: Some("0.7.3".to_string()),
            steamapps_dir: None,
            steam_manifest_path: None,
            environment_type: Some(EnvironmentType::Local),
        }
    }

    fn strings(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn no_arguments_or_desktop_uris_keep_normal_gui_startup() {
        assert_eq!(parse_startup_args(vec![]).unwrap(), StartupMode::Gui);
        assert_eq!(
            parse_startup_args(strings(&["nxm://schedule1/mods/1/files/2"])).unwrap(),
            StartupMode::Gui
        );
    }

    #[test]
    fn parser_supports_initial_commands_and_options() {
        assert_eq!(
            parse_startup_args(strings(&[
                "launch",
                "schedule1",
                "--profile",
                "Beta",
                "--launch-method",
                "steam_restart",
                "--json",
            ]))
            .unwrap(),
            StartupMode::Cli(CliRequest {
                command: CliCommand::Launch {
                    selector: "schedule1".to_string(),
                    profile: Some("Beta".to_string()),
                    launch_method: Some("steam_restart".to_string()),
                },
                json: true,
            })
        );
        assert_eq!(
            parse_startup_args(strings(&["game", "list", "--json"])).unwrap(),
            StartupMode::Cli(CliRequest {
                command: CliCommand::GameList,
                json: true,
            })
        );
    }

    #[test]
    fn parser_rejects_unknown_commands_and_incomplete_options() {
        assert!(parse_startup_args(strings(&["mods", "list"])).is_err());
        assert!(parse_startup_args(strings(&["launch", "--profile"])).is_err());
        assert!(parse_startup_args(strings(&[
            "launch",
            "schedule1",
            "--launch-method",
            "shell",
        ]))
        .is_err());
    }

    #[test]
    fn resolver_requires_an_explicit_profile_for_ambiguous_games() {
        let environments = vec![
            environment("steam-main", "Steam Installation", "main"),
            environment("beta", "Beta", "beta"),
            environment("vr-beta", "VR - Beta", "beta"),
        ];
        assert!(resolve_environment(&environments, "schedule1", None).is_err());
        assert_eq!(
            resolve_environment(&environments, "schedule1", Some("beta"))
                .unwrap()
                .id,
            "beta"
        );
        assert_eq!(
            resolve_environment(&environments, "Steam Installation", None)
                .unwrap()
                .id,
            "steam-main"
        );
    }
}
