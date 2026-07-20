mod models;
mod omp_bridge;
mod sessions;
mod settings;
mod terminal;

use models::{
    AppSettings, BootstrapPayload, CodexSessionSummary, OmpConfigSaveRequest, OmpConfigSnapshot,
    OmpUpdateInfo, SettingsUpdate,
};
use sessions::{build_bootstrap, path_key};
use settings::{load_settings, normalize_optional, save_settings, SettingsState};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use terminal::TerminalState;

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
        omp_bridge::check_update(&app, &settings)
    })
    .await
    .map_err(|error| format!("Не удалось дождаться проверки обновлений OMP: {error}"))?
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
            import_session,
            list_codex_sessions,
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
