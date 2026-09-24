// AppError intentionally carries bounded recovery metadata in the serialized IPC contract.
#![allow(clippy::result_large_err)]

mod content_links;
mod diagnostics;
mod models;
mod omp_bridge;
mod omp_command;
mod operational_config;
mod provider_config;
mod resource_health;
mod secrets;
mod session_lease;
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
    normalize_app_font_family, normalize_app_font_size, normalize_optional,
    normalize_terminal_font_family, normalize_terminal_font_size, save_settings, settings_snapshot,
    start_with_defaults_prepared, update_provider_secrets, with_settings_transaction,
    SettingsState, SettingsTransaction,
};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use terminal::TerminalState;

const SINGLE_INSTANCE_EVENT: &str = "single-instance";

struct StartupWorkspace(Mutex<Option<String>>);

fn startup_workspace(args: &[String]) -> Option<String> {
    for (index, arg) in args.iter().enumerate().skip(1) {
        let arg = arg.trim();
        if matches!(arg, "--project" | "-p" | "--workspace" | "-w") {
            if let Some(value) = args.get(index + 1).map(|value| value.trim()) {
                if !value.is_empty() && !value.starts_with('-') {
                    return Some(value.to_owned());
                }
            }
        } else if let Some((flag, value)) = arg.split_once('=') {
            if matches!(flag, "--project" | "-p" | "--workspace" | "-w") && !value.trim().is_empty()
            {
                return Some(value.trim().to_owned());
            }
        }
    }
    for (index, arg) in args.iter().enumerate().skip(1) {
        let arg = arg.trim();
        if arg == "--" {
            return args
                .get(index + 1)
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty());
        }
        if arg.is_empty()
            || arg.starts_with('-')
            || matches!(arg.to_ascii_lowercase().as_str(), "run" | "dev" | "open")
        {
            continue;
        }
        return Some(arg.to_owned());
    }
    None
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SingleInstanceEvent {
    args: Vec<String>,
}

fn dispatch_second_instance<F, E>(args: Vec<String>, focus: F, emit: E)
where
    F: FnOnce(),
    E: FnOnce(SingleInstanceEvent),
{
    let event = SingleInstanceEvent { args };
    focus();
    emit(event);
}

fn focus_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        diagnostics::warn(
            "single_instance.focus",
            "main webview window is unavailable",
        );
        return;
    };
    if let Err(error) = window.show() {
        diagnostics::warn("single_instance.show", &error.to_string());
    }
    if let Err(error) = window.unminimize() {
        diagnostics::warn("single_instance.unminimize", &error.to_string());
    }
    if let Err(error) = window.set_focus() {
        diagnostics::warn("single_instance.focus", &error.to_string());
    }
}

fn handle_second_instance(app: &AppHandle, args: Vec<String>, _cwd: String) {
    dispatch_second_instance(
        args,
        || focus_main_window(app),
        |event| {
            if let Err(error) = app.emit(SINGLE_INSTANCE_EVENT, event) {
                diagnostics::warn("single_instance.emit", &error.to_string());
            }
        },
    );
}

#[cfg(test)]
mod single_instance_tests {
    use super::{dispatch_second_instance, startup_workspace, SingleInstanceEvent};
    use std::cell::RefCell;

    #[test]
    fn explicit_startup_project_takes_precedence_over_positional_arguments() {
        let args = [
            "omp-desktop",
            "open",
            "older-project",
            "--project",
            "chosen-project",
        ]
        .map(str::to_owned);
        assert_eq!(startup_workspace(&args).as_deref(), Some("chosen-project"));
    }

    #[test]
    fn startup_project_does_not_consume_another_flag_as_its_path() {
        let args = ["omp-desktop", "--project", "--verbose"].map(str::to_owned);
        assert_eq!(startup_workspace(&args), None);
    }

    #[test]
    fn repeat_launch_focuses_before_forwarding_exact_arguments() {
        let actions = RefCell::new(Vec::new());
        let emitted = RefCell::new(None);
        let expected = SingleInstanceEvent {
            args: vec![
                "omp-desktop".to_owned(),
                "--project".to_owned(),
                "D:\\Projects\\Пример".to_owned(),
            ],
        };

        dispatch_second_instance(
            expected.args.clone(),
            || actions.borrow_mut().push("focus"),
            |event| {
                actions.borrow_mut().push("emit");
                emitted.replace(Some(event));
            },
        );

        assert_eq!(actions.into_inner(), ["focus", "emit"]);
        assert_eq!(emitted.into_inner(), Some(expected));
    }
}

