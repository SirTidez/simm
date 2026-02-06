#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod commands;
mod services;
mod types;
mod utils;
mod events;
mod db;

use tauri::Manager;

fn main() {
    // Initialize global logger FIRST to capture all output
    crate::utils::global_logger::init_global_logger();
    log::info!("Initializing Tauri application...");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            log::info!("Tauri app starting - running setup");

            // Initialize SIMM directory (synchronous)
            let simm_was_created = crate::services::app_init::initialize_simm_directory()
                .unwrap_or(false);

            log::info!("SIMM directory initialized (was_created: {})", simm_was_created);

            let db_pool = tauri::async_runtime::block_on(crate::db::initialize_pool())
                .map_err(|e| {
                    log::error!("Failed to initialize database: {}", e);
                    e
                })?;

            app.manage(db_pool.clone());

            // Store flag in app state so frontend can check it
            app.manage(tauri::async_runtime::Mutex::new(simm_was_created));

            // Initialize services (async)
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::services::app_init::initialize_services(app_handle).await {
                    log::error!("Error during service initialization: {}", e);
                    // Continue anyway - some services may still work
                }
            });

            // Ensure window stays open even if frontend has errors
            if let Some(window) = app.get_webview_window("main") {
                log::info!("Main window found");
                #[cfg(debug_assertions)]
                {
                    window.open_devtools();
                    log::info!("DevTools opened");
                }
            } else {
                log::warn!("Main window not found!");
            }

            log::info!("Tauri setup complete");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // App Init
            commands::app_init::was_simm_directory_just_created,
            commands::app_init::get_home_directory,
            // DepotDownloader
            commands::depotdownloader::detect_depot_downloader,
            // Settings
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::save_credentials,
            commands::settings::clear_credentials,
            commands::settings::set_github_token,
            commands::settings::has_github_token,
            commands::settings::clear_github_token,
            commands::settings::save_nexus_mods_api_key,
            commands::settings::get_nexus_mods_api_key,
            commands::settings::has_nexus_mods_api_key,
            commands::settings::clear_nexus_mods_api_key,
            // Environments
            commands::environments::get_environments,
            commands::environments::get_environment,
            commands::environments::create_environment,
            commands::environments::update_environment,
            commands::environments::delete_environment,
            commands::environments::get_schedule1_config,
            commands::environments::detect_steam_installations,
            commands::environments::create_steam_environment,
            // Downloads
            commands::downloads::start_download,
            commands::downloads::cancel_download,
            commands::downloads::get_download_progress,
            // Auth
            commands::auth::authenticate,
            // Filesystem
            commands::filesystem::open_folder,
            commands::filesystem::launch_game,
            commands::filesystem::browse_directory,
            commands::filesystem::browse_files,
            commands::filesystem::create_directory,
            // Mods
            commands::mods::get_mods,
            commands::mods::get_mods_count,
            commands::mods::get_mod_library,
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
            commands::userlibs::enable_user_lib,
            commands::userlibs::disable_user_lib,
            commands::userlibs::open_user_libs_folder,
            // Update checks
            commands::update_check::check_update,
            commands::update_check::check_all_updates,
            commands::update_check::get_update_status,
            // MelonLoader
            commands::melon_loader::get_melon_loader_status,
            commands::melon_loader::install_melon_loader,
            commands::melon_loader::uninstall_melon_loader,
            commands::melon_loader::get_available_melonloader_versions,
            // GitHub Releases
            commands::github_releases::get_latest_melon_loader_release,
            commands::github_releases::get_all_melon_loader_releases,
            commands::github_releases::get_latest_s1api_release,
            commands::github_releases::get_all_s1api_releases,
            commands::github_releases::get_latest_mlvscan_release,
            commands::github_releases::get_all_mlvscan_releases,
            // NexusMods
            commands::nexus_mods::validate_nexus_mods_api_key,
            commands::nexus_mods::get_nexus_mods_rate_limits,
            commands::nexus_mods::get_nexus_mods_games,
            commands::nexus_mods::search_nexus_mods_mods,
            commands::nexus_mods::get_nexus_mods_latest_added,
            commands::nexus_mods::get_nexus_mods_latest_updated,
            commands::nexus_mods::get_nexus_mods_trending,
            commands::nexus_mods::get_nexus_mods_mod,
            commands::nexus_mods::get_nexus_mods_mod_files,
            commands::nexus_mods::download_nexus_mods_mod_file,
            commands::nexus_mods::install_nexus_mods_mod,
            commands::nexus_mods::check_nexus_mods_mod_update,
            commands::nexus_mods::check_nexus_mods_for_updates,
            // Thunderstore
            commands::thunderstore::search_thunderstore_packages,
            commands::thunderstore::get_thunderstore_package,
            commands::thunderstore::download_thunderstore_package,
            // Mod Updates
            commands::mod_update::check_mod_updates,
            commands::mod_update::update_mod,
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
            // Config
            commands::config::get_config_files,
            commands::config::get_grouped_config,
            commands::config::update_config,
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
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("Failed to run Tauri application: {}", e);
            std::process::exit(1);
        });
}
