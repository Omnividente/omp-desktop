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
mod startup_workspace;
mod terminal;
mod update;
#[cfg(feature = "updater-e2e")]
mod updater_e2e;
#[cfg(windows)]
pub mod windows_terminal_input;
use models::{
    AppError, AppSettings, BootstrapPayload, CodexSessionSummary, ImportBatchPayload,
    ImportSessionRequest, OmpConfigSnapshot, OmpUpdateInfo, ResourceHealthSnapshot,
    SessionTranscript, SettingsPatch, SettingsSavePayload, SettingsSaveRequest, SettingsUpdate,
    StartupWorkspaceWarning,
};
use sessions::{build_bootstrap, path_key};
use settings::{
    normalize_app_font_family, normalize_app_font_size, normalize_optional,
    normalize_terminal_font_family, normalize_terminal_font_size, save_settings, settings_snapshot,
    start_with_defaults_prepared, update_provider_secrets, with_settings_transaction,
    SettingsState, SettingsTransaction,
};
use startup_workspace::{Resolution, StartupWorkspaceIntent};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use terminal::TerminalState;

const SINGLE_INSTANCE_EVENT: &str = "single-instance";

struct StartupWorkspace(Mutex<StartupWorkspaceIntent>);

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum StartupWorkspaceAction {
    Retry,
    Continue,
}

fn startup_workspace(args: &[String]) -> Option<String> {
    for (index, arg) in args.iter().enumerate().skip(1) {
        if arg == "--" {
            break;
        }
        if matches!(arg.as_str(), "--project" | "-p" | "--workspace" | "-w") {
            if let Some(value) = args.get(index + 1) {
                if !value.trim().is_empty() && !value.starts_with('-') {
                    return Some(value.to_owned());
                }
            }
        } else if let Some((flag, value)) = arg.split_once('=') {
            if matches!(flag, "--project" | "-p" | "--workspace" | "-w") && !value.trim().is_empty()
            {
                return Some(value.to_owned());
            }
        }
    }
    for (index, arg) in args.iter().enumerate().skip(1) {
        if arg == "--" {
            return args
                .get(index + 1)
                .filter(|value| !value.trim().is_empty())
                .cloned();
        }
        if arg.trim().is_empty()
            || arg.starts_with('-')
            || matches!(arg.to_ascii_lowercase().as_str(), "run" | "dev" | "open")
        {
            continue;
        }
        return Some(arg.to_owned());
    }
    None
}

fn resolve_launch_workspace(path: &str, cwd: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if path.is_absolute() {
        return std::path::absolute(path)
            .map_err(|error| format!("Не удалось определить путь проекта: {error}"));
    }
    let cwd = Path::new(cwd);
    if !cwd.is_absolute() {
        return Err("Не удалось определить рабочий каталог повторного запуска".to_owned());
    }

    #[cfg(windows)]
    let relative = {
        use std::path::{Component, Prefix};
        let mut components = path.components();
        match components.next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Disk(drive) => {
                    let caller_drive = match cwd.components().next() {
                        Some(Component::Prefix(caller)) => match caller.kind() {
                            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => Some(drive),
                            _ => None,
                        },
                        _ => None,
                    };
                    if !caller_drive.is_some_and(|caller| caller.eq_ignore_ascii_case(&drive)) {
                        return Err(format!(
                            "Неоднозначный путь проекта относительно диска {}:. Укажите абсолютный путь",
                            drive as char
                        ));
                    }
                    components.as_path()
                }
                _ => return Err("Неоднозначный путь проекта. Укажите абсолютный путь".to_owned()),
            },
            _ => path,
        }
    };
    #[cfg(not(windows))]
    let relative = path;

    std::path::absolute(cwd.join(relative))
        .map_err(|error| format!("Не удалось определить путь проекта: {error}"))
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SingleInstanceEvent {
    workspace: Option<String>,
    error: Option<String>,
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

fn handle_second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    let (workspace, error) = match startup_workspace(&args) {
        Some(path) => match resolve_launch_workspace(&path, &cwd) {
            Ok(path) => (Some(path.to_string_lossy().into_owned()), None),
            Err(error) => (None, Some(error)),
        },
        None => (None, None),
    };
    focus_main_window(app);
    if let Err(error) = app.emit(
        SINGLE_INSTANCE_EVENT,
        SingleInstanceEvent { workspace, error },
    ) {
        diagnostics::warn("single_instance.emit", &error.to_string());
    }
}

