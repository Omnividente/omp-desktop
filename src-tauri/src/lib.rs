mod diagnostics;
mod models;
mod omp_bridge;
mod omp_command;
mod resource_health;
mod secrets;
mod sessions;
mod settings;
mod terminal;
mod update;
#[cfg(feature = "updater-e2e")]
mod updater_e2e;
use models::{
    AppError, AppSettings, BootstrapPayload, CodexSessionSummary, ImportBatchPayload,
    ImportSessionRequest, OmpConfigSnapshot, OmpUpdateInfo, ResourceHealthSnapshot,
    SessionTranscript, SettingsPatch, SettingsSavePayload, SettingsSaveRequest, SettingsUpdate,
};
use sessions::{build_bootstrap, path_key};
use settings::{
    initialize_settings, normalize_app_font_family, normalize_optional,
    normalize_terminal_font_family, normalize_terminal_font_size, save_settings,
    update_provider_secrets, SettingsState,
};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use terminal::TerminalState;

async fn run_blocking<T, F>(
    operation: &'static str,
    error_code: &'static str,
    error_message: &'static str,
    task: F,
) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(task).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => {
            diagnostics::warn(operation, &error);
            Err(AppError::from_internal(error_code, error_message, error))
        }
        Err(error) => {
            diagnostics::warn(operation, &error.to_string());
            Err(AppError::join(operation, error))
        }
    }
}

#[tauri::command]
async fn bootstrap(app: AppHandle) -> Result<BootstrapPayload, AppError> {
    run_blocking(
        "загрузки данных",
        "bootstrap_failed",
        "Не удалось загрузить данные OMP",
        move || {
            let settings = app.state::<SettingsState>();
            initialize_settings(&app, &settings)?;
            let snapshot = settings_snapshot(&settings)?;
            build_bootstrap(&app, &snapshot)
        },
    )
    .await
}

#[tauri::command]
async fn add_workspace(path: String, app: AppHandle) -> Result<BootstrapPayload, AppError> {
    run_blocking(
        "добавления проекта",
        "workspace_add_failed",
        "Не удалось добавить проект",
        move || {
            let workspace = PathBuf::from(path.trim());
            if !workspace.is_dir() {
                return Err(format!("Папка проекта не найдена: {}", workspace.display()));
            }
            let workspace = workspace.to_string_lossy().into_owned();
            let workspace_key = path_key(&workspace);
            let state = app.state::<SettingsState>();
            let mut snapshot = settings_snapshot(&state)?;
            snapshot
                .recent_workspaces
                .retain(|existing| path_key(existing) != workspace_key);
            snapshot
                .hidden_workspaces
                .retain(|hidden| path_key(hidden) != workspace_key);
            snapshot.recent_workspaces.insert(0, workspace);
            snapshot.recent_workspaces.truncate(24);
            commit_workspace_settings(&app, &state, snapshot)
        },
    )
    .await
}

fn commit_workspace_settings(
    app: &AppHandle,
    state: &SettingsState,
    snapshot: AppSettings,
) -> Result<BootstrapPayload, String> {
    save_settings(app, &snapshot)?;
    *state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = snapshot.clone();
    build_bootstrap(app, &snapshot)
}

fn normalize_workspace_name(name: &str) -> Result<String, String> {
    let cleaned = name
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>()
        .trim()
        .to_owned();
    if cleaned.is_empty() {
        return Err("Название проекта не может быть пустым".to_owned());
    }
    if cleaned.chars().count() > 120 {
        return Err("Название проекта не может быть длиннее 120 символов".to_owned());
    }
    Ok(cleaned)
}

#[tauri::command]
async fn rename_workspace(
    path: String,
    name: String,
    app: AppHandle,
) -> Result<BootstrapPayload, AppError> {
    run_blocking(
        "переименования проекта",
        "workspace_rename_failed",
        "Не удалось переименовать проект",
        move || {
            let key = path_key(path.trim());
            let name = normalize_workspace_name(&name)?;
            let state = app.state::<SettingsState>();
            let mut snapshot = settings_snapshot(&state)?;
            snapshot.workspace_names.insert(key, name);
            commit_workspace_settings(&app, &state, snapshot)
        },
    )
    .await
}

#[tauri::command]
async fn remove_workspace(path: String, app: AppHandle) -> Result<BootstrapPayload, AppError> {
    run_blocking(
        "удаления проекта из списка",
        "workspace_remove_failed",
        "Не удалось удалить проект из списка",
        move || {
            let key = path_key(path.trim());
            let state = app.state::<SettingsState>();
            let mut snapshot = settings_snapshot(&state)?;
            snapshot
                .recent_workspaces
                .retain(|existing| path_key(existing) != key);
            snapshot.workspace_names.remove(&key);
            snapshot
                .hidden_workspaces
                .retain(|hidden| path_key(hidden) != key);
            snapshot.hidden_workspaces.push(key);
            commit_workspace_settings(&app, &state, snapshot)
        },
    )
    .await
}

