use std::env;
use std::path::Path;
use std::process::Command;

fn main() {
    // Build the frontend before building Tauri
    // This ensures the frontend is always built when building with cargo
    let root_dir = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();

    // Check if dist directory exists and is recent (optional optimization)
    let dist_dir = root_dir.join("dist");
    let should_build = if dist_dir.exists() {
        // Check if package.json is newer than dist (simple check)
        let package_json = root_dir.join("package.json");
        if package_json.exists() {
            // For now, always rebuild to ensure consistency
            // Could add timestamp checking here if needed
            true
        } else {
            true
        }
    } else {
        true
    };

    if should_build {
        let package_manager =
            env::var("SIMM_FRONTEND_PACKAGE_MANAGER").unwrap_or_else(|_| "bun".to_string());
        let frontend_build_result = Command::new(&package_manager)
            .args(["run", "build"])
            .current_dir(root_dir)
            .status();

        match frontend_build_result {
            Ok(status) if status.success() => {}
            Ok(status) => {
                panic!(
                    "frontend build failed with exit code {:?}. Run '{} run build' from the repo root for details.",
                    status.code(),
                    package_manager
                );
            }
            Err(e) => {
                panic!(
                    "failed to run frontend build command '{} run build': {}",
                    package_manager, e
                );
            }
        }
    }

    // Keep both dev and release app launches unelevated. The installer can still
    // request elevation for machine-wide install or prerequisites when needed.
    let app_manifest = if cfg!(debug_assertions) {
        include_str!("windows/app.dev.manifest")
    } else {
        include_str!("windows/app.manifest")
    };

    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new().app_manifest(app_manifest));

    tauri_build::try_build(attributes).expect("failed to run tauri build script");
}
