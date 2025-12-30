use std::process::Command;
use std::path::Path;

fn main() {
    // Build the frontend before building Tauri
    // This ensures the frontend is always built when building with cargo
    println!("cargo:warning=Building frontend...");
    
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
        let npm_build_result = if cfg!(target_os = "windows") {
            Command::new("cmd")
                .args(["/C", "npm run build"])
                .current_dir(root_dir)
                .status()
        } else {
            Command::new("sh")
                .args(["-c", "npm run build"])
                .current_dir(root_dir)
                .status()
        };

        match npm_build_result {
            Ok(status) if status.success() => {
                println!("cargo:warning=Frontend build completed successfully");
            }
            Ok(status) => {
                eprintln!("cargo:warning=Frontend build failed with exit code: {:?}", status.code());
                eprintln!("cargo:warning=Continuing with Rust build anyway. Make sure to run 'npm run build' manually if needed.");
            }
            Err(e) => {
                eprintln!("cargo:warning=Failed to run npm build: {}. Continuing anyway...", e);
                eprintln!("cargo:warning=Make sure npm is installed and 'npm run build' works manually.");
            }
        }
    }

    tauri_build::build()
}