fn apply_settings_update(snapshot: &mut AppSettings, update: &SettingsUpdate) {
    if let SettingsPatch::Set(value) = &update.omp_executable {
        snapshot.omp_executable = normalize_optional(value.clone());
    }
    if let SettingsPatch::Set(value) = &update.session_root {
        snapshot.session_root = normalize_optional(value.clone());
    }
    if let SettingsPatch::Set(Some(language)) = &update.language {
        if let Some(language) = normalize_optional(Some(language.clone())) {
            snapshot.language = language;
        }
    }
    if let SettingsPatch::Set(value) = &update.app_font_family {
        snapshot.app_font_family = normalize_app_font_family(value.clone());
    }
    if let SettingsPatch::Set(value) = &update.terminal_font_family {
        snapshot.terminal_font_family = normalize_terminal_font_family(value.clone());
    }
    if let SettingsPatch::Set(value) = &update.terminal_font_size {
        snapshot.terminal_font_size = normalize_terminal_font_size(*value);
    }
    if let SettingsPatch::Set(Some(rail_mode)) = update.rail_mode {
        snapshot.rail_mode = rail_mode;
    }
}

#[tauri::command]
async fn save_settings_bundle(
    request: SettingsSaveRequest,
    app: AppHandle,
) -> Result<SettingsSavePayload, AppError> {
    run_blocking(
        "сохранения настроек",
        "settings_save_failed",
        "Не удалось сохранить настройки",
        move || {
            let state = app.state::<SettingsState>();
            let previous = settings_snapshot(&state)?;
            let mut next = previous.clone();
            apply_settings_update(&mut next, &request.update);
            let provider_env = match &request.update.provider_env {
                SettingsPatch::Set(Some(values)) => Some(values.clone()),
                SettingsPatch::Missing | SettingsPatch::Set(None) => None,
            };

            let omp_config = if let Some(mut config) = request.omp_config {
                if config.provider_env.is_none() {
                    config.provider_env = provider_env;
                }
                Some(omp_bridge::save_config(&app, &state, next, config)?)
            } else {
                let credentials_changed = if let Some(values) = provider_env {
                    update_provider_secrets(&app, &mut next, values)?;
                    true
                } else {
                    false
                };
                settings::resolve_transaction(save_settings(&app, &next), || {
                    let mut rollback_errors = Vec::new();
                    if credentials_changed {
                        if let Err(rollback_error) =
                            settings::restore_provider_secrets(&app, &next, &previous)
                        {
                            rollback_errors.push(rollback_error);
                        }
                    }
                    if let Err(rollback_error) = save_settings(&app, &previous) {
                        rollback_errors.push(rollback_error);
                    }
                    rollback_errors
                })?;
                *state
                    .0
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = next;
                None
            };
            let committed = settings_snapshot(&state)?;
            let bootstrap = build_bootstrap(&app, &committed)?;
            Ok(SettingsSavePayload {
                bootstrap,
                omp_config,
            })
        },
    )
    .await
}

#[tauri::command]
async fn sample_resource_health(
    workspace_path: Option<String>,
    app: AppHandle,
) -> Result<ResourceHealthSnapshot, AppError> {
    run_blocking(
        "проверки системных ресурсов",
        "resource_health_failed",
        "Не удалось проверить системные ресурсы",
        move || {
            let settings = app.state::<SettingsState>();
            initialize_settings(&app, &settings)?;
            let snapshot = settings_snapshot(&settings)?;
            let session_root = settings::session_root(&app, &snapshot)?;
            let terminal_processes = app.state::<TerminalState>().resource_processes();
            resource_health::sample_resource_health(
                resource_health::default_resource_paths(&session_root, workspace_path.as_deref()),
                terminal_processes,
            )
        },
    )
    .await
}

#[tauri::command]
async fn set_session_title_pin(
    path: String,
    title: Option<String>,
    app: AppHandle,
) -> Result<BootstrapPayload, AppError> {
    run_blocking(
        "фиксации названия сессии",
        "session_title_pin_failed",
        "Не удалось зафиксировать название сессии",
        move || {
            if !PathBuf::from(&path).is_file() {
                return Err(format!("Файл сессии не найден: {path}"));
            }
            let state = app.state::<SettingsState>();
            let mut snapshot = settings_snapshot(&state)?;
            let key = path_key(&path);
            if let Some(title) = title {
                snapshot
                    .session_title_pins
                    .insert(key, sessions::normalize_pinned_title(&title)?);
            } else {
                snapshot.session_title_pins.remove(&key);
            }
            save_settings(&app, &snapshot)?;
            *state
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = snapshot.clone();
            build_bootstrap(&app, &snapshot)
        },
    )
    .await
}