pub(crate) async fn run_blocking<T, F>(
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
        move || load_workspace_bootstrap(&app),
    )
    .await
}

fn load_workspace_bootstrap(app: &AppHandle) -> Result<BootstrapPayload, String> {
    let startup = app.state::<StartupWorkspace>();
    let mut requested = startup
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let settings = app.state::<SettingsState>();
    let bootstrap = if let Some(path) = requested
        .as_ref()
        .filter(|path| PathBuf::from(path.as_str()).is_dir())
    {
        with_settings_transaction(app, &settings, |transaction| {
            let snapshot = transaction.candidate_mut();
            add_workspace_to_settings(snapshot, path)?;
            snapshot.last_workspace = Some(path.clone());
            commit_workspace_settings(app, transaction)
        })?
    } else {
        let snapshot = settings_snapshot(app, &settings)?;
        build_bootstrap(app, &snapshot)?
    };
    // Consume only after success, so settings recovery can retry the explicit launch intent.
    *requested = None;
    Ok(bootstrap)
}

#[tauri::command]
async fn open_settings_folder(app: AppHandle) -> Result<(), AppError> {
    run_blocking(
        "открытия папки настроек",
        "settings_folder_open_failed",
        "Не удалось открыть папку настроек",
        move || {
            // Recovery must work without loading settings or accepting an arbitrary IPC path.
            let directory = app
                .path()
                .app_config_dir()
                .map_err(|error| format!("Не удалось определить папку настроек: {error}"))?;
            let existing = directory
                .ancestors()
                .find(|path| path.is_dir())
                .ok_or_else(|| "Не найден существующий каталог настроек".to_owned())?;
            app.opener()
                .open_path(existing.to_string_lossy(), None::<&str>)
                .map_err(|error| format!("Файловый менеджер не смог открыть папку: {error}"))
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
            // A forwarded launch or folder pick supersedes a not-yet-consumed initial argument.
            let startup = app.state::<StartupWorkspace>();
            let mut requested = startup
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *requested = None;
            let state = app.state::<SettingsState>();
            with_settings_transaction(&app, &state, |transaction| {
                add_workspace_to_settings(transaction.candidate_mut(), &path)?;
                commit_workspace_settings(&app, transaction)
            })
        },
    )
    .await
}

fn add_workspace_to_settings(snapshot: &mut AppSettings, path: &str) -> Result<(), String> {
    let workspace = PathBuf::from(path.trim());
    if !workspace.is_dir() {
        return Err(format!("Папка проекта не найдена: {}", workspace.display()));
    }
    let workspace = workspace.to_string_lossy().into_owned();
    let key = path_key(&workspace);
    snapshot
        .recent_workspaces
        .retain(|existing| path_key(existing) != key);
    snapshot
        .hidden_workspaces
        .retain(|hidden| path_key(hidden) != key);
    snapshot.recent_workspaces.insert(0, workspace);
    snapshot.recent_workspaces.truncate(24);
    Ok(())
}

#[tauri::command]
async fn save_workspace_selection(path: Option<String>, app: AppHandle) -> Result<(), AppError> {
    run_blocking(
        "сохранения выбранного проекта",
        "workspace_selection_save_failed",
        "Не удалось запомнить выбранный проект",
        move || {
            let state = app.state::<SettingsState>();
            with_settings_transaction(&app, &state, |transaction| {
                let snapshot = transaction.candidate_mut();
                if let Some(path) = &path {
                    let key = path_key(path);
                    // Removal may have committed while this UI selection was in flight.
                    if !PathBuf::from(path).is_dir()
                        || snapshot
                            .hidden_workspaces
                            .iter()
                            .any(|hidden| path_key(hidden) == key)
                    {
                        return Ok(());
                    }
                }
                if snapshot.last_workspace == path {
                    return Ok(());
                }
                snapshot.last_workspace = path;
                save_settings(&app, snapshot)
            })
        },
    )
    .await
}

