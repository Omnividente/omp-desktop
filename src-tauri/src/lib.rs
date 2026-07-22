mod models;
mod omp_bridge;
mod sessions;
mod settings;
mod terminal;

use models::{
    AppSettings, BootstrapPayload, CodexSessionSummary, OmpConfigSaveRequest, OmpConfigSnapshot,
    OmpUpdateInfo, SessionTranscript, SettingsUpdate,
};
use sessions::{build_bootstrap, path_key};
use settings::{load_settings, normalize_optional, save_settings, SettingsState};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use terminal::TerminalState;
use semver::Version;

#[tauri::command]
fn bootstrap(
    app: AppHandle,
    settings: State<'_, SettingsState>,
) -> Result<BootstrapPayload, String> {
    let settings = settings_snapshot(&settings)?;
    build_bootstrap(&app, &settings)
}

#[tauri::command]
fn add_workspace(
    path: String,
    app: AppHandle,
    settings: State<'_, SettingsState>,
) -> Result<BootstrapPayload, String> {
    let workspace = PathBuf::from(path.trim());
    if !workspace.is_dir() {
        return Err(format!("Папка проекта не найдена: {}", workspace.display()));
    }
    let workspace = workspace.to_string_lossy().into_owned();
    let workspace_key = path_key(&workspace);
    let snapshot = {
        let mut settings = settings
            .0
            .lock()
            .map_err(|_| "Настройки заблокированы после внутренней ошибки".to_owned())?;
        settings
            .recent_workspaces
            .retain(|existing| path_key(existing) != workspace_key);
        settings.recent_workspaces.insert(0, workspace);
        settings.recent_workspaces.truncate(24);
        settings.clone()
    };
    save_settings(&app, &snapshot)?;
    build_bootstrap(&app, &snapshot)
}

#[tauri::command]
fn update_settings(
    update: SettingsUpdate,
    app: AppHandle,
    settings: State<'_, SettingsState>,
) -> Result<BootstrapPayload, String> {
    let snapshot = {
        let mut settings = settings
            .0
            .lock()
            .map_err(|_| "Настройки заблокированы после внутренней ошибки".to_owned())?;
        settings.omp_executable = normalize_optional(update.omp_executable);
        settings.session_root = normalize_optional(update.session_root);
        if let Some(language) = normalize_optional(update.language) {
            settings.language = language;
        }
        if let Some(provider_env) = update.provider_env {
            settings.provider_env = provider_env
                .into_iter()
                .filter(|(key, value)| !key.trim().is_empty() && !value.trim().is_empty())
                .map(|(key, value)| (key.trim().to_owned(), value))
                .collect();
        }
        settings.clone()
    };
    save_settings(&app, &snapshot)?;
    build_bootstrap(&app, &snapshot)
}

#[tauri::command]
fn rename_session(
    path: String,
    title: String,
    app: AppHandle,
    settings: State<'_, SettingsState>,
) -> Result<BootstrapPayload, String> {
    sessions::rename_session(&path, &title)?;
    let snapshot = settings_snapshot(&settings)?;
    build_bootstrap(&app, &snapshot)
}

#[tauri::command]
fn delete_session(
    path: String,
    app: AppHandle,
    settings: State<'_, SettingsState>,
) -> Result<BootstrapPayload, String> {
    let snapshot = settings_snapshot(&settings)?;
    let root = settings::session_root(&app, &snapshot)?;
    sessions::delete_session(&path, &root)?;
    build_bootstrap(&app, &snapshot)
}

#[tauri::command]
fn import_session(
    path: String,
    target_cwd: String,
    app: AppHandle,
    settings: State<'_, SettingsState>,
) -> Result<BootstrapPayload, String> {
    let snapshot = settings_snapshot(&settings)?;
    let root = settings::session_root(&app, &snapshot)?;
    sessions::import_session(&path, &target_cwd, &root)?;
    build_bootstrap(&app, &snapshot)
}

#[tauri::command]
fn list_codex_sessions() -> Result<Vec<CodexSessionSummary>, String> {
    sessions::list_codex_sessions()
}

#[tauri::command]
async fn read_session_transcript(
    path: String,
    app: AppHandle,
    settings: State<'_, SettingsState>,
) -> Result<SessionTranscript, String> {
    let snapshot = settings_snapshot(&settings)?;
    let root = settings::session_root(&app, &snapshot)?;
    tauri::async_runtime::spawn_blocking(move || sessions::read_session_transcript(&path, &root))
        .await
        .map_err(|error| format!("Не удалось дождаться чтения транскрипта: {error}"))?
}

#[tauri::command]
async fn load_omp_config(
    app: AppHandle,
    settings: State<'_, SettingsState>,
) -> Result<OmpConfigSnapshot, String> {
    let snapshot = settings_snapshot(&settings)?;
    tauri::async_runtime::spawn_blocking(move || omp_bridge::load_config_snapshot(&app, &snapshot))
        .await
        .map_err(|error| format!("Не удалось дождаться загрузки настроек OMP: {error}"))?
}

#[tauri::command]
async fn save_omp_config(
    request: OmpConfigSaveRequest,
    app: AppHandle,
) -> Result<OmpConfigSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = app.state::<SettingsState>();
        omp_bridge::save_config(&app, &settings, request)
    })
    .await
    .map_err(|error| format!("Не удалось дождаться сохранения настроек OMP: {error}"))?
}

