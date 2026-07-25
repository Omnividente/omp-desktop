mod models;
mod omp_bridge;
mod secrets;
mod sessions;
mod settings;
mod terminal;
mod update;

use models::{
    AppSettings, BootstrapPayload, CodexSessionSummary, OmpConfigSaveRequest, OmpConfigSnapshot,
    OmpUpdateInfo, SessionTranscript, SettingsPatch, SettingsUpdate,
};
use sessions::{build_bootstrap, path_key};
use settings::{
    load_settings, normalize_optional, save_settings, update_provider_secrets, SettingsState,
};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use terminal::TerminalState;

async fn run_blocking<T, F>(operation: &'static str, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("Не удалось дождаться {operation}: {error}"))?
}

#[tauri::command]
async fn bootstrap(app: AppHandle) -> Result<BootstrapPayload, String> {
    run_blocking("загрузки данных", move || {
        let settings = app.state::<SettingsState>();
        let snapshot = settings_snapshot(&settings)?;
        build_bootstrap(&app, &snapshot)
    })
    .await
}

#[tauri::command]
async fn add_workspace(path: String, app: AppHandle) -> Result<BootstrapPayload, String> {
    run_blocking("добавления проекта", move || {
        let workspace = PathBuf::from(path.trim());
        if !workspace.is_dir() {
            return Err(format!("Папка проекта не найдена: {}", workspace.display()));
        }
        let workspace = workspace.to_string_lossy().into_owned();
        let workspace_key = path_key(&workspace);
        let state = app.state::<SettingsState>();
        let snapshot = {
            let mut settings = state
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            settings
                .recent_workspaces
                .retain(|existing| path_key(existing) != workspace_key);
            settings.recent_workspaces.insert(0, workspace);
            settings.recent_workspaces.truncate(24);
            settings.clone()
        };
        save_settings(&app, &snapshot)?;
        build_bootstrap(&app, &snapshot)
    })
    .await
}

#[tauri::command]
async fn update_settings(
    update: SettingsUpdate,
    app: AppHandle,
) -> Result<BootstrapPayload, String> {
    run_blocking("сохранения настроек", move || {
        let state = app.state::<SettingsState>();
        let mut snapshot = settings_snapshot(&state)?;
        if let SettingsPatch::Set(value) = update.omp_executable {
            snapshot.omp_executable = normalize_optional(value);
        }
        if let SettingsPatch::Set(value) = update.session_root {
            snapshot.session_root = normalize_optional(value);
        }
        if let SettingsPatch::Set(Some(language)) = update.language {
            if let Some(language) = normalize_optional(Some(language)) {
                snapshot.language = language;
            }
        }
        if let SettingsPatch::Set(Some(provider_env)) = update.provider_env {
            update_provider_secrets(&app, &mut snapshot, provider_env)?;
        }
        save_settings(&app, &snapshot)?;
        *state
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = snapshot.clone();
        build_bootstrap(&app, &snapshot)
    })
    .await
}

#[tauri::command]
async fn rename_session(
    path: String,
    title: String,
    app: AppHandle,
) -> Result<BootstrapPayload, String> {
    run_blocking("переименования сессии", move || {
        sessions::rename_session(&path, &title)?;
        let settings = app.state::<SettingsState>();
        let snapshot = settings_snapshot(&settings)?;
        build_bootstrap(&app, &snapshot)
    })
    .await
}

#[tauri::command]
async fn delete_session(path: String, app: AppHandle) -> Result<BootstrapPayload, String> {
    run_blocking("удаления сессии", move || {
        let settings = app.state::<SettingsState>();
        let snapshot = settings_snapshot(&settings)?;
        let root = settings::session_root(&app, &snapshot)?;
        sessions::delete_session(&path, &root)?;
        build_bootstrap(&app, &snapshot)
    })
    .await
}

#[tauri::command]
async fn import_session(
    path: String,
    target_cwd: String,
    app: AppHandle,
) -> Result<BootstrapPayload, String> {
    run_blocking("импорта сессии", move || {
        let settings = app.state::<SettingsState>();
        let snapshot = settings_snapshot(&settings)?;
        let root = settings::session_root(&app, &snapshot)?;
        sessions::import_session(&path, &target_cwd, &root)?;
        build_bootstrap(&app, &snapshot)
    })
    .await
}

#[tauri::command]
async fn list_codex_sessions() -> Result<Vec<CodexSessionSummary>, String> {
    run_blocking("загрузки сессий Codex", sessions::list_codex_sessions).await
}

#[tauri::command]
async fn read_session_transcript(
    path: String,
    app: AppHandle,
) -> Result<SessionTranscript, String> {
    run_blocking("чтения транскрипта", move || {
        let settings = app.state::<SettingsState>();
        let snapshot = settings_snapshot(&settings)?;
        let root = settings::session_root(&app, &snapshot)?;
        sessions::read_session_transcript(&path, &root)
    })
    .await
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
    run_blocking("проверки обновлений OMP", move || {
        let settings = app.state::<SettingsState>();
        omp_bridge::check_update(&app, &settings)
    })
    .await
}

fn settings_snapshot(settings: &SettingsState) -> Result<AppSettings, String> {
    Ok(settings
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone())
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
