use crate::models::{AppSettings, RuntimeInfo};
use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct SettingsState(pub Mutex<AppSettings>);

impl SettingsState {
    pub fn new(settings: AppSettings) -> Self {
        Self(Mutex::new(settings))
    }
}

#[derive(Debug, Clone)]
pub struct OmpResolution {
    pub executable: String,
    pub version: Option<String>,
}

pub fn load_settings(app: &AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }

    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display()))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Некорректные настройки {}: {error}", path.display()))
}

pub fn save_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let contents = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Не удалось сериализовать настройки: {error}"))?;
    fs::write(&path, contents)
        .map_err(|error| format!("Не удалось записать {}: {error}", path.display()))
}

pub fn session_root(app: &AppHandle, settings: &AppSettings) -> Result<PathBuf, String> {
    if let Some(path) = settings
        .session_root
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        return Ok(PathBuf::from(path));
    }

    if let Some(path) = env::var_os("PI_CODING_AGENT_DIR") {
        return Ok(PathBuf::from(path).join("sessions"));
    }

    app.path()
        .home_dir()
        .map(|home| home.join(".omp").join("agent").join("sessions"))
        .map_err(|error| format!("Не удалось определить домашнюю папку: {error}"))
}

pub fn resolve_omp(_app: &AppHandle, settings: &AppSettings) -> OmpResolution {
    let mut candidates = Vec::new();

    if let Some(configured) = settings
        .omp_executable
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        candidates.push(configured.to_owned());
    }

    if let Some(from_env) = env::var_os("OMP_EXECUTABLE") {
        candidates.push(from_env.to_string_lossy().into_owned());
    }

    #[cfg(windows)]
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("omp")
                .join("omp.exe")
                .to_string_lossy()
                .into_owned(),
        );
    }

    #[cfg(not(windows))]
    if let Ok(home) = _app.path().home_dir() {
        candidates.push(
            home.join(".local")
                .join("bin")
                .join("omp")
                .to_string_lossy()
                .into_owned(),
        );
        candidates.push(
            home.join(".npm-global")
                .join("bin")
                .join("omp")
                .to_string_lossy()
                .into_owned(),
        );
    }

    #[cfg(not(windows))]
    candidates.push("/usr/local/bin/omp".to_owned());
    candidates.push("omp".to_owned());

    let fallback = candidates
        .first()
        .cloned()
        .unwrap_or_else(|| "omp".to_owned());
    let mut seen = HashSet::new();

    for candidate in candidates {
        let key = if cfg!(windows) {
            candidate.to_lowercase()
        } else {
            candidate.clone()
        };
        if !seen.insert(key) {
            continue;
        }

        if let Some(version) = probe_omp(&candidate) {
            return OmpResolution {
                executable: candidate,
                version: Some(version),
            };
        }
    }

    OmpResolution {
        executable: fallback,
        version: None,
    }
}

pub fn runtime_info(app: &AppHandle, settings: &AppSettings) -> Result<RuntimeInfo, String> {
    let root = session_root(app, settings)?;
    let omp = resolve_omp(app, settings);

    Ok(RuntimeInfo {
        platform: env::consts::OS.to_owned(),
        arch: env::consts::ARCH.to_owned(),
        omp_available: omp.version.is_some(),
        omp_executable: omp.executable,
        omp_version: omp.version,
        session_root: root.to_string_lossy().into_owned(),
        language: settings.language.clone(),
    })
}

pub fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Не удалось определить папку настроек: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Не удалось создать {}: {error}", directory.display()))?;
    Ok(directory.join("settings.json"))
}

fn probe_omp(executable: &str) -> Option<String> {
    if looks_like_path(executable) && !Path::new(executable).is_file() {
        return None;
    }

    let mut command = Command::new(executable);
    command.arg("--version");
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

fn looks_like_path(value: &str) -> bool {
    value.contains('/') || value.contains('\\')
}