fn commit_workspace_settings(
    app: &AppHandle,
    transaction: &mut SettingsTransaction<'_>,
) -> Result<BootstrapPayload, String> {
    let snapshot = transaction.candidate().clone();
    let bootstrap = build_bootstrap(app, &snapshot)?;
    save_settings(app, &snapshot)?;
    Ok(bootstrap)
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
            with_settings_transaction(&app, &state, |transaction| {
                transaction
                    .candidate_mut()
                    .workspace_names
                    .insert(key, name);
                commit_workspace_settings(&app, transaction)
            })
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
            with_settings_transaction(&app, &state, |transaction| {
                let snapshot = transaction.candidate_mut();
                snapshot
                    .recent_workspaces
                    .retain(|existing| path_key(existing) != key);
                snapshot.workspace_names.remove(&key);
                if snapshot
                    .last_workspace
                    .as_ref()
                    .is_some_and(|path| path_key(path) == key)
                {
                    snapshot.last_workspace = None;
                }
                snapshot
                    .hidden_workspaces
                    .retain(|hidden| path_key(hidden) != key);
                snapshot.hidden_workspaces.push(key);
                commit_workspace_settings(&app, transaction)
            })
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
    if let SettingsPatch::Set(value) = &update.app_font_size {
        snapshot.app_font_size = normalize_app_font_size(*value);
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
            with_settings_transaction(&app, &state, |transaction| {
                let previous = transaction.previous().clone();
                apply_settings_update(transaction.candidate_mut(), &request.update);
                let provider_env = match &request.update.provider_env {
                    SettingsPatch::Set(Some(values)) => Some(values.clone()),
                    SettingsPatch::Missing | SettingsPatch::Set(None) => None,
                };

                if let Some(mut config) = request.omp_config {
                    if config.provider_env.is_none() {
                        config.provider_env = provider_env;
                    }
                    let result = omp_bridge::save_config(&app, transaction, config)?;
                    return Ok(SettingsSavePayload {
                        bootstrap: result.bootstrap,
                        omp_config: Some(result.snapshot),
                    });
                }

                let credentials_changed = if let Some(values) = provider_env {
                    update_provider_secrets(&app, transaction.candidate_mut(), values)?;
                    true
                } else {
                    false
                };
                let next = transaction.candidate().clone();
                let mut settings_save_attempted = false;
                let persistence = (|| {
                    let bootstrap = build_bootstrap(&app, &next)?;
                    settings_save_attempted = true;
                    save_settings(&app, &next)?;
                    Ok(bootstrap)
                })();
                let bootstrap = settings::resolve_transaction(persistence, || {
                    let mut rollback_errors = Vec::new();
                    if credentials_changed {
                        if let Err(rollback_error) =
                            settings::restore_provider_secrets(&app, &next, &previous)
                        {
                            rollback_errors.push(rollback_error);
                        }
                    }
                    if settings_save_attempted {
                        if let Err(rollback_error) = save_settings(&app, &previous) {
                            rollback_errors.push(rollback_error);
                        }
                    }
                    rollback_errors
                })?;
                Ok(SettingsSavePayload {
                    bootstrap,
                    omp_config: None,
                })
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
            let snapshot = settings_snapshot(&app, &settings)?;
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
async fn start_with_defaults(app: AppHandle) -> Result<BootstrapPayload, AppError> {
    run_blocking(
        "применения настроек по умолчанию",
        "settings_unavailable",
        "Не удалось применить настройки по умолчанию",
        move || {
            let state = app.state::<SettingsState>();
            let (_, bootstrap) = start_with_defaults_prepared(&app, &state, |defaults| {
                build_bootstrap(&app, defaults)
            })?;
            let startup_pending = app
                .state::<StartupWorkspace>()
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_some();
            if startup_pending {
                load_workspace_bootstrap(&app)
            } else {
                Ok(bootstrap)
            }
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
            let state = app.state::<SettingsState>();
            with_settings_transaction(&app, &state, |transaction| {
                let root = settings::session_root(&app, transaction.candidate())?;
                let validated = sessions::validated_session_file(&path, &root)?;
                let key = path_key(&validated.to_string_lossy());
                let normalized_title = title
                    .as_deref()
                    .map(sessions::normalize_pinned_title)
                    .transpose()?;
                let snapshot = transaction.candidate_mut();
                sessions::remove_session_title_pin(&key, &mut snapshot.session_title_pins);
                if let Some(title) = normalized_title {
                    snapshot.session_title_pins.insert(key, title);
                }
                let next = snapshot.clone();
                let bootstrap = build_bootstrap(&app, &next)?;
                save_settings(&app, &next)?;
                Ok(bootstrap)
            })
        },
    )
    .await
}

#[tauri::command]
async fn delete_session(
    path: String,
    force_session_lease: bool,
    app: AppHandle,
) -> Result<BootstrapPayload, AppError> {
    run_blocking(
        "удаления сессии",
        "session_delete_failed",
        "Не удалось удалить сессию",
        move || {
            let settings = app.state::<SettingsState>();
            with_settings_transaction(&app, &settings, |transaction| {
                let previous = transaction.previous().clone();
                let root = settings::session_root(&app, transaction.candidate())?;
                let terminals = app.state::<TerminalState>();
                let deletion = terminals.prepare_inactive_session_deletion(
                    &path,
                    &root,
                    force_session_lease,
                )?;
                let session_key = deletion.key().to_owned();

                let snapshot = transaction.candidate_mut();
                let title_pin_removed = sessions::remove_session_title_pin(
                    &session_key,
                    &mut snapshot.session_title_pins,
                );
                let provider_pin_removed = sessions::remove_session_primary_provider_pin(
                    &session_key,
                    &mut snapshot.primary_provider_pins,
                );
                let settings_changed = title_pin_removed || provider_pin_removed;
                let next = snapshot.clone();
                let bootstrap =
                    sessions::build_bootstrap_excluding(&app, &next, Some(&session_key))?;

                let mut settings_save_attempted = false;
                let deletion_result = (|| {
                    if settings_changed {
                        settings_save_attempted = true;
                        save_settings(&app, &next)?;
                    }
                    deletion.commit()
                })();
                settings::resolve_transaction(deletion_result, || {
                    if !settings_save_attempted {
                        return Vec::new();
                    }
                    save_settings(&app, &previous).err().into_iter().collect()
                })?;
                Ok(bootstrap)
            })
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
            let snapshot = settings_snapshot(&app, &settings)?;
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
            let snapshot = settings_snapshot(&app, &settings)?;
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
async fn read_session_answers(path: String, app: AppHandle) -> Result<SessionTranscript, AppError> {
    run_blocking(
        "чтения завершённых ответов",
        "session_answers_read_failed",
        "Не удалось прочитать завершённые ответы",
        move || {
            let settings = app.state::<SettingsState>();
            let snapshot = settings_snapshot(&app, &settings)?;
            let root = settings::session_root(&app, &snapshot)?;
            let mut transcript = sessions::read_session_answers(&path, &root)?;
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
async fn load_omp_config(app: AppHandle) -> Result<OmpConfigSnapshot, AppError> {
    run_blocking(
        "загрузки настроек OMP",
        "omp_config_load_failed",
        "Не удалось загрузить настройки OMP",
        move || {
            let settings = app.state::<SettingsState>();
            let snapshot = settings_snapshot(&app, &settings)?;
            omp_bridge::load_config_snapshot(&app, &snapshot)
        },
    )
    .await
}

#[tauri::command]
async fn refresh_omp_config(app: AppHandle) -> Result<OmpConfigSnapshot, AppError> {
    run_blocking(
        "принудительного обновления статуса OMP",
        "omp_config_refresh_failed",
        "Не удалось обновить статус OMP",
        move || {
            let settings = app.state::<SettingsState>();
            let snapshot = settings_snapshot(&app, &settings)?;
            omp_bridge::refresh_config_snapshot(&app, &snapshot)
        },
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
            let snapshot = settings_snapshot(&app, &settings)?;
            omp_bridge::check_update(&app, &snapshot)
        },
    )
    .await
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
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(handle_second_instance));
    let app = builder
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
            app.manage(StartupWorkspace(Mutex::new(startup_workspace(
                &std::env::args().collect::<Vec<_>>(),
            ))));
            app.manage(TerminalState::default());
            #[cfg(feature = "updater-e2e")]
            updater_e2e::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            open_settings_folder,
            add_workspace,
            rename_workspace,
            remove_workspace,
            save_workspace_selection,
            save_settings_bundle,
            set_session_title_pin,
            delete_session,
            import_sessions,
            list_codex_sessions,
            read_session_transcript,
            read_session_answers,
            content_links::open_content_link,
            load_omp_config,
            refresh_omp_config,
            check_omp_update,
            sample_resource_health,
            terminal::start_terminal,
            terminal::switch_terminal,
            terminal::send_switch_input_recovery,
            terminal::discard_switch_input_recovery,
            terminal::set_terminal_primary_provider_pin,
            terminal::attach_terminal,
            terminal::save_terminal_capture,
            terminal::detach_terminal,
            terminal::write_terminal,
            terminal::write_terminal_binary,
            terminal::resize_terminal,
            start_with_defaults,
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