#[tauri::command]
async fn delete_session(path: String, app: AppHandle) -> Result<BootstrapPayload, AppError> {
    run_blocking(
        "удаления сессии",
        "session_delete_failed",
        "Не удалось удалить сессию",
        move || {
            let settings = app.state::<SettingsState>();
            let mut snapshot = settings_snapshot(&settings)?;
            let root = settings::session_root(&app, &snapshot)?;
            sessions::delete_session(&path, &root)?;
            let session_key = path_key(&path);
            let title_pin_removed = snapshot.session_title_pins.remove(&session_key).is_some();
            let provider_pin_removed = snapshot.primary_provider_pins.remove(&session_key);
            if title_pin_removed || provider_pin_removed {
                save_settings(&app, &snapshot)?;
                *settings
                    .0
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = snapshot.clone();
            }
            build_bootstrap(&app, &snapshot)
        },
    )
    .await
}

#[tauri::command]
async fn import_sessions(
    requests: Vec<ImportSessionRequest>,
    app: AppHandle,
) -> Result<ImportBatchPayload, AppError> {
    run_blocking(
        "импорта сессий",
        "session_import_failed",
        "Не удалось импортировать сессии",
        move || {
            let settings = app.state::<SettingsState>();
            let snapshot = settings_snapshot(&settings)?;
            let root = settings::session_root(&app, &snapshot)?;
            let items = sessions::import_sessions(&requests, &root);
            let bootstrap = build_bootstrap(&app, &snapshot)?;
            Ok(ImportBatchPayload { bootstrap, items })
        },
    )
    .await
}

#[tauri::command]
async fn list_codex_sessions() -> Result<Vec<CodexSessionSummary>, AppError> {
    run_blocking(
        "загрузки сессий Codex",
        "codex_sessions_load_failed",
        "Не удалось загрузить сессии Codex",
        sessions::list_codex_sessions,
    )
    .await
}

#[tauri::command]
async fn read_session_transcript(
    path: String,
    app: AppHandle,
) -> Result<SessionTranscript, AppError> {
    run_blocking(
        "чтения транскрипта",
        "transcript_read_failed",
        "Не удалось прочитать транскрипт",
        move || {
            let settings = app.state::<SettingsState>();
            let snapshot = settings_snapshot(&settings)?;
            let root = settings::session_root(&app, &snapshot)?;
            let mut transcript = sessions::read_session_transcript(&path, &root)?;
            sessions::apply_session_title_pin(
                &mut transcript.session,
                &snapshot.session_title_pins,
            );
            sessions::apply_session_primary_provider_pin(
                &mut transcript.session,
                &snapshot.primary_provider_pins,
            );
            Ok(transcript)
        },
    )
    .await
}

#[tauri::command]
async fn load_omp_config(
    app: AppHandle,
    settings: State<'_, SettingsState>,
) -> Result<OmpConfigSnapshot, AppError> {
    let snapshot = settings_snapshot(&settings).map_err(|error| {
        AppError::from_internal(
            "omp_config_load_failed",
            "Не удалось загрузить настройки OMP",
            error,
        )
    })?;
    run_blocking(
        "загрузки настроек OMP",
        "omp_config_load_failed",
        "Не удалось загрузить настройки OMP",
        move || omp_bridge::load_config_snapshot(&app, &snapshot),
    )
    .await
}

#[tauri::command]
async fn check_omp_update(app: AppHandle) -> Result<OmpUpdateInfo, AppError> {
    run_blocking(
        "проверки обновлений OMP",
        "omp_update_check_failed",
        "Не удалось проверить обновление OMP",
        move || {
            let settings = app.state::<SettingsState>();
            omp_bridge::check_update(&app, &settings)
        },
    )
    .await
}

fn settings_snapshot(settings: &SettingsState) -> Result<AppSettings, String> {
    Ok(settings
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone())
}

#[cfg(target_os = "linux")]
fn configure_linux_ca_bundle() {
    if std::env::var_os("SSL_CERT_FILE")
        .filter(|value| !value.is_empty())
        .is_some()
    {
        return;
    }

    // rustls-native-certs does not discover ALT's /etc/pki bundle. Set the
    // standard override before the updater creates its first HTTP client.
    for candidate in [
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/pki/tls/certs/ca-bundle.crt",
        "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
        "/etc/ssl/cert.pem",
    ] {
        if std::path::Path::new(candidate).is_file() {
            std::env::set_var("SSL_CERT_FILE", candidate);
            break;
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_ca_bundle() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_linux_ca_bundle();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            match diagnostics::init(app.handle()) {
                Ok(log_guard) => {
                    app.manage(log_guard);
                }
                Err(error) => eprintln!("OMP Desktop logging unavailable: {error}"),
            }
            app.manage(SettingsState::new_uninitialized());
            app.manage(TerminalState::default());
            #[cfg(feature = "updater-e2e")]
            updater_e2e::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            add_workspace,
            rename_workspace,
            remove_workspace,
            save_settings_bundle,
            set_session_title_pin,
            delete_session,
            import_sessions,
            list_codex_sessions,
            read_session_transcript,
            load_omp_config,
            check_omp_update,
            sample_resource_health,
            terminal::start_terminal,
            terminal::switch_terminal,
            terminal::set_terminal_primary_provider_pin,
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