#[cfg(test)]
mod single_instance_tests {
    use super::{
        add_workspace_to_settings, normalize_workspace_name, remove_workspace_from_settings,
        rename_workspace_in_settings, resolve_launch_workspace,
        select_startup_workspace_in_settings, startup_workspace, workspace_path_key, AppSettings,
    };
    use crate::{sessions::path_key, startup_workspace::StartupWorkspaceIntent};
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

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
    fn startup_project_treats_post_delimiter_flags_as_literal_paths() {
        let cases = [
            (
                vec!["omp-desktop", "--", "--project=repo"],
                "--project=repo",
            ),
            (
                vec!["omp-desktop", "--", "wanted", "--project=other"],
                "wanted",
            ),
            (
                vec![
                    "omp-desktop",
                    "--project",
                    "preferred",
                    "--",
                    "--project=other",
                ],
                "preferred",
            ),
        ];
        for (args, expected) in cases {
            let args = args.into_iter().map(str::to_owned).collect::<Vec<_>>();
            assert_eq!(startup_workspace(&args).as_deref(), Some(expected));
        }
    }

    #[test]
    fn startup_project_does_not_consume_another_flag_as_its_path() {
        let args = ["omp-desktop", "--project", "--verbose"].map(str::to_owned);
        assert_eq!(startup_workspace(&args), None);
    }

    #[test]
    fn startup_workspace_accepts_flag_aliases_and_positional_paths() {
        let cases: &[(&[&str], Option<&str>)] = &[
            (
                &["omp-desktop", "--project=./Мой проект"],
                Some("./Мой проект"),
            ),
            (&["omp-desktop", "-p", "./repo"], Some("./repo")),
            (&["omp-desktop", "--workspace", "./repo"], Some("./repo")),
            (&["omp-desktop", "-w=./repo"], Some("./repo")),
            (&["omp-desktop", "open", "./repo"], Some("./repo")),
            (&["omp-desktop", "--verbose", "--", "-repo"], Some("-repo")),
            (&["omp-desktop", "--verbose"], None),
            (&["omp-desktop"], None),
            (&[], None),
        ];
        for (args, expected) in cases {
            let args = args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
            assert_eq!(startup_workspace(&args).as_deref(), *expected);
        }
    }

