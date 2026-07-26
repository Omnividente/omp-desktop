use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

const MARKER_ENV: &str = "OMP_DESKTOP_UPDATER_E2E_MARKER";
const TARGET_ENV: &str = "OMP_DESKTOP_UPDATER_E2E_TARGET";
const MARKER_ARG: &str = "--updater-e2e-marker=";
const TARGET_ARG: &str = "--updater-e2e-target=";

fn process_value(env_name: &str, argument_prefix: &str) -> Option<String> {
    env::var(env_name)
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            env::args()
                .skip(1)
                .find_map(|argument| argument.strip_prefix(argument_prefix).map(str::to_owned))
                .filter(|value| !value.is_empty())
        })
}

pub fn start(app: AppHandle) {
    let Some(marker) = process_value(MARKER_ENV, MARKER_ARG) else {
        return;
    };
    let marker = PathBuf::from(marker);

    tauri::async_runtime::spawn(async move {
        let version = app.package_info().version.to_string();
        if let Err(error) = run(&app, &marker, &version).await {
            let _ = record(&marker, "error", &version, Some(&error));
            eprintln!("Updater E2E failed: {error}");
            app.exit(2);
        }
    });
}

async fn run(app: &AppHandle, marker: &Path, version: &str) -> Result<(), String> {
    record(marker, "started", version, None)?;
    let target = process_value(TARGET_ENV, TARGET_ARG)
        .ok_or_else(|| format!("{TARGET_ENV} or {TARGET_ARG}<version> is required"))?;

    if version == target {
        record(marker, "complete", version, None)?;
        app.exit(0);
        return Ok(());
    }

    let updater = app.updater().map_err(|error| error.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("No update from {version} to {target}"))?;
    record(marker, "update-found", version, Some(&update.version))?;
    if update.version != target {
        return Err(format!(
            "Expected update {target}, endpoint returned {}",
            update.version
        ));
    }

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    record(marker, "installed", version, Some(&target))?;
    app.restart()
}

fn record(marker: &Path, event: &str, version: &str, detail: Option<&str>) -> Result<(), String> {
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(marker)
        .map_err(|error| format!("Failed to open {}: {error}", marker.display()))?;
    serde_json::to_writer(
        &mut file,
        &serde_json::json!({
            "event": event,
            "version": version,
            "detail": detail,
        }),
    )
    .map_err(|error| format!("Failed to serialize updater marker: {error}"))?;
    file.write_all(b"\n")
        .and_then(|_| file.flush())
        .map_err(|error| format!("Failed to write {}: {error}", marker.display()))
}
