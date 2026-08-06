use crate::{
    diagnostics,
    models::{
        AppSettings, RuntimeInfo, SettingsWarning, DEFAULT_APP_FONT_FAMILY,
        DEFAULT_TERMINAL_FONT_FAMILY, DEFAULT_TERMINAL_FONT_SIZE,
    },
    omp_command::{run_omp_command, OmpOperation},
    secrets,
    sessions::atomic_write_file,
};
use std::{
    collections::{HashMap, HashSet},
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

pub struct SettingsState(pub Mutex<AppSettings>, Mutex<bool>);

impl SettingsState {
    pub fn new_uninitialized() -> Self {
        Self(Mutex::new(AppSettings::default()), Mutex::new(false))
    }
}

pub fn initialize_settings(app: &AppHandle, state: &SettingsState) -> Result<(), String> {
    let mut initialized = state
        .1
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if *initialized {
        return Ok(());
    }
    let settings = load_settings(app)?;
    *state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = settings;
    *initialized = true;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OmpResolution {
    pub executable: String,
    pub version: Option<String>,
}

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
        match serde_json::from_str(&contents) {
            Ok(settings) => settings,
            Err(error) => recover_invalid_settings(&path, &error.to_string())?,
        }
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
    persisted.settings_warning = None;
    let contents = serde_json::to_string_pretty(&persisted)
        .map_err(|error| format!("Не удалось сериализовать настройки: {error}"))?;
    atomic_write_file(&path, contents.as_bytes())?;
    secrets::set_private_permissions(&path)
}

fn recover_invalid_settings(path: &Path, parse_error: &str) -> Result<AppSettings, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let backup = path.with_file_name(format!("settings.invalid-{timestamp}.json"));
    fs::rename(path, &backup).map_err(|error| {
        format!(
            "Настройки {} повреждены ({parse_error}); не удалось сохранить резервную копию {}: {error}",
            path.display(),
            backup.display()
        )
    })?;
    diagnostics::warn("settings.parse", parse_error);
    diagnostics::info(
        "settings.recovery",
        &format!("invalid settings moved to {}", backup.display()),
    );
    let settings = AppSettings {
        settings_warning: Some(SettingsWarning {
            code: "settings_recovered".to_owned(),
            message: "Повреждённый settings.json сохранён, применены настройки по умолчанию"
                .to_owned(),
            details: Some(backup.to_string_lossy().into_owned()),
        }),
        ..AppSettings::default()
    };
    Ok(settings)
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
    resolve_omp_cached(&OMP_RESOLUTION_CACHE, key, || {
        resolve_omp_uncached(app, settings)
    })
}

fn resolve_omp_cached<F>(
    cache: &Mutex<OmpResolutionCache>,
    key: OmpResolutionKey,
    resolve: F,
) -> OmpResolution
where
    F: FnOnce() -> OmpResolution,
{
    let now = Instant::now();
    if let Some(resolution) = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&key, now)
    {
        return resolution;
    }

    let resolution = resolve();
    let now = Instant::now();
    let mut cache = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(cached) = cache.get(&key, now) {
        return cached;
    }
    cache.store(key, resolution.clone(), now);
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

fn normalize_font_family(value: Option<String>, default: &str) -> String {
    value
        .map(|value| {
            value
                .trim()
                .chars()
                .filter(|character| !character.is_control())
                .collect::<String>()
        })
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .unwrap_or_else(|| default.to_owned())
}

pub fn normalize_app_font_family(value: Option<String>) -> String {
    normalize_font_family(value, DEFAULT_APP_FONT_FAMILY)
}

pub fn normalize_terminal_font_family(value: Option<String>) -> String {
    normalize_font_family(value, DEFAULT_TERMINAL_FONT_FAMILY)
}

pub fn normalize_terminal_font_size(value: Option<u16>) -> u16 {
    value.unwrap_or(DEFAULT_TERMINAL_FONT_SIZE).clamp(8, 32)
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

    let output = run_omp_command(
        executable,
        &["--version"],
        &HashMap::new(),
        OmpOperation::Probe,
    )
    .ok()?;
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

#[cfg(test)]
mod tests {
    use super::{resolve_omp_cached, OmpResolution, OmpResolutionCache, OmpResolutionKey};
    use std::{sync::{mpsc, Arc, Mutex}, thread, time::{Duration, Instant}};

    fn resolution(executable: &str) -> OmpResolution {
        OmpResolution {
            executable: executable.to_owned(),
            version: Some("omp/17.1.3".to_owned()),
        }
    }

    #[test]
    fn resolution_cache_reuses_matching_key_until_ttl() {
        let now = Instant::now();
        let key = OmpResolutionKey {
            configured: Some("omp-a".to_owned()),
            ..OmpResolutionKey::default()
        };
        let value = resolution("omp-a");
        let mut cache = OmpResolutionCache::default();
        cache.store(key.clone(), value.clone(), now);

        assert_eq!(cache.get(&key, now), Some(value));
        assert!(cache.get(&key, now + super::OMP_RESOLUTION_TTL).is_none());
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
        cache.store(first, resolution("omp-a"), now);

        assert!(cache.get(&second, now).is_none());
    }

    #[test]
    fn resolution_cache_releases_lock_before_uncached_work() {
        let cache = Arc::new(Mutex::new(OmpResolutionCache::default()));
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let first_cache = Arc::clone(&cache);
        let first = thread::spawn(move || {
            resolve_omp_cached(
                &first_cache,
                OmpResolutionKey {
                    configured: Some("omp-slow".to_owned()),
                    ..OmpResolutionKey::default()
                },
                || {
                    started_sender.send(()).unwrap();
                    release_receiver.recv().unwrap();
                    resolution("omp-slow")
                },
            )
        });
        started_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("slow resolver did not start");

        let second_cache = Arc::clone(&cache);
        let (second_sender, second_receiver) = mpsc::channel();
        let second = thread::spawn(move || {
            let value = resolve_omp_cached(
                &second_cache,
                OmpResolutionKey {
                    configured: Some("omp-fast".to_owned()),
                    ..OmpResolutionKey::default()
                },
                || resolution("omp-fast"),
            );
            second_sender.send(value).unwrap();
        });

        let second_result = second_receiver.recv_timeout(Duration::from_millis(250));
        release_sender.send(()).unwrap();
        let first_result = first.join().expect("slow resolver panicked");
        second.join().expect("fast resolver panicked");

        assert_eq!(first_result.executable, "omp-slow");
        assert_eq!(
            second_result
                .expect("uncached work was serialized by the global resolver lock")
                .executable,
            "omp-fast"
        );
    }
}