#[tauri::command]
async fn check_omp_update(app: AppHandle) -> Result<OmpUpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = app.state::<SettingsState>();
        let raw = omp_bridge::check_update(&app, &settings)?;
        let installed = settings_snapshot(&settings)
            .ok()
            .and_then(|settings| settings::resolve_omp(&app, &settings).version);
        Ok(normalize_update_info(raw, installed.as_deref()))
    })
    .await
    .map_err(|error| format!("Не удалось дождаться проверки обновлений OMP: {error}"))?
}
fn normalize_update_info(raw: OmpUpdateInfo, installed_version: Option<&str>) -> OmpUpdateInfo {
    let output = raw.message.trim();
    let lower = output.to_ascii_lowercase();
    let no_update = [
        "already up to date",
        "up-to-date",
        "no update available",
        "no updates available",
        "latest version is installed",
        "using the latest version",
    ]
    .iter()
    .any(|marker| lower.contains(marker));
    let advertised_update = ["new version", "update available", "upgrade available"]
        .iter()
        .any(|marker| lower.contains(marker));

    let current = raw
        .current_version
        .as_deref()
        .and_then(parse_version)
        .or_else(|| version_from_matching_line(output, &["current version", "installed version"]))
        .or_else(|| installed_version.and_then(parse_version));
    let explicit_latest = version_from_matching_line(
        output,
        &[
            "latest version",
            "new version",
            "update available",
            "upgrade available",
        ],
    );
    let latest = explicit_latest.or_else(|| {
        if no_update {
            current.clone()
        } else {
            None
        }
    });

    let has_update = match (&current, &latest) {
        (Some(current), Some(latest)) => latest > current,
        _ => advertised_update && !no_update,
    };
    let message = match (has_update, current.as_ref(), latest.as_ref()) {
        (true, Some(current), Some(latest)) => {
            format!("Доступна новая версия OMP {latest} (установлена {current}).")
        }
        (true, _, Some(latest)) => format!("Доступна новая версия OMP {latest}."),
        (true, _, None) => "Доступна новая версия OMP.".to_owned(),
        (false, Some(current), _) => format!("Установлена актуальная версия OMP {current}."),
        (false, None, _) => "Обновления OMP не найдены.".to_owned(),
    };

    OmpUpdateInfo {
        has_update,
        current_version: current.map(|version| version.to_string()),
        latest_version: latest.map(|version| version.to_string()),
        message,
    }
}

fn version_from_matching_line(output: &str, markers: &[&str]) -> Option<Version> {
    output.lines().find_map(|line| {
        let lower = line.to_ascii_lowercase();
        markers
            .iter()
            .any(|marker| lower.contains(marker))
            .then(|| parse_version(line))
            .flatten()
    })
}

fn parse_version(text: &str) -> Option<Version> {
    text.split(|character: char| {
        !character.is_ascii_alphanumeric() && !matches!(character, '.' | '-' | '+')
    })
    .filter_map(|token| {
        let token = token
            .strip_prefix('v')
            .or_else(|| token.strip_prefix('V'))
            .unwrap_or(token);
        Version::parse(token).ok()
    })
    .next()
}

fn settings_snapshot(settings: &SettingsState) -> Result<AppSettings, String> {
    settings
        .0
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "Настройки заблокированы после внутренней ошибки".to_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let settings = load_settings(app.handle()).unwrap_or_default();
            app.manage(SettingsState::new(settings));
            app.manage(TerminalState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            add_workspace,
            update_settings,
            rename_session,
            delete_session,
            import_session,
            list_codex_sessions,
            read_session_transcript,
            load_omp_config,
            save_omp_config,
            check_omp_update,
            terminal::start_terminal,
            terminal::switch_terminal,
            terminal::attach_terminal,
            terminal::write_terminal,
            terminal::write_terminal_binary,
            terminal::resize_terminal,
            terminal::close_terminal,
        ])
        .build(tauri::generate_context!())
        .expect("error while building OMP Desktop");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            app_handle.state::<TerminalState>().shutdown_all();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::normalize_update_info;
    use crate::models::OmpUpdateInfo;

    #[test]
    fn ordinary_no_update_output_is_not_a_false_positive() {
        let info = normalize_update_info(
            OmpUpdateInfo {
                has_update: true,
                current_version: None,
                latest_version: Some("17.0.7".to_owned()),
                message: "Current version: 17.0.7\n✔ Already up to date".to_owned(),
            },
            Some("omp/17.0.7"),
        );

        assert!(!info.has_update);
        assert_eq!(info.current_version.as_deref(), Some("17.0.7"));
        assert_eq!(info.latest_version.as_deref(), Some("17.0.7"));
        assert_eq!(
            info.message,
            "Установлена актуальная версия OMP 17.0.7."
        );
    }

    #[test]
    fn newer_semantic_version_is_reported_as_an_update() {
        let info = normalize_update_info(
            OmpUpdateInfo {
                has_update: false,
                current_version: None,
                latest_version: None,
                message: "Current version: 17.0.7\nNew version available: 17.1.0".to_owned(),
            },
            None,
        );

        assert!(info.has_update);
        assert_eq!(info.current_version.as_deref(), Some("17.0.7"));
        assert_eq!(info.latest_version.as_deref(), Some("17.1.0"));
        assert_eq!(
            info.message,
            "Доступна новая версия OMP 17.1.0 (установлена 17.0.7)."
        );
    }
}
