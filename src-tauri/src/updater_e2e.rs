use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Listener, Manager};
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
    if process_value("OMP_DESKTOP_UPDATER_E2E_MODE", "--updater-e2e-mode=").as_deref()
        == Some("channels")
    {
        return run_channels(app, marker, version).await;
    }
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

fn require(condition: bool, message: &str) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(message.to_owned())
    }
}

fn record_channel(
    marker: &Path,
    event: &str,
    version: &str,
    detail: serde_json::Value,
) -> Result<(), String> {
    // Broker events can arrive from another runtime thread. Keep each JSONL row indivisible.
    static WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = WRITE.lock().map_err(|error| error.to_string())?;
    let mut bytes = serde_json::to_vec(&serde_json::json!({
        "event": event, "version": version, "pid": std::process::id(), "detail": detail,
    }))
    .map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(marker)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.flush())
        .map_err(|error| error.to_string())
}

async fn save_channel(app: &AppHandle, marker: &Path, include: bool) -> Result<(), String> {
    let root = marker.parent().ok_or("Missing owned marker root")?;
    let sessions = root.join("synthetic-sessions");
    fs::create_dir_all(&sessions).map_err(|error| error.to_string())?;
    let request = serde_json::from_value(serde_json::json!({"update":{
        "desktopUpdatePrereleases":include,
        "ompExecutable":root.join("intentionally-nonexistent-omp"),
        "sessionRoot":sessions,
    },"ompConfig":null}))
    .map_err(|error| error.to_string())?;
    crate::save_settings_bundle(request, app.clone())
        .await
        .map(|_| ())
        .map_err(|error| {
            serde_json::to_string(&error)
                .unwrap_or_else(|_| "Native settings save failed".to_owned())
        })
}

async fn fixture_request(
    client: &reqwest::Client,
    endpoint: &str,
    value: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let source = env::var("OMP_DESKTOP_UPDATER_E2E_RELEASES_URL")
        .map_err(|_| "Missing guarded test fixture")?;
    let source = url::Url::parse(&source).map_err(|error| error.to_string())?;
    require(
        source.scheme() == "http"
            && source.host_str() == Some("127.0.0.1")
            && source.port().is_some()
            && source.path() == "/releases",
        "Invalid fixture origin",
    )?;
    let url = source.join(endpoint).map_err(|error| error.to_string())?;
    let response = if let Some(value) = value {
        client.post(url).json(&value).send().await
    } else {
        client.get(url).send().await
    }
    .map_err(|error| error.to_string())?;
    response
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())
}

