mod models;
mod sessions;
mod settings;
mod terminal;

use models::{AppSettings, BootstrapPayload, SettingsUpdate};
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
        settings.clone()
    };
    save_settings(&app, &snapshot)?;
    build_bootstrap(&app, &snapshot)
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
            terminal::start_terminal,
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