    #[cfg(windows)]
    #[test]
    fn repeat_launch_paths_are_resolved_without_the_primary_process_cwd() {
        for (path, cwd, expected) in [
            (r".\repo", r"D:\Caller", r"D:\Caller\repo"),
            (r"..\repo", r"D:\Caller", r"D:\repo"),
            (r".\Мой проект", r"D:\Caller", r"D:\Caller\Мой проект"),
            (
                r"C:\Проекты\Мой проект",
                r"D:\Caller",
                r"C:\Проекты\Мой проект",
            ),
            (
                "C:/Проекты/Мой проект",
                r"D:\Caller",
                r"C:\Проекты\Мой проект",
            ),
            (
                r"\\server\share\Мой проект",
                r"D:\Caller",
                r"\\server\share\Мой проект",
            ),
            (r"\repo", r"D:\Caller", r"D:\repo"),
            ("/repo", r"D:\Caller", r"D:\repo"),
            (r"D:repo", r"D:\Caller", r"D:\Caller\repo"),
            (r"d:repo", r"D:\Caller", r"D:\Caller\repo"),
            (r"\repo", r"\\server\share\Caller", r"\\server\share\repo"),
        ] {
            assert_eq!(
                resolve_launch_workspace(path, cwd).unwrap(),
                PathBuf::from(expected)
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn another_drive_relative_path_is_rejected_without_caller_drive_context() {
        assert!(resolve_launch_workspace(r"C:repo", r"D:\Caller").is_err());
        assert!(resolve_launch_workspace(r"D:repo", r"\\server\share\Caller").is_err());
    }

    #[cfg(not(windows))]
    #[test]
    fn repeat_launch_relative_path_uses_the_caller_directory() {
        assert_eq!(
            resolve_launch_workspace("./Мой проект", "/audit/caller").unwrap(),
            PathBuf::from("/audit/caller/Мой проект")
        );
        assert_eq!(
            resolve_launch_workspace("/audit/project", "/other").unwrap(),
            PathBuf::from("/audit/project")
        );
    }

    #[test]
    fn relative_launch_path_does_not_fall_back_when_caller_directory_is_missing() {
        assert!(resolve_launch_workspace("repo", "relative/caller").is_err());
    }

    #[test]
    fn startup_paths_preserve_whitespace_in_every_argument_form() {
        for path in [
            " project",
            "project ",
            "\tproject\t",
            "project\u{a0}",
            " open ",
        ] {
            for flag in ["--project", "-p", "--workspace", "-w"] {
                let args = ["omp-desktop", flag, path].map(str::to_owned);
                assert_eq!(startup_workspace(&args).as_deref(), Some(path));
                let args = vec!["omp-desktop".to_owned(), format!("{flag}={path}")];
                assert_eq!(startup_workspace(&args).as_deref(), Some(path));
            }
            for args in [
                vec!["omp-desktop", path],
                vec!["omp-desktop", "open", path],
                vec!["omp-desktop", "--", path],
            ] {
                let args = args.into_iter().map(str::to_owned).collect::<Vec<_>>();
                assert_eq!(startup_workspace(&args).as_deref(), Some(path));
            }
        }
    }

    #[test]
    fn blank_paths_are_not_startup_or_workspace_targets() {
        for path in ["", " ", "\t", " \t\r\n", "\u{a0}"] {
            for args in [
                vec!["omp-desktop".to_owned(), path.to_owned()],
                vec!["omp-desktop".to_owned(), "--".to_owned(), path.to_owned()],
                vec!["omp-desktop".to_owned(), "-p".to_owned(), path.to_owned()],
                vec!["omp-desktop".to_owned(), format!("--project={path}")],
            ] {
                assert_eq!(startup_workspace(&args), None);
            }
            assert!(workspace_path_key(path).is_err());
            let mut settings = AppSettings::default();
            assert!(add_workspace_to_settings(&mut settings, path).is_err());
            assert!(settings.recent_workspaces.is_empty());
        }
        assert_eq!(normalize_workspace_name(" \tПроект\n ").unwrap(), "Проект");
        assert!(normalize_workspace_name(" \t\n ").is_err());
    }

    static NEXT_WORKSPACE_FIXTURE: AtomicU64 = AtomicU64::new(0);

    struct WorkspaceFixture(PathBuf);

    impl WorkspaceFixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "omp-workspace-identity-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT_WORKSPACE_FIXTURE.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir(&root).unwrap();
            // On Windows this supplies a verbatim path. Ordinary Win32 paths may
            // normalize trailing ASCII spaces before they reach the filesystem.
            Self(fs::canonicalize(root).unwrap())
        }

        fn path(&self, name: &str) -> String {
            self.0.join(name).to_str().unwrap().to_owned()
        }
    }

    impl Drop for WorkspaceFixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn assert_whitespace_workspace_is_distinct(name: &str) {
        let fixture = WorkspaceFixture::new();
        let neighbor = fixture.path("project");
        let selected = fixture.path(name);
        fs::create_dir(&neighbor).unwrap();
        fs::create_dir(&selected).unwrap();
        fs::write(PathBuf::from(&neighbor).join("identity"), "neighbor").unwrap();
        fs::write(PathBuf::from(&selected).join("identity"), "selected").unwrap();
        let neighbor_key = workspace_path_key(&neighbor).unwrap();
        let selected_key = workspace_path_key(&selected).unwrap();
        assert_ne!(neighbor_key, selected_key);

        let mut settings = AppSettings {
            recent_workspaces: vec![neighbor.clone(), selected.clone()],
            hidden_workspaces: vec![neighbor.clone(), selected.clone()],
            last_workspace: Some(neighbor.clone()),
            ..AppSettings::default()
        };
        settings
            .workspace_names
            .insert(neighbor_key.clone(), "Neighbor".to_owned());
        settings
            .workspace_names
            .insert(selected_key.clone(), "Old".to_owned());
        add_workspace_to_settings(&mut settings, &selected).unwrap();
        assert_eq!(
            settings.recent_workspaces,
            [selected.clone(), neighbor.clone()]
        );
        assert_eq!(&settings.hidden_workspaces, std::slice::from_ref(&neighbor));
        assert_eq!(settings.last_workspace.as_deref(), Some(neighbor.as_str()));

        rename_workspace_in_settings(
            &mut settings,
            workspace_path_key(&selected).unwrap(),
            normalize_workspace_name(" \tChosen\n ").unwrap(),
        );
        assert_eq!(settings.workspace_names[&selected_key], "Chosen");
        assert_eq!(settings.workspace_names[&neighbor_key], "Neighbor");
        assert_eq!(settings.last_workspace.as_deref(), Some(neighbor.as_str()));

        let mut selected_last = settings.clone();
        selected_last.last_workspace = Some(selected.clone());
        remove_workspace_from_settings(&mut selected_last, selected_key.clone());
        assert_eq!(selected_last.last_workspace, None);
        remove_workspace_from_settings(&mut settings, workspace_path_key(&selected).unwrap());
        assert_eq!(&settings.recent_workspaces, std::slice::from_ref(&neighbor));
        assert!(!settings.workspace_names.contains_key(&selected_key));
        assert_eq!(settings.workspace_names[&neighbor_key], "Neighbor");
        assert_eq!(settings.last_workspace.as_deref(), Some(neighbor.as_str()));
        assert_eq!(settings.hidden_workspaces, [neighbor.clone(), selected_key]);

        let args = ["omp-desktop", "--project", selected.as_str()].map(str::to_owned);
        let requested = startup_workspace(&args).unwrap();
        assert_eq!(requested, selected);
        let resolved = resolve_launch_workspace(&requested, fixture.0.to_str().unwrap()).unwrap();
        assert_eq!(resolved, PathBuf::from(&selected));
        let mut intent = StartupWorkspaceIntent::new(Some(requested));
        let (_, warning) = intent
            .load(
                |path| select_startup_workspace_in_settings(&mut settings, path),
                || panic!("an available exact startup path must not load the prior workspace"),
            )
            .unwrap();
        assert!(warning.is_none());
        assert!(!intent.is_pending());
        assert_eq!(settings.last_workspace.as_deref(), Some(selected.as_str()));
        assert_eq!(
            settings.recent_workspaces,
            [selected.clone(), neighbor.clone()]
        );
        assert_eq!(
            fs::read_to_string(PathBuf::from(neighbor).join("identity")).unwrap(),
            "neighbor"
        );
        assert_eq!(
            fs::read_to_string(PathBuf::from(selected).join("identity")).unwrap(),
            "selected"
        );
    }

    #[test]
    fn whitespace_named_workspace_actions_preserve_the_neighbor() {
        // NBSP is also legal in ordinary Windows filenames; ASCII trailing
        // spaces below are exercised only through the fixture's verbatim path.
        for name in ["project ", "project\u{a0}"] {
            assert_whitespace_workspace_is_distinct(name);
        }
        #[cfg(unix)]
        assert_whitespace_workspace_is_distinct("project\t");
    }

    #[test]
    fn missing_exact_startup_path_never_selects_the_trimmed_neighbor() {
        let fixture = WorkspaceFixture::new();
        let neighbor = fixture.path("project");
        fs::create_dir(&neighbor).unwrap();
        let mut settings = AppSettings {
            recent_workspaces: vec![neighbor.clone()],
            last_workspace: Some(neighbor.clone()),
            ..AppSettings::default()
        };
        // A legal NBSP suffix avoids ordinary Windows trailing-space aliases.
        let missing = fixture.path("project\u{a0}");
        assert!(add_workspace_to_settings(&mut settings, &missing).is_err());
        let mut intent = StartupWorkspaceIntent::new(Some(missing.clone()));
        let (_, warning) = intent
            .load(
                |path| select_startup_workspace_in_settings(&mut settings, path),
                || Ok(()),
            )
            .unwrap();
        assert_eq!(warning.unwrap().requested_path, missing);
        assert!(intent.is_pending());
        assert_eq!(settings.last_workspace.as_deref(), Some(neighbor.as_str()));
        assert_eq!(settings.recent_workspaces, [neighbor]);
    }

    #[test]
    fn adding_ordinary_workspace_retains_existing_alias_and_recent_limit_rules() {
        let fixture = WorkspaceFixture::new();
        let workspace = fixture.path("project");
        fs::create_dir(&workspace).unwrap();
        let alias = PathBuf::from(&workspace)
            .join(".")
            .to_str()
            .unwrap()
            .to_owned();
        let mut settings = AppSettings {
            recent_workspaces: std::iter::once(alias.clone())
                .chain((0..30).map(|index| fixture.path(&format!("other-{index}"))))
                .collect(),
            hidden_workspaces: vec![alias],
            ..AppSettings::default()
        };
        add_workspace_to_settings(&mut settings, &workspace).unwrap();
        assert_eq!(settings.recent_workspaces.len(), 24);
        assert_eq!(settings.recent_workspaces[0], workspace);
        assert_eq!(settings.recent_workspaces[1], fixture.path("other-0"));
        assert_eq!(settings.recent_workspaces[23], fixture.path("other-22"));
        let key = path_key(&workspace);
        assert_eq!(
            settings
                .recent_workspaces
                .iter()
                .filter(|path| path_key(path) == key)
                .count(),
            1
        );
        assert!(settings.hidden_workspaces.is_empty());
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
    let (bootstrap, warning) = requested.load(
        |path| apply_startup_workspace(app, path),
        || load_prior_workspace_bootstrap(app),
    )?;
    Ok(with_startup_workspace_warning(bootstrap, warning))
}

fn apply_startup_workspace(app: &AppHandle, path: &str) -> Result<BootstrapPayload, String> {
    let settings = app.state::<SettingsState>();
    with_settings_transaction(app, &settings, |transaction| {
        let snapshot = transaction.candidate_mut();
        select_startup_workspace_in_settings(snapshot, path)?;
        commit_workspace_settings(app, transaction)
    })
}

fn load_prior_workspace_bootstrap(app: &AppHandle) -> Result<BootstrapPayload, String> {
    let settings = app.state::<SettingsState>();
    let snapshot = settings_snapshot(app, &settings)?;
    build_bootstrap(app, &snapshot)
}

fn with_startup_workspace_warning(
    mut bootstrap: BootstrapPayload,
    warning: Option<startup_workspace::Warning>,
) -> BootstrapPayload {
    bootstrap.startup_workspace_warning = warning.map(|warning| StartupWorkspaceWarning {
        requested_path: warning.requested_path,
        message: models::sanitize_error_text(&warning.message),
    });
    bootstrap
}

#[tauri::command]
async fn resolve_startup_workspace(
    requested_path: String,
    action: StartupWorkspaceAction,
    app: AppHandle,
) -> Result<BootstrapPayload, AppError> {
    run_blocking(
        "восстановления проекта запуска",
        "startup_workspace_resolution_failed",
        "Не удалось обработать проект запуска",
        move || {
            let startup = app.state::<StartupWorkspace>();
            let mut requested = startup
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let resolution = match action {
                StartupWorkspaceAction::Retry => Resolution::Retry,
                StartupWorkspaceAction::Continue => Resolution::Continue,
            };
            let (bootstrap, warning) = requested.resolve(
                &requested_path,
                resolution,
                |path| apply_startup_workspace(&app, path),
                || load_prior_workspace_bootstrap(&app),
            )?;
            Ok(with_startup_workspace_warning(bootstrap, warning))
        },
    )
    .await
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
            // Only a successful forwarded launch or folder pick supersedes the initial argument.
            let startup = app.state::<StartupWorkspace>();
            let mut requested = startup
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            requested.supersede(|| {
                let state = app.state::<SettingsState>();
                with_settings_transaction(&app, &state, |transaction| {
                    add_workspace_to_settings(transaction.candidate_mut(), &path)?;
                    commit_workspace_settings(&app, transaction)
                })
            })
        },
    )
    .await
}

