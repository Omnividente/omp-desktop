use crate::{
    models::{AppSettings, RuntimeInfo},
    secrets,
};
use std::{
    collections::HashSet,
    env,
    ffi::OsString,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{LazyLock, Mutex},
    thread,
    time::{Duration, Instant},
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OmpResolution {
    pub executable: String,
    pub version: Option<String>,
}

const OMP_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const OMP_PROBE_POLL_INTERVAL: Duration = Duration::from_millis(20);
const OMP_PROBE_OUTPUT_LIMIT: u64 = 16 * 1024;
const OMP_RESOLUTION_TTL: Duration = Duration::from_secs(30);

#[derive(Clone, Default, PartialEq, Eq)]
struct OmpResolutionKey {
    configured: Option<String>,
    environment: Option<OsString>,
    path: Option<OsString>,
    local_app_data: Option<OsString>,
    home: Option<PathBuf>,
}

struct CachedOmpResolution {
    key: OmpResolutionKey,
    value: OmpResolution,
    expires_at: Instant,
}

#[derive(Default)]
struct OmpResolutionCache {
    entry: Option<CachedOmpResolution>,
}

impl OmpResolutionCache {
    fn get(&self, key: &OmpResolutionKey, now: Instant) -> Option<OmpResolution> {
        self.entry
            .as_ref()
            .filter(|entry| entry.key == *key && entry.expires_at > now)
            .map(|entry| entry.value.clone())
    }

    fn store(&mut self, key: OmpResolutionKey, value: OmpResolution, now: Instant) {
        self.entry = Some(CachedOmpResolution {
            key,
            value,
            expires_at: now + OMP_RESOLUTION_TTL,
        });
    }
}

static OMP_RESOLUTION_CACHE: LazyLock<Mutex<OmpResolutionCache>> =
    LazyLock::new(|| Mutex::new(OmpResolutionCache::default()));

pub fn load_settings(app: &AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    let mut settings = if path.exists() {
        let contents = fs::read_to_string(&path)
            .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display()))?;
        serde_json::from_str(&contents)
            .map_err(|error| format!("Некорректные настройки {}: {error}", path.display()))?
    } else {
        AppSettings::default()
    };

    let legacy_values = std::mem::take(&mut settings.provider_env);
    let loaded = secrets::load_provider_secrets(app, &settings.provider_env_keys, legacy_values)?;
    settings.provider_env = loaded.values;
    settings.provider_env_keys = loaded.keys;
    settings.secret_storage_warning = loaded.warning;
    if loaded.migrated {
        save_settings(app, &settings)?;
    }
    Ok(settings)
}

pub fn save_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let mut persisted = settings.clone();
    persisted.provider_env_keys.sort();
    persisted.provider_env_keys.dedup();
    let contents = serde_json::to_string_pretty(&persisted)
        .map_err(|error| format!("Не удалось сериализовать настройки: {error}"))?;
    fs::write(&path, contents)
        .map_err(|error| format!("Не удалось записать {}: {error}", path.display()))?;
    secrets::set_private_permissions(&path)
}

pub fn update_provider_secrets(
    app: &AppHandle,
    settings: &mut AppSettings,
    requested: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let loaded = secrets::update_provider_secrets(
        app,
        &settings.provider_env,
        &settings.provider_env_keys,
        requested,
    )?;
    settings.provider_env = loaded.values;
    settings.provider_env_keys = loaded.keys;
    settings.secret_storage_warning = loaded.warning;
    Ok(())
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

pub fn resolve_omp(app: &AppHandle, settings: &AppSettings) -> OmpResolution {
    let key = OmpResolutionKey {
        configured: settings
            .omp_executable
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        environment: env::var_os("OMP_EXECUTABLE"),
        path: env::var_os("PATH"),
        local_app_data: env::var_os("LOCALAPPDATA"),
        home: app.path().home_dir().ok(),
    };
    let mut cache = OMP_RESOLUTION_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    if let Some(resolution) = cache.get(&key, now) {
        return resolution;
    }

    let resolution = resolve_omp_uncached(app, settings);
    cache.store(key, resolution.clone(), Instant::now());
    resolution
}

fn resolve_omp_uncached(_app: &AppHandle, settings: &AppSettings) -> OmpResolution {
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
    command
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + OMP_PROBE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                thread::sleep(OMP_PROBE_POLL_INTERVAL.min(remaining));
            }
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }

    let stdout = read_probe_stream(child.stdout.take()?)?;
    let stderr = read_probe_stream(child.stderr.take()?)?;
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

fn read_probe_stream(stream: impl Read) -> Option<String> {
    let mut bytes = Vec::new();
    stream
        .take(OMP_PROBE_OUTPUT_LIMIT)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn looks_like_path(value: &str) -> bool {
    value.contains('/') || value.contains('\\')
}

#[cfg(test)]
mod tests {
    use super::{OmpResolution, OmpResolutionCache, OmpResolutionKey, OMP_RESOLUTION_TTL};
    use std::time::Instant;

    #[test]
    fn resolution_cache_reuses_matching_key_until_ttl() {
        let now = Instant::now();
        let key = OmpResolutionKey {
            configured: Some("omp-a".to_owned()),
            ..OmpResolutionKey::default()
        };
        let value = OmpResolution {
            executable: "omp-a".to_owned(),
            version: Some("omp/17.1.3".to_owned()),
        };
        let mut cache = OmpResolutionCache::default();
        cache.store(key.clone(), value.clone(), now);

        assert_eq!(cache.get(&key, now), Some(value));
        assert!(cache.get(&key, now + OMP_RESOLUTION_TTL).is_none());
    }

    #[test]
    fn resolution_cache_invalidates_when_executable_changes() {
        let now = Instant::now();
        let first = OmpResolutionKey {
            configured: Some("omp-a".to_owned()),
            ..OmpResolutionKey::default()
        };
        let second = OmpResolutionKey {
            configured: Some("omp-b".to_owned()),
            ..OmpResolutionKey::default()
        };
        let mut cache = OmpResolutionCache::default();
        cache.store(
            first,
            OmpResolution {
                executable: "omp-a".to_owned(),
                version: None,
            },
            now,
        );

        assert!(cache.get(&second, now).is_none());
    }
}
