#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod commands;
mod config;
mod db;
mod discord_rpc;
mod events;
mod services;
#[cfg(test)]
mod test_helpers;
mod types;
mod utils;

use sqlx::SqlitePool;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

static DEPOT_SHUTDOWN_STARTED: AtomicBool = AtomicBool::new(false);

fn main() {
    // Initialize global logger FIRST to capture all output
    crate::utils::global_logger::init_global_logger();
    crate::utils::global_logger::init_logger_service();
    log::info!("Initializing Tauri application...");

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app.emit(
                "single-instance-args",
                serde_json::json!({
                    "args": argv,
                    "cwd": cwd,
                }),
            );
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            log::info!("Tauri app starting - running setup");

            app.manage(crate::commands::app_init::AppPreparationState::default());

            #[cfg(any(target_os = "linux", all(debug_assertions, target_os = "windows")))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(error) = app.deep_link().register_all() {
                    log::warn!("Failed to register desktop deep links: {}", error);
                }
            }

            // Explicitly set window icon (taskbar + title bar) from bundle icon
            if let Some(window) = app.get_webview_window("main") {
                log::info!("Main window found");
                if let Err(e) = window.set_decorations(false) {
                    log::warn!("Failed to disable native window decorations: {}", e);
                }
                if let Some(icon) = app.default_window_icon() {
                    if let Err(e) = window.set_icon(icon.clone()) {
                        log::warn!("Failed to set window icon: {}", e);
                    }
                } else {
                    log::warn!("No default window icon available");
                }
                let close_app = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let close_app = close_app.clone();
                        tauri::async_runtime::spawn(async move {
                            crate::commands::tray::handle_main_window_close(close_app).await;
                        });
                    }
                });
            } else {
                log::warn!("Main window not found!");
            }

            let show = MenuItem::with_id(app, "show", "Show SIMM", true, None::<&str>)?;
            let check_updates = MenuItem::with_id(
                app,
                "check_updates",
                "Check for Updates",
                true,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quit SIMM", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &check_updates, &quit])?;
            let mut tray = TrayIconBuilder::with_id("simm-tray").menu(&menu);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, event| match event.id.as_ref() {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "check_updates" => {
                    if let Some(pool) = app.try_state::<Arc<SqlitePool>>() {
                        let pool = pool.inner().clone();
                        let app = app.clone();
                        let runtime_settings = app
                            .try_state::<crate::services::settings::RuntimeSettingsState>()
                            .map(|state| state.inner().clone());
                        tauri::async_runtime::spawn(async move {
                            let Some(runtime_settings) = runtime_settings else {
                                log::warn!(
                                    "Runtime settings state is not ready for tray update check"
                                );
                                return;
                            };
                            if let Err(error) =
                                crate::commands::update_check::run_background_update_checks(
                                    pool,
                                    app,
                                    true,
                                    runtime_settings.snapshot().await,
                                )
                                .await
                            {
                                log::warn!("Tray update check failed: {}", error);
                            }
                        });
                    }
                }
                "quit" => app.exit(0),
                _ => {}
            })
            .build(app)?;

            log::info!("Tauri setup complete");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // App Init
            commands::app_update::check_app_update,
            commands::app_update::install_app_update,
            commands::app_init::prepare_app,
            commands::app_init::was_simm_directory_just_created,
            commands::app_init::get_app_startup_state,
            commands::app_init::get_linux_readiness_status,
            commands::app_init::repair_linux_desktop_integration,
            commands::app_init::get_home_directory,
            commands::app_init::get_backups_directory,
            commands::tray::hide_main_window,
            commands::tray::quit_simm,
            // DepotDownloader
            commands::depotdownloader::detect_depot_downloader,
            commands::depotdownloader::install_depot_downloader,
            // Settings
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::backup_database,
            commands::settings::repair_database,
            commands::settings::get_custom_themes,
            commands::settings::get_themes_directory,
            commands::telemetry::get_telemetry_capability,
            commands::telemetry::get_telemetry_preferences,
            commands::telemetry::save_telemetry_preferences,
            commands::telemetry::list_telemetry_mod_policies,
            commands::telemetry::save_telemetry_mod_rule,
            commands::telemetry::capture_mod_telemetry_snapshot,
            commands::telemetry::list_mod_telemetry_snapshots,
            commands::telemetry::get_mod_telemetry_snapshot,
            commands::telemetry::delete_mod_telemetry_snapshot,
            commands::telemetry::get_live_telemetry_status,
            commands::telemetry::list_live_telemetry_events,
            commands::telemetry::clear_live_telemetry_history,
            commands::telemetry::export_live_telemetry_history,
            commands::telemetry_upload::preview_telemetry_upload,
            commands::telemetry_upload::queue_telemetry_upload,
            commands::telemetry_upload::list_telemetry_uploads,
            commands::telemetry_upload::flush_queued_telemetry_uploads,
            commands::telemetry_upload::retry_telemetry_upload,
            commands::settings::save_credentials,
            commands::settings::clear_credentials,
            commands::settings::save_nexus_mods_api_key,
            commands::settings::get_nexus_mods_api_key,
            commands::settings::has_nexus_mods_api_key,
            commands::settings::clear_nexus_mods_api_key,
            commands::security_scanner::get_security_scanner_status,
            commands::security_scanner::install_security_scanner,
            commands::security_scanner::get_mod_security_scan_report,
            commands::security_scanner::scan_installed_mod_for_security,
            // Environments
            commands::environments::get_environments,
            commands::environments::get_environment,
            commands::environments::create_environment,
            commands::environments::update_environment,
            commands::environments::delete_environment,
            commands::environments::get_schedule1_config,
            commands::environments::detect_steam_installations,
            commands::environments::create_steam_environment,
            commands::environments::import_local_environment,
            // Downloads
            commands::downloads::start_download,
            commands::downloads::cancel_download,
            commands::downloads::get_download_progress,
            // Auth
            commands::auth::authenticate,
            commands::auth::authenticate_qr,
            // Filesystem
            commands::filesystem::open_folder,
            commands::filesystem::open_path,
            commands::filesystem::open_external_url,
            commands::filesystem::reveal_path,
            commands::filesystem::launch_game,
            commands::filesystem::browse_directory,
            commands::filesystem::browse_files,
            commands::filesystem::create_directory,
            // Mods
            commands::mods::get_mods,
            commands::mods::get_mods_count,
            commands::mods::get_mod_library,
            commands::mods::preview_local_mod_source_link,
            commands::mods::get_local_mod_existing_source_hint,
            commands::mods::get_local_mod_ownership_candidates,
            commands::mods::promote_local_mod_to_managed,
            commands::mods::install_downloaded_mod,
            commands::mods::uninstall_downloaded_mod,
            commands::mods::delete_downloaded_mod,
            commands::mods::delete_mod,
            commands::mods::enable_mod,
            commands::mods::disable_mod,
            commands::mods::open_mods_folder,
            commands::mods::check_mod_installed,
            commands::mods::find_existing_mod_storage,
            commands::mods::cleanup_duplicate_mod_storage,
            commands::mods::get_s1api_installation_status,
            commands::mods::store_mod_archive,
            commands::mods::download_s1api_to_library,
            commands::mods::download_mlvscan_to_library,
            commands::mod_profiles::export_environment_profile,
            commands::mod_profiles::list_mod_profiles,
            commands::mod_profiles::get_mod_profile,
            commands::mod_profiles::save_mod_profile,
            commands::mod_profiles::capture_mod_profile,
            commands::mod_profiles::import_mod_profile_to_library,
            commands::mod_profiles::export_mod_profile_from_library,
            commands::mod_profiles::delete_mod_profile,
            commands::mod_profiles::preview_mod_profile_apply,
            commands::mod_profiles::apply_mod_profile,
            commands::mod_profiles::save_mod_profile_file,
            commands::mod_profiles::read_mod_profile_file,
            commands::mod_profiles::preview_mod_profile_import,
            commands::mod_profiles::apply_mod_profile_import,
            // Plugins
            commands::plugins::get_plugins,
            commands::plugins::get_plugins_count,
            commands::plugins::delete_plugin,
            commands::plugins::enable_plugin,
            commands::plugins::disable_plugin,
            commands::plugins::open_plugins_folder,
            // UserLibs
            commands::userlibs::get_userlibs,
            commands::userlibs::get_userlibs_count,
            commands::userlibs::delete_user_lib,
            commands::userlibs::enable_user_lib,
            commands::userlibs::disable_user_lib,
            commands::userlibs::open_user_libs_folder,
            commands::userlibs::upload_user_lib,
            // Update checks
            commands::update_check::check_update,
            commands::update_check::check_all_updates,
            commands::update_check::get_update_status,
            // MelonLoader
            commands::melon_loader::get_melon_loader_status,
            commands::melon_loader::install_melon_loader,
            commands::melon_loader::repair_melonloader_launch_options,
            commands::melon_loader::verify_melonloader_launch,
            commands::melon_loader::uninstall_melon_loader,
            commands::melon_loader::get_available_melonloader_versions,
            // GitHub Releases
            commands::github_releases::get_latest_melon_loader_release,
            commands::github_releases::get_all_melon_loader_releases,
            commands::github_releases::get_latest_s1api_release,
            commands::github_releases::get_all_s1api_releases,
            commands::github_releases::get_latest_mlvscan_release,
            commands::github_releases::get_all_mlvscan_releases,
            commands::github_releases::get_release_api_health, // NexusMods
            commands::nexus_mods::begin_nexus_oauth_login,
            commands::nexus_mods::complete_nexus_oauth_callback,
            commands::nexus_mods::get_nexus_oauth_status,
            commands::nexus_mods::logout_nexus_oauth,
            commands::nexus_mods::begin_nexus_manual_download_session,
            commands::nexus_mods::complete_nexus_manual_download_session,
            commands::nexus_mods::cancel_nexus_manual_download_session,
            commands::nexus_mods::get_nexus_mods_games,
            commands::nexus_mods::get_nexus_rate_limits,
            commands::nexus_mods::search_nexus_mods_mods,
            commands::nexus_mods::get_nexus_mods_latest_added,
            commands::nexus_mods::get_nexus_mods_latest_updated,
            commands::nexus_mods::get_nexus_mods_trending,
            commands::nexus_mods::get_nexus_mods_mod,
            commands::nexus_mods::get_nexus_mods_mod_files,
            commands::nexus_mods::get_nexus_mod_file_dependencies,
            commands::nexus_mods::download_nexus_mods_mod_file,
            commands::nexus_mods::download_nexus_mod_to_library,
            commands::nexus_mods::install_nexus_mods_mod,
            commands::nexus_mods::check_nexus_mods_mod_update,
            commands::nexus_mods::check_nexus_mods_for_updates,
            // Thunderstore
            commands::thunderstore::search_thunderstore_packages,
            commands::thunderstore::search_thunderstore_packages_by_runtime,
            commands::thunderstore::refresh_thunderstore_package_cache,
            commands::thunderstore::get_thunderstore_package,
            commands::thunderstore::download_thunderstore_package,
            commands::thunderstore::get_thunderstore_request_stats,
            // Mod Updates
            commands::mod_update::check_mod_updates,
            commands::mod_update::update_mod,
            commands::mod_update::get_mod_updates_summary,
            commands::mod_update::get_all_mod_updates_summary,
            // Logs (game logs)
            commands::logs::get_log_files,
            commands::logs::read_log_file,
            commands::logs::export_logs,
            commands::logs::watch_log_file,
            commands::logs::stop_watching_log,
            // App Logging
            commands::logs::log_frontend_message,
            commands::logs::set_app_log_level,
            commands::logs::set_app_log_retention_days,
            commands::logs::get_app_log_retention_days,
            commands::logs::list_app_log_files,
            commands::logs::read_app_log_file,
            // Schedule I save management
            commands::save_backups::get_game_save_backup_status,
            commands::save_backups::create_game_save_backup,
            commands::save_backups::export_game_save_backup,
            commands::save_backups::preview_game_save_backup_restore,
            commands::save_backups::preview_game_save_zip_restore,
            commands::save_backups::restore_game_save_backup,
            commands::save_backups::restore_game_save_from_zip,
            // Config
            commands::config::get_config_catalog,
            commands::config::get_config_document,
            commands::config::apply_config_edits,
            commands::config::save_raw_config,
            // FOMOD
            commands::fomod::detect_fomod,
            commands::fomod::parse_fomod_xml,
            // Mods upload/install
            commands::mods::upload_mod,
            commands::mods::install_s1api,
            commands::mods::uninstall_s1api,
            // Plugins upload
            commands::plugins::upload_plugin,
            commands::plugins::get_mlvscan_installation_status,
            commands::plugins::install_mlvscan,
            commands::plugins::uninstall_mlvscan,
            // Game Version
            commands::game_version::extract_game_version,
            commands::game_version::extract_game_version_from_path,
            // Discord RPC
            commands::discord_rpc::discord_initialize,
            commands::discord_rpc::discord_shutdown,
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            crate::utils::logging::route_stderr_log(format!(
                "Failed to build Tauri application: {}",
                e
            ));
            std::process::exit(1);
        });

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { code, api, .. }
            if DEPOT_SHUTDOWN_STARTED
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok() =>
        {
            api.prevent_exit();
            let app_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                crate::commands::downloads::shutdown_downloads(&app_handle).await;
                app_handle.exit(code.unwrap_or(0));
            });
        }
        RunEvent::Exit => {
            // Forced exits may skip ExitRequested. Keep a synchronous bounded
            // fallback so SIMM never intentionally leaves its child process.
            if !DEPOT_SHUTDOWN_STARTED.swap(true, Ordering::AcqRel) {
                tauri::async_runtime::block_on(crate::commands::downloads::shutdown_downloads(
                    app_handle,
                ));
            }
            if let Some(pool) = app_handle.try_state::<Arc<SqlitePool>>() {
                if let Err(error) = tauri::async_runtime::block_on(
                    crate::commands::nexus_mods::cleanup_nxm_runtime_registration(
                        pool.inner().clone(),
                    ),
                ) {
                    log::warn!("Failed to restore nxm protocol handler on exit: {}", error);
                }
            }
        }
        _ => {}
    });
}