async fn run_channels(app: &AppHandle, marker: &Path, version: &str) -> Result<(), String> {
    use crate::desktop_updater::{self, InstallState, PolicyState};
    require(
        app.config().identifier == "com.ompdesk.desktop.updater-e2e",
        "Channels harness requires the isolated E2E application identity",
    )?;
    require(
        desktop_updater::e2e_fixture_enabled()?,
        "Channels harness requires the guarded fixture",
    )?;
    let root = marker
        .parent()
        .ok_or("Missing owned marker root")?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let config = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    require(
        config.starts_with(&root) && config != root,
        "App config must resolve below the owned marker root",
    )?;
    let event_marker = marker.to_owned();
    let event_version = version.to_owned();
    let event_app = app.clone();
    app.listen("desktop-update-state", move |event| {
        let result = serde_json::from_str(event.payload())
            .map_err(|error| error.to_string())
            .and_then(|payload| {
                record_channel(&event_marker, "native-state", &event_version, payload)
            });
        if let Err(error) = result {
            let _ = record(&event_marker, "error", &event_version, Some(&error));
            event_app.exit(2);
        }
    });
    let source = option_env!("OMP_DESKTOP_UPDATER_E2E_SOURCE_SHA")
        .ok_or("Channels test bundle has no embedded source SHA")?;
    require(
        source.len() == 40 && source.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Invalid embedded test source SHA",
    )?;
    record_channel(
        marker,
        "channels-started",
        version,
        serde_json::json!({"source":source,"configDir":config}),
    )?;
    let target = process_value(TARGET_ENV, TARGET_ARG).ok_or("Missing test target")?;
    let client = desktop_updater::metadata_client()?;
    if version == target {
        let status = crate::settings::reconcile_desktop_update_policy(app)?;
        require(
            status.policy_state == PolicyState::Ready && status.include_prereleases == Some(false),
            "Persisted stable-only channel did not survive actual restart",
        )?;
        let status = desktop_updater::check(app).await?;
        require(
            status.update.is_none(),
            "Equal-version target was offered after restart",
        )?;
        record_channel(
            marker,
            "channels-complete",
            version,
            serde_json::to_value(status).map_err(|error| error.to_string())?,
        )?;
        app.exit(0);
        return Ok(());
    }
    let initial =
        crate::settings::settings_snapshot(app, &app.state::<crate::settings::SettingsState>())?;
    require(
        !initial.desktop_update_prereleases,
        "Fresh settings must default to stable-only without saving the channel",
    )?;
    fixture_request(
        &client,
        "/control",
        Some(serde_json::json!({"case":"preview"})),
    )
    .await?;
    let stable = desktop_updater::check(app).await?;
    require(
        stable.policy_state == PolicyState::Ready
            && stable.include_prereleases == Some(false)
            && stable.update.is_none(),
        "Default stable-only policy offered a prerelease",
    )?;
    record_channel(
        marker,
        "stable-default",
        version,
        serde_json::to_value(stable).map_err(|error| error.to_string())?,
    )?;
    save_channel(app, marker, true).await?;
    let preview = desktop_updater::check(app).await?;
    let preview = preview
        .update
        .ok_or("Opt-in did not discover the preview")?;
    require(
        preview.version == target && preview.prerelease,
        "Preview metadata classification mismatch",
    )?;
    record_channel(
        marker,
        "preview-opt-in",
        version,
        serde_json::to_value(&preview).map_err(|error| error.to_string())?,
    )?;
    fixture_request(
        &client,
        "/control",
        Some(serde_json::json!({"holdNext":true})),
    )
    .await?;
    let cloned = app.clone();
    let late = tauri::async_runtime::spawn(async move { desktop_updater::check(&cloned).await });
    let held = fixture_request(&client, "/probe?awaitHold=1", None).await?;
    require(
        held["holdPending"].as_bool() == Some(true),
        "Native check HTTP response was not actually held",
    )?;
    record_channel(marker, "held-check-observed", version, held)?;
    save_channel(app, marker, false).await?;
    let retired = desktop_updater::status(app);
    require(
        retired.update.is_none() && retired.include_prereleases == Some(false),
        "Channel change retained an old offer",
    )?;
    require(
        desktop_updater::install(app, &preview.candidate_id)
            .await
            .is_err(),
        "Retired candidate still installable",
    )?;
    record_channel(
        marker,
        "retired-candidate-refused",
        version,
        serde_json::to_value(&retired).map_err(|error| error.to_string())?,
    )?;
    fixture_request(
        &client,
        "/control",
        Some(serde_json::json!({"releaseHold":true})),
    )
    .await?;
    let late = late.await.map_err(|error| error.to_string())??;
    require(
        late.update.is_none() && late.include_prereleases == Some(false),
        "Late check republished the retired channel",
    )?;
    record_channel(
        marker,
        "channel-late-result-discarded",
        version,
        serde_json::to_value(late).map_err(|error| error.to_string())?,
    )?;
    crate::settings::e2e_fail_next_channel_save(app)?;
    let save_error = save_channel(app, marker, true)
        .await
        .err()
        .ok_or("Injected post-write/rollback fault did not fail")?;
    let unknown = desktop_updater::status(app);
    require(
        unknown.policy_state == PolicyState::Uncertain
            && unknown.include_prereleases.is_none()
            && unknown.update.is_none(),
        "Unknown save was published as a known policy",
    )?;
    require(
        desktop_updater::check(app).await.is_err(),
        "Unknown policy permitted discovery",
    )?;
    require(
        desktop_updater::install(app, &preview.candidate_id)
            .await
            .is_err(),
        "Unknown policy permitted installation",
    )?;
    let settings_path = config.join("settings.json");
    let persisted = fs::read(&settings_path).map_err(|error| error.to_string())?;
    let reconciled = crate::settings::reconcile_desktop_update_policy(app)?;
    require(
        reconciled.policy_state == PolicyState::Ready
            && reconciled.include_prereleases == Some(true),
        "Read-only reconciliation did not discover the committed opt-in",
    )?;
    require(
        fs::read(&settings_path).map_err(|error| error.to_string())? == persisted,
        "Reconciliation rewrote settings instead of reading them",
    )?;
    record_channel(
        marker,
        "unknown-save-reconciled",
        version,
        serde_json::json!({"saveError":save_error,"unknown":unknown,"reconciled":reconciled,"settingsBytesUnchanged":true}),
    )?;
    for case in [
        "unsigned",
        "wrong-key",
        "wrong-platform",
        "incomplete",
        "old",
    ] {
        fixture_request(&client, "/control", Some(serde_json::json!({"case":case}))).await?;
        let rejected = desktop_updater::check(app).await?;
        require(
            rejected.update.is_none(),
            "Unsafe/incompatible release was offered",
        )?;
        let counts = fixture_request(&client, "/probe", None).await?;
        require(
            counts["assetRequests"].as_u64() == Some(0),
            "Rejected release downloaded a binary",
        )?;
        record_channel(
            marker,
            "invalid-release-rejected",
            version,
            serde_json::json!({"case":case,"status":rejected,"fixture":counts}),
        )?;
    }
    let counts = fixture_request(&client, "/probe", None).await?;
    require(
        counts["assetRequests"].as_u64() == Some(0),
        "Discovery or setting change downloaded an installer",
    )?;
    record_channel(marker, "invalid-releases-rejected", version, counts)?;
    save_channel(app, marker, false).await?;
    fixture_request(
        &client,
        "/control",
        Some(serde_json::json!({"case":"stable"})),
    )
    .await?;
    let stable = desktop_updater::check(app)
        .await?
        .update
        .ok_or("Stable update missing")?;
    record_channel(
        marker,
        "stable-flag-offer",
        version,
        serde_json::to_value(&stable).map_err(|error| error.to_string())?,
    )?;
    require(
        stable.version == target && !stable.prerelease,
        "Stable flag was not used as channel authority",
    )?;
    for event in ["download-failure-safe", "signature-failure-safe"] {
        let error = desktop_updater::install(app, &stable.candidate_id)
            .await
            .err()
            .ok_or("Invalid download unexpectedly installed")?;
        let status = desktop_updater::status(app);
        require(
            status.install_state == InstallState::Idle && status.installed.is_none(),
            "Pre-install failure became an installation or unknown side effect",
        )?;
        record_channel(
            marker,
            event,
            version,
            serde_json::json!({"status":status,"error":error,"fixture":fixture_request(&client, "/probe", None).await?}),
        )?;
    }
    record_channel(
        marker,
        "install-requested",
        version,
        serde_json::json!({"target":target}),
    )?;
    let installed = desktop_updater::install(app, &stable.candidate_id).await?;
    require(
        installed.install_state == InstallState::Installed,
        "Native install not confirmed",
    )?;
    let reused = desktop_updater::install(app, &stable.candidate_id).await?;
    require(
        reused.install_state == InstallState::Installed,
        "Confirmed install was repeated instead of reused",
    )?;
    record_channel(
        marker,
        "installed-reused",
        version,
        serde_json::to_value(reused).map_err(|error| error.to_string())?,
    )?;
    app.restart()
}