// Paths are identities, unlike display names. Trimming is only a blank-input check.
fn workspace_path_key(path: &str) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("Путь проекта не может быть пустым".to_owned());
    }
    Ok(path_key(path))
}

fn add_workspace_to_settings(snapshot: &mut AppSettings, path: &str) -> Result<(), String> {
    let workspace = Path::new(path);
    if path.trim().is_empty() || !workspace.is_dir() {
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

fn select_startup_workspace_in_settings(
    snapshot: &mut AppSettings,
    path: &str,
) -> Result<(), String> {
    add_workspace_to_settings(snapshot, path)?;
    snapshot.last_workspace = Some(path.to_owned());
    Ok(())
}

#[tauri::command]
async fn save_workspace_selection(path: Option<String>, app: AppHandle) -> Result<(), AppError> {
    run_blocking(
        "сохранения выбранного проекта",
        "workspace_selection_save_failed",
        "Не удалось запомнить выбранный проект",
        move || {
            // A queued frontend fallback selection is not acknowledgement of a launch failure.
            // Keep the same startup -> settings lock order as bootstrap and folder selection.
            let startup = app.state::<StartupWorkspace>();
            let requested = startup
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if requested.is_pending() {
                return Ok(());
            }
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
            let key = workspace_path_key(&path)?;
            let name = normalize_workspace_name(&name)?;
            let state = app.state::<SettingsState>();
            with_settings_transaction(&app, &state, |transaction| {
                rename_workspace_in_settings(transaction.candidate_mut(), key, name);
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
            let key = workspace_path_key(&path)?;
            let state = app.state::<SettingsState>();
            with_settings_transaction(&app, &state, |transaction| {
                remove_workspace_from_settings(transaction.candidate_mut(), key);
                commit_workspace_settings(&app, transaction)
            })
        },
    )
    .await
}

fn rename_workspace_in_settings(snapshot: &mut AppSettings, key: String, name: String) {
    snapshot.workspace_names.insert(key, name);
}

fn remove_workspace_from_settings(snapshot: &mut AppSettings, key: String) {
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
    if let SettingsPatch::Set(Some(desktop_theme)) = update.desktop_theme {
        snapshot.desktop_theme = desktop_theme;
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
                    let omp_config = if credentials_changed {
                        Some(omp_bridge::load_config_snapshot(&app, &next)?)
                    } else {
                        None
                    };
                    let bootstrap = build_bootstrap(&app, &next)?;
                    settings_save_attempted = true;
                    save_settings(&app, &next)?;
                    Ok((bootstrap, omp_config))
                })();
                let (bootstrap, omp_config) = settings::resolve_transaction(persistence, || {
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
                    omp_config,
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
                .is_pending();
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
            let terminals = app.state::<TerminalState>();
            let items = terminals.import_sessions(&requests, &root);
            let refresh = build_bootstrap(&app, &snapshot);
            if let Err(error) = &refresh {
                diagnostics::warn("обновления списка после импорта", error);
            }
            Ok(ImportBatchPayload::from_refresh(items, refresh))
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
            app.manage(omp_bridge::ModelCatalogState::default());
            app.manage(StartupWorkspace(Mutex::new(StartupWorkspaceIntent::new(
                startup_workspace(&std::env::args().collect::<Vec<_>>()),
            ))));
            app.manage(TerminalState::default());
            #[cfg(feature = "updater-e2e")]
            updater_e2e::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            resolve_startup_workspace,
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
