#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod commands;
mod services;
mod types;
mod utils;
mod events;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            eprintln!("Tauri app starting...");
            
            // Ensure window stays open even if frontend has errors
            if let Some(window) = app.get_webview_window("main") {
                eprintln!("Window 'main' found");
                #[cfg(debug_assertions)]
                {
                    window.open_devtools();
                }
            } else {
                eprintln!("WARNING: Window 'main' not found!");
            }
            
            eprintln!("Tauri setup complete");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            commands::mods::delete_mod,
            commands::mods::enable_mod,
            commands::mods::disable_mod,
            commands::mods::open_mods_folder,
            commands::mods::get_s1api_installation_status,
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
            // Thunderstore
            commands::thunderstore::search_thunderstore_packages,
            commands::thunderstore::get_thunderstore_package,
            commands::thunderstore::download_thunderstore_package,
            // Mod Updates
            commands::mod_update::check_mod_updates,
            commands::mod_update::update_mod,
            // Logs
            commands::logs::get_log_files,
            commands::logs::read_log_file,
            commands::logs::export_logs,
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

