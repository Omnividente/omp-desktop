use crate::{
    diagnostics,
    models::{
        AppSettings, RuntimeInfo, SettingsWarning, DEFAULT_APP_FONT_FAMILY,
        DEFAULT_TERMINAL_FONT_FAMILY, DEFAULT_TERMINAL_FONT_SIZE,
    },
    omp_command::{run_omp_command, OmpOperation},
    secrets,
    sessions::{atomic_write_file, atomic_write_private_file, path_key},
};
use serde::de::DeserializeOwned;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, MutexGuard},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

#[derive(Clone)]
struct CommittedSettings {
    settings: AppSettings,
    initialized: bool,
}

pub struct SettingsState {
    committed: Mutex<CommittedSettings>,
    settings_mutation: Mutex<()>,
}

pub struct SettingsTransaction<'a> {
    state: &'a SettingsState,
    _mutation_guard: MutexGuard<'a, ()>,
    previous: AppSettings,
    candidate: AppSettings,
}

impl SettingsState {
    pub fn new_uninitialized() -> Self {
        Self {
            committed: Mutex::new(CommittedSettings {
                settings: AppSettings::default(),
                initialized: false,
            }),
            settings_mutation: Mutex::new(()),
        }
    }

    fn lock_committed(&self) -> MutexGuard<'_, CommittedSettings> {
        self.committed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_mutation(&self) -> MutexGuard<'_, ()> {
        self.settings_mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn is_initialized(&self) -> bool {
        self.lock_committed().initialized
    }

    fn committed_snapshot(&self) -> Option<AppSettings> {
        let committed = self.lock_committed();
        committed.initialized.then(|| committed.settings.clone())
    }

    fn publish(&self, settings: AppSettings) {
        let mut committed = self.lock_committed();
        committed.settings = settings;
        committed.initialized = true;
    }

    fn begin_transaction(&self) -> Option<SettingsTransaction<'_>> {
        let mutation_guard = self.lock_mutation();
        let previous = self.committed_snapshot()?;
        Some(SettingsTransaction {
            state: self,
            _mutation_guard: mutation_guard,
            candidate: previous.clone(),
            previous,
        })
    }
}

impl SettingsTransaction<'_> {
    pub fn previous(&self) -> &AppSettings {
        &self.previous
    }

    pub fn candidate(&self) -> &AppSettings {
        &self.candidate
    }

    pub fn candidate_mut(&mut self) -> &mut AppSettings {
        &mut self.candidate
    }

    fn commit(self) {
        let candidate = self.candidate;
        self.state.publish(candidate);
    }
}

fn ensure_initialized_with<F>(state: &SettingsState, initialize: F) -> Result<(), String>
where
    F: FnOnce() -> Result<AppSettings, String>,
{
    if state.is_initialized() {
        return Ok(());
    }
    let _mutation_guard = state.lock_mutation();
    if state.is_initialized() {
        return Ok(());
    }
    let settings = initialize()?;
    state.publish(settings);
    Ok(())
}

pub fn ensure_initialized(app: &AppHandle, state: &SettingsState) -> Result<(), String> {
    ensure_initialized_with(state, || load_settings(app))
}

pub fn settings_snapshot(app: &AppHandle, state: &SettingsState) -> Result<AppSettings, String> {
    if let Some(settings) = state.committed_snapshot() {
        return Ok(settings);
    }
    ensure_initialized(app, state)?;
    state.committed_snapshot().ok_or_else(|| {
        settings_state_unavailable(app, "initialize", "Настройки не были опубликованы")
    })
}

pub fn with_settings_transaction<T, F>(
    app: &AppHandle,
    state: &SettingsState,
    operation: F,
) -> Result<T, String>
where
    F: FnOnce(&mut SettingsTransaction<'_>) -> Result<T, String>,
{
    ensure_initialized(app, state)?;
    let mut transaction = state.begin_transaction().ok_or_else(|| {
        settings_state_unavailable(app, "transaction", "Настройки не инициализированы")
    })?;
    let value = operation(&mut transaction)?;
    transaction.commit();
    Ok(value)
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

const MAX_SETTINGS_FAILURE_REASON_CHARS: usize = 512;

fn bounded_settings_reason(reason: &str) -> String {
    let lower_reason = reason.to_ascii_lowercase();
    let redacted = if [
        "authorization:",
        "authorization=",
        "bearer ",
        "api_key=",
        "apikey=",
        "access_token=",
        "refresh_token=",
        "password=",
        "secret=",
    ]
    .iter()
    .any(|marker| lower_reason.contains(marker))
    {
        "[REDACTED SENSITIVE SETTINGS ERROR]"
    } else {
        reason
    };
    let mut bounded = redacted
        .chars()
        .filter(|character| !character.is_control() || *character == '\n')
        .take(MAX_SETTINGS_FAILURE_REASON_CHARS)
        .collect::<String>();
    if redacted.chars().count() > MAX_SETTINGS_FAILURE_REASON_CHARS {
        bounded.push('…');
    }
    bounded
}

fn settings_path_hint(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("settings.json"))
        .unwrap_or_else(|_| PathBuf::from("settings.json"))
}

fn settings_unavailable_error(
    path: &Path,
    backup_path: Option<&Path>,
    stage: &str,
    reason: &str,
) -> String {
    let payload = serde_json::json!({
        "settingsPath": path.to_string_lossy(),
        "backupPath": backup_path.map(|backup| backup.to_string_lossy().into_owned()),
        "failureStage": stage,
        "reason": bounded_settings_reason(reason),
    });
    format!("[settings_unavailable] {payload}")
}

fn settings_state_unavailable(app: &AppHandle, stage: &str, reason: &str) -> String {
    settings_unavailable_error(&settings_path_hint(app), None, stage, reason)
}

fn settings_stage_error(
    path: &Path,
    backup_path: Option<&Path>,
    stage: &str,
    error: String,
) -> String {
    if error.starts_with("[settings_unavailable] ") {
        error
    } else {
        settings_unavailable_error(path, backup_path, stage, &error)
    }
}

fn unique_settings_backup(path: &Path, label: &str) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    for _ in 0..16 {
        let backup = path.with_file_name(format!(
            "{label}-{timestamp}-{}.json",
            rand::random::<u64>()
        ));
        if !backup.exists() {
            return Ok(backup);
        }
    }
    Err("Не удалось подобрать уникальный путь резервной копии настроек".to_owned())
}

fn normalize_session_pin_keys(settings: &mut AppSettings) -> bool {
    let source_titles = std::mem::take(&mut settings.session_title_pins);
    let source_title_len = source_titles.len();
    let mut alias_titles = BTreeMap::new();
    let mut canonical_titles = BTreeMap::new();
    let mut changed = false;
    for (candidate, title) in source_titles {
        let key = path_key(&candidate);
        if candidate == key {
            canonical_titles.insert(key, title);
        } else {
            changed = true;
            alias_titles.entry(key).or_insert(title);
        }
    }
    alias_titles.extend(canonical_titles);
    if alias_titles.len() != source_title_len {
        changed = true;
    }
    settings.session_title_pins = alias_titles;

    let source_primary = std::mem::take(&mut settings.primary_provider_pins);
    let source_primary_len = source_primary.len();
    let mut primary = BTreeSet::new();
    for candidate in source_primary {
        let key = path_key(&candidate);
        if candidate != key {
            changed = true;
        }
        if !primary.insert(key) {
            changed = true;
        }
    }
    if primary.len() != source_primary_len {
        changed = true;
    }
    settings.primary_provider_pins = primary;
    changed
}

pub fn load_settings(app: &AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app).map_err(|error| {
        settings_unavailable_error(Path::new("settings.json"), None, "path", &error)
    })?;
    let mut recovered_backup = None;
    let mut settings = if path.exists() {
        secrets::set_private_permissions(&path)
            .map_err(|error| settings_stage_error(&path, None, "secure_read", error))?;
        let contents = fs::read_to_string(&path)
            .map_err(|error| settings_unavailable_error(&path, None, "read", &error.to_string()))?;
        match serde_json::from_str(&contents) {
            Ok(settings) => settings,
            Err(error) => {
                let (settings, backup) = recover_invalid_settings(&path, &error.to_string())?;
                recovered_backup = Some(backup);
                settings
            }
        }
    } else {
        AppSettings::default()
    };

    let pins_normalized = normalize_session_pin_keys(&mut settings);
    let legacy_values = std::mem::take(&mut settings.provider_env);
    let loaded = secrets::load_provider_secrets(app, &settings.provider_env_keys, legacy_values)
        .map_err(|error| {
            settings_stage_error(&path, recovered_backup.as_deref(), "secrets", error)
        })?;
    settings.provider_env = loaded.values;
    settings.provider_env_keys = loaded.keys;
    settings.secret_storage_warning = loaded.warning;
    if loaded.migrated || recovered_backup.is_some() || pins_normalized {
        save_settings(app, &settings).map_err(|error| {
            settings_stage_error(&path, recovered_backup.as_deref(), "migration_save", error)
        })?;
    }
    Ok(settings)
}

pub fn save_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    save_settings_to_path(&path, settings)
}

fn persisted_settings_bytes(settings: &AppSettings) -> Result<Vec<u8>, String> {
    let mut persisted = settings.clone();
    persisted.provider_env_keys.sort();
    persisted.provider_env_keys.dedup();
    persisted.settings_warning = None;
    serde_json::to_vec_pretty(&persisted)
        .map_err(|error| format!("Не удалось сериализовать настройки: {error}"))
}

fn save_settings_to_path(path: &Path, settings: &AppSettings) -> Result<(), String> {
    let contents = persisted_settings_bytes(settings)?;
    atomic_write_private_file(path, &contents)
}

fn recover_invalid_settings(
    path: &Path,
    parse_error: &str,
) -> Result<(AppSettings, PathBuf), String> {
    recover_invalid_settings_with(path, parse_error, atomic_write_private_file)
}

const MAX_DAMAGED_SETTINGS_RECOVERY_BYTES: usize = 1024 * 1024;
const MAX_RECOVERED_SETTINGS_ITEMS: usize = 4096;

fn json_string_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut index = start.checked_add(1)?;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index = index.checked_add(2)?,
            b'"' => return Some(index + 1),
            _ => index += 1,
        }
    }
    None
}

fn recover_top_level_json_field<T: DeserializeOwned>(text: &str, key: &str) -> Option<T> {
    let bytes = text.as_bytes();
    let mut index = 0;
    let mut depth = 0_u32;
    while index < bytes.len() {
        match bytes[index] {
            b'{' | b'[' => {
                depth = depth.saturating_add(1);
                index += 1;
            }
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
                index += 1;
            }
            b'"' => {
                let end = json_string_end(bytes, index)?;
                if depth == 1
                    && serde_json::from_slice::<String>(&bytes[index..end])
                        .ok()
                        .as_deref()
                        == Some(key)
                {
                    let mut value_start = end;
                    while bytes.get(value_start).is_some_and(u8::is_ascii_whitespace) {
                        value_start += 1;
                    }
                    if bytes.get(value_start) != Some(&b':') {
                        index = end;
                        continue;
                    }
                    value_start += 1;
                    while bytes.get(value_start).is_some_and(u8::is_ascii_whitespace) {
                        value_start += 1;
                    }
                    let mut values = serde_json::Deserializer::from_slice(&bytes[value_start..])
                        .into_iter::<T>();
                    return values.next()?.ok();
                }
                index = end;
            }
            _ => index += 1,
        }
    }
    None
}

fn recover_settings_fields(original: &[u8]) -> AppSettings {
    let bounded = &original[..original.len().min(MAX_DAMAGED_SETTINGS_RECOVERY_BYTES)];
    let text = String::from_utf8_lossy(bounded);
    let mut recovered = AppSettings::default();

    if let Some(mut keys) = recover_top_level_json_field::<Vec<String>>(&text, "providerEnvKeys") {
        keys.truncate(MAX_RECOVERED_SETTINGS_ITEMS);
        recovered.provider_env_keys = keys;
    }
    if let Some(value) = recover_top_level_json_field::<Option<String>>(&text, "ompExecutable") {
        recovered.omp_executable = value;
    }
    if let Some(value) = recover_top_level_json_field::<Option<String>>(&text, "sessionRoot") {
        recovered.session_root = value;
    }
    if let Some(mut values) = recover_top_level_json_field::<Vec<String>>(&text, "recentWorkspaces")
    {
        values.truncate(24);
        recovered.recent_workspaces = values;
    }
    if let Some(values) =
        recover_top_level_json_field::<BTreeMap<String, String>>(&text, "workspaceNames")
    {
        recovered.workspace_names = values
            .into_iter()
            .take(MAX_RECOVERED_SETTINGS_ITEMS)
            .collect();
    }
    if let Some(mut values) = recover_top_level_json_field::<Vec<String>>(&text, "hiddenWorkspaces")
    {
        values.truncate(MAX_RECOVERED_SETTINGS_ITEMS);
        recovered.hidden_workspaces = values;
    }
    if let Some(values) =
        recover_top_level_json_field::<BTreeMap<String, String>>(&text, "sessionTitlePins")
    {
        recovered.session_title_pins = values
            .into_iter()
            .take(MAX_RECOVERED_SETTINGS_ITEMS)
            .collect();
    }
    if let Some(values) =
        recover_top_level_json_field::<BTreeSet<String>>(&text, "primaryProviderPins")
    {
        recovered.primary_provider_pins = values
            .into_iter()
            .take(MAX_RECOVERED_SETTINGS_ITEMS)
            .collect();
    }
    normalize_session_pin_keys(&mut recovered);
    recovered
}

fn recover_invalid_settings_with<F>(
    path: &Path,
    parse_error: &str,
    backup_write: F,
) -> Result<(AppSettings, PathBuf), String>
where
    F: FnOnce(&Path, &[u8]) -> Result<(), String>,
{
    secrets::set_private_permissions(path)
        .map_err(|error| settings_stage_error(path, None, "secure_invalid", error))?;
    let original = fs::read(path)
        .map_err(|error| settings_stage_error(path, None, "backup_read", error.to_string()))?;
    let backup = unique_settings_backup(path, "settings.invalid")
        .map_err(|error| settings_stage_error(path, None, "backup_path", error))?;
    if let Err(error) = backup_write(&backup, &original) {
        let existing_backup = backup.is_file().then_some(backup.as_path());
        return Err(settings_stage_error(
            path,
            existing_backup,
            "backup_write",
            error,
        ));
    }
    let parse_reason = bounded_settings_reason(parse_error);
    diagnostics::warn("settings.parse", &parse_reason);
    diagnostics::info(
        "settings.recovery",
        &format!("invalid settings copied to {}", backup.display()),
    );
    let mut settings = recover_settings_fields(&original);
    settings.settings_warning = Some(SettingsWarning {
        code: "settings_recovered".to_owned(),
        message: "Повреждённый settings.json сохранён; безопасные поля восстановлены частично. Проверьте credentials и пути."
            .to_owned(),
        details: Some(backup.to_string_lossy().into_owned()),
    });
    Ok((settings, backup))
}

pub fn start_with_defaults_prepared<T, F>(
    app: &AppHandle,
    state: &SettingsState,
    prepare: F,
) -> Result<(AppSettings, T), String>
where
    F: FnOnce(&AppSettings) -> Result<T, String>,
{
    let _mutation_guard = state.lock_mutation();
    let path = settings_path(app).map_err(|error| {
        settings_unavailable_error(Path::new("settings.json"), None, "path", &error)
    })?;
    let mut write = atomic_write_private_file;
    let defaults = prepare_defaults_at_with(&path, &mut write)?;
    let prepared = prepare(&defaults)?;
    persist_defaults_at_with(&path, &defaults, &mut write)?;
    state.publish(defaults.clone());
    Ok((defaults, prepared))
}

fn prepare_defaults_at_with<F>(path: &Path, mut write: F) -> Result<AppSettings, String>
where
    F: FnMut(&Path, &[u8]) -> Result<(), String>,
{
    let backup = if path.exists() {
        secrets::set_private_permissions(path)
            .map_err(|error| settings_stage_error(path, None, "backup_secure", error))?;
        let original = fs::read(path).map_err(|error| {
            settings_unavailable_error(path, None, "backup_read", &error.to_string())
        })?;
        let backup = unique_settings_backup(path, "settings.backup")
            .map_err(|error| settings_stage_error(path, None, "backup_path", error))?;
        if let Err(error) = write(&backup, &original) {
            let existing_backup = backup.is_file().then_some(backup.as_path());
            return Err(settings_stage_error(
                path,
                existing_backup,
                "backup_write",
                error,
            ));
        }
        Some(backup)
    } else {
        None
    };

    let mut defaults = AppSettings::default();
    if let Some(backup) = backup.as_ref() {
        defaults.settings_warning = Some(SettingsWarning {
            code: "settings_defaults_started".to_owned(),
            message: "Исходные настройки сохранены; применены настройки по умолчанию".to_owned(),
            details: Some(backup.to_string_lossy().into_owned()),
        });
    }
    Ok(defaults)
}

fn persist_defaults_at_with<F>(
    path: &Path,
    defaults: &AppSettings,
    mut write: F,
) -> Result<(), String>
where
    F: FnMut(&Path, &[u8]) -> Result<(), String>,
{
    let backup = defaults
        .settings_warning
        .as_ref()
        .and_then(|warning| warning.details.as_deref())
        .map(PathBuf::from);
    let contents = persisted_settings_bytes(defaults).map_err(|error| {
        settings_stage_error(path, backup.as_deref(), "defaults_serialize", error)
    })?;
    write(path, &contents)
        .map_err(|error| settings_stage_error(path, backup.as_deref(), "defaults_write", error))
}

#[cfg(test)]
fn start_with_defaults_at_with<F>(path: &Path, mut write: F) -> Result<AppSettings, String>
where
    F: FnMut(&Path, &[u8]) -> Result<(), String>,
{
    let defaults = prepare_defaults_at_with(path, &mut write)?;
    persist_defaults_at_with(path, &defaults, &mut write)?;
    Ok(defaults)
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

pub fn restore_provider_secrets(
    app: &AppHandle,
    current: &AppSettings,
    previous: &AppSettings,
) -> Result<(), String> {
    secrets::replace_provider_secrets(
        app,
        &current.provider_env_keys,
        &previous.provider_env,
        &previous.provider_env_keys,
    )?;
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

const PRIMARY_PROVIDER_PIN_OVERLAY_FILE: &str = "primary-provider-pin.yml";
const PRIMARY_PROVIDER_PIN_OVERLAY: &str = "retry:\n  enabled: true\n  maxRetries: 2147483647\n  maxDelayMs: 0\n  modelFallback: false\n  usageAwareFallback: false\nproviders:\n  anthropic:\n    serverSideFallback: false\n";

pub fn ensure_primary_provider_pin_overlay(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Не удалось определить папку overlay: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Не удалось создать {}: {error}", directory.display()))?;
    let path = directory.join(PRIMARY_PROVIDER_PIN_OVERLAY_FILE);
    if fs::read(&path).ok().as_deref() != Some(PRIMARY_PROVIDER_PIN_OVERLAY.as_bytes()) {
        atomic_write_file(&path, PRIMARY_PROVIDER_PIN_OVERLAY.as_bytes())?;
    }
    Ok(path)
}

const PROXY_PROVIDER_OVERLAY_FILE: &str = "proxy-providers.yml";

fn proxy_provider_overlay(providers: &BTreeSet<String>) -> Result<Option<Vec<u8>>, String> {
    if providers.is_empty() {
        return Ok(None);
    }
    let fallback_chains = providers
        .iter()
        .map(|provider| (format!("{provider}/*"), vec![format!("{provider}/*")]))
        .collect::<BTreeMap<_, _>>();
    let mut contents = serde_json::to_vec_pretty(&serde_json::json!({
        "retry": { "fallbackChains": fallback_chains },
        "providers": { "openaiWebsockets": "off" },
    }))
    .map_err(|error| format!("Не удалось сериализовать proxy overlay: {error}"))?;
    contents.push(b'\n');
    Ok(Some(contents))
}

pub fn ensure_proxy_provider_overlay(
    app: &AppHandle,
    providers: &BTreeSet<String>,
) -> Result<Option<PathBuf>, String> {
    let Some(contents) = proxy_provider_overlay(providers)? else {
        return Ok(None);
    };
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Не удалось определить папку overlay: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Не удалось создать {}: {error}", directory.display()))?;
    let path = directory.join(PROXY_PROVIDER_OVERLAY_FILE);
    if fs::read(&path).ok().as_deref() != Some(contents.as_slice()) {
        atomic_write_file(&path, &contents)?;
    }
    Ok(Some(path))
}

#[cfg(test)]
fn proxy_provider_overlay_for_test(providers: &BTreeSet<String>) -> Vec<u8> {
    proxy_provider_overlay(providers)
        .expect("proxy overlay should serialize")
        .expect("proxy overlay should exist")
}

#[cfg(test)]
fn primary_provider_pin_overlay() -> &'static str {
    PRIMARY_PROVIDER_PIN_OVERLAY
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

pub fn resolve_transaction<T, F>(result: Result<T, String>, rollback: F) -> Result<T, String>
where
    F: FnOnce() -> Vec<String>,
{
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            let rollback_errors = rollback();
            if rollback_errors.is_empty() {
                Err(error)
            } else {
                Err(format!(
                    "{error}; откат не завершён: {}",
                    rollback_errors.join("; ")
                ))
            }
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Не удалось определить папку настроек: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Не удалось создать {}: {error}", directory.display()))?;
    secrets::set_private_directory_permissions(&directory)?;
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
    use super::{
        bounded_settings_reason, ensure_initialized_with, normalize_session_pin_keys,
        primary_provider_pin_overlay, proxy_provider_overlay_for_test,
        recover_invalid_settings_with, resolve_omp_cached, resolve_transaction,
        save_settings_to_path, start_with_defaults_at_with, AppSettings, OmpResolution,
        OmpResolutionCache, OmpResolutionKey, SettingsState, MAX_SETTINGS_FAILURE_REASON_CHARS,
    };
    use std::{
        cell::Cell,
        collections::{BTreeMap, BTreeSet},
        fs,
        path::PathBuf,
        sync::{mpsc, Arc},
        thread,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    fn resolution(executable: &str) -> OmpResolution {
        OmpResolution {
            executable: executable.to_owned(),
            version: Some("omp/17.1.3".to_owned()),
        }
    }

    fn settings_fixture(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "omp-desktop-settings-{label}-{}-{nonce}-{}",
            std::process::id(),
            rand::random::<u64>()
        ))
    }

    #[test]
    fn settings_failure_reason_is_bounded_and_redacted() {
        let sensitive = "permission denied: API_KEY=super-secret-value";
        let redacted = bounded_settings_reason(sensitive);
        assert_eq!(redacted, "[REDACTED SENSITIVE SETTINGS ERROR]");
        assert!(!redacted.contains("super-secret-value"));

        let oversized = "x".repeat(MAX_SETTINGS_FAILURE_REASON_CHARS + 100);
        let bounded = bounded_settings_reason(&oversized);
        assert_eq!(
            bounded.chars().count(),
            MAX_SETTINGS_FAILURE_REASON_CHARS + 1
        );
        assert!(bounded.ends_with('…'));
    }

    #[test]
    fn primary_provider_overlay_waits_without_model_fallback() {
        let overlay = serde_saphyr::from_str::<serde_json::Value>(primary_provider_pin_overlay())
            .expect("pin overlay should be valid YAML");

        assert_eq!(
            overlay
                .pointer("/retry/enabled")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            overlay
                .pointer("/retry/maxRetries")
                .and_then(serde_json::Value::as_u64),
            Some(2_147_483_647)
        );
        assert_eq!(
            overlay
                .pointer("/retry/maxDelayMs")
                .and_then(serde_json::Value::as_u64),
            Some(0)
        );
        assert_eq!(
            overlay
                .pointer("/retry/modelFallback")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            overlay
                .pointer("/retry/usageAwareFallback")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            overlay
                .pointer("/providers/anthropic/serverSideFallback")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn proxy_provider_overlay_keeps_fallback_inside_proxy_and_disables_websockets() {
        let providers = BTreeSet::from(["codex-lb".to_owned(), "gateway".to_owned()]);
        let contents = proxy_provider_overlay_for_test(&providers);
        let overlay = serde_saphyr::from_str::<serde_json::Value>(
            std::str::from_utf8(&contents).expect("proxy overlay should be UTF-8"),
        )
        .expect("proxy overlay should be valid YAML");

        assert_eq!(
            overlay
                .pointer("/retry/fallbackChains/codex-lb~1*")
                .and_then(|value| value.get(0))
                .and_then(serde_json::Value::as_str),
            Some("codex-lb/*")
        );
        assert_eq!(
            overlay
                .pointer("/retry/fallbackChains/gateway~1*")
                .and_then(|value| value.get(0))
                .and_then(serde_json::Value::as_str),
            Some("gateway/*")
        );
        assert_eq!(
            overlay
                .pointer("/providers/openaiWebsockets")
                .and_then(serde_json::Value::as_str),
            Some("off")
        );
    }
    #[test]
    fn pin_key_normalization_collapses_aliases_and_prefers_canonical_title() {
        let alias = r"C:\Sessions\A.JSONL".to_owned();
        let canonical = crate::sessions::path_key(&alias);
        let mut settings = AppSettings::default();
        settings
            .session_title_pins
            .insert(alias.clone(), "alias title".to_owned());
        settings
            .session_title_pins
            .insert(canonical.clone(), "canonical title".to_owned());
        settings.primary_provider_pins.insert(alias);
        settings.primary_provider_pins.insert(canonical.clone());

        assert!(normalize_session_pin_keys(&mut settings));
        assert_eq!(
            settings.session_title_pins,
            BTreeMap::from([(canonical.clone(), "canonical title".to_owned())])
        );
        assert_eq!(settings.primary_provider_pins, BTreeSet::from([canonical]));
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
        let cache = std::sync::Mutex::new(OmpResolutionCache::default());
        let value = resolve_omp_cached(
            &cache,
            OmpResolutionKey {
                configured: Some("omp-slow".to_owned()),
                ..OmpResolutionKey::default()
            },
            || {
                assert!(
                    cache.try_lock().is_ok(),
                    "uncached work ran while the global resolver lock was held"
                );
                resolution("omp-slow")
            },
        );

        assert_eq!(value.executable, "omp-slow");
    }

    #[test]
    fn failed_persistence_restores_credentials_and_settings() {
        let credentials = Cell::new("new credential");
        let settings = Cell::new("new settings");

        let result = resolve_transaction::<(), _>(Err("disk write failed".to_owned()), || {
            credentials.set("old credential");
            settings.set("old settings");
            Vec::new()
        });

        assert_eq!(result, Err("disk write failed".to_owned()));
        assert_eq!(credentials.get(), "old credential");
        assert_eq!(settings.get(), "old settings");
    }

    #[test]
    fn rollback_failure_is_reported_with_primary_error() {
        let result = resolve_transaction::<(), _>(Err("disk write failed".to_owned()), || {
            vec!["credential rollback failed".to_owned()]
        });

        assert_eq!(
            result,
            Err("disk write failed; откат не завершён: credential rollback failed".to_owned())
        );
    }

    #[test]
    fn initialization_is_single_flight() {
        let state = Arc::new(SettingsState::new_uninitialized());
        let (first_entered_tx, first_entered_rx) = mpsc::sync_channel(0);
        let (release_first_tx, release_first_rx) = mpsc::sync_channel(0);

        let first_state = Arc::clone(&state);
        let first = thread::spawn(move || {
            ensure_initialized_with(&first_state, || {
                first_entered_tx
                    .send(())
                    .expect("test should observe first initializer");
                release_first_rx
                    .recv()
                    .expect("test should release first initializer");
                Ok(AppSettings {
                    language: "first".to_owned(),
                    ..AppSettings::default()
                })
            })
        });
        first_entered_rx
            .recv()
            .expect("first initializer should start");

        let (second_started_tx, second_started_rx) = mpsc::sync_channel(0);
        let second_state = Arc::clone(&state);
        let second = thread::spawn(move || {
            second_started_tx
                .send(())
                .expect("test should observe second initializer");
            ensure_initialized_with(&second_state, || {
                panic!("second initializer must not run");
            })
        });
        second_started_rx
            .recv()
            .expect("second initializer should attempt initialization");
        release_first_tx
            .send(())
            .expect("first initializer should still be waiting");

        first
            .join()
            .expect("first initializer thread should finish")
            .expect("first initialization should succeed");
        second
            .join()
            .expect("second initializer thread should finish")
            .expect("second initialization should reuse committed state");
        assert_eq!(
            state
                .committed_snapshot()
                .expect("settings should be initialized")
                .language,
            "first"
        );
    }

    #[test]
    fn failed_initialization_remains_retryable() {
        let state = SettingsState::new_uninitialized();
        assert_eq!(
            ensure_initialized_with(&state, || Err("read failed".to_owned())),
            Err("read failed".to_owned())
        );
        assert!(state.committed_snapshot().is_none());

        let recovered = AppSettings {
            language: "recovered".to_owned(),
            ..AppSettings::default()
        };
        ensure_initialized_with(&state, || Ok(recovered))
            .expect("a later initialization attempt should succeed");
        assert_eq!(
            state
                .committed_snapshot()
                .expect("successful retry should publish settings")
                .language,
            "recovered"
        );
    }

    #[test]
    fn disjoint_transactions_do_not_lose_updates() {
        let state = Arc::new(SettingsState::new_uninitialized());
        state.publish(AppSettings::default());
        let (first_ready_tx, first_ready_rx) = mpsc::sync_channel(0);
        let (release_first_tx, release_first_rx) = mpsc::sync_channel(0);

        let first_state = Arc::clone(&state);
        let first = thread::spawn(move || {
            let mut transaction = first_state
                .begin_transaction()
                .expect("initialized state should start a transaction");
            transaction
                .candidate_mut()
                .workspace_names
                .insert("workspace".to_owned(), "Visible name".to_owned());
            first_ready_tx
                .send(())
                .expect("test should observe first writer");
            release_first_rx
                .recv()
                .expect("test should release first writer");
            transaction.commit();
        });
        first_ready_rx
            .recv()
            .expect("first writer should hold gate");

        let (second_started_tx, second_started_rx) = mpsc::sync_channel(0);
        let second_state = Arc::clone(&state);
        let second = thread::spawn(move || {
            second_started_tx
                .send(())
                .expect("test should observe second writer");
            let mut transaction = second_state
                .begin_transaction()
                .expect("initialized state should start a transaction");
            transaction
                .candidate_mut()
                .hidden_workspaces
                .push("hidden".to_owned());
            transaction.commit();
        });
        second_started_rx
            .recv()
            .expect("second writer should start");
        release_first_tx
            .send(())
            .expect("first writer should still be waiting");
        first.join().expect("first writer should finish");
        second.join().expect("second writer should finish");

        let committed = state
            .committed_snapshot()
            .expect("transactions should preserve initialized state");
        assert_eq!(
            committed
                .workspace_names
                .get("workspace")
                .map(String::as_str),
            Some("Visible name")
        );
        assert_eq!(committed.hidden_workspaces, ["hidden"]);
    }

    #[test]
    fn conflicting_transactions_are_serializable() {
        let state = Arc::new(SettingsState::new_uninitialized());
        state.publish(AppSettings::default());
        let (first_ready_tx, first_ready_rx) = mpsc::sync_channel(0);
        let (release_first_tx, release_first_rx) = mpsc::sync_channel(0);

        let first_state = Arc::clone(&state);
        let first = thread::spawn(move || {
            let mut transaction = first_state
                .begin_transaction()
                .expect("initialized state should start a transaction");
            transaction.candidate_mut().language = "first".to_owned();
            first_ready_tx
                .send(())
                .expect("test should observe first writer");
            release_first_rx
                .recv()
                .expect("test should release first writer");
            transaction.commit();
        });
        first_ready_rx
            .recv()
            .expect("first writer should hold gate");

        let (second_started_tx, second_started_rx) = mpsc::sync_channel(0);
        let second_state = Arc::clone(&state);
        let second = thread::spawn(move || {
            second_started_tx
                .send(())
                .expect("test should observe second writer");
            let mut transaction = second_state
                .begin_transaction()
                .expect("initialized state should start a transaction");
            assert_eq!(transaction.previous().language, "first");
            transaction.candidate_mut().language = "second".to_owned();
            transaction.commit();
        });
        second_started_rx
            .recv()
            .expect("second writer should start");
        release_first_tx
            .send(())
            .expect("first writer should still be waiting");
        first.join().expect("first writer should finish");
        second.join().expect("second writer should finish");
        assert_eq!(
            state
                .committed_snapshot()
                .expect("transactions should preserve initialized state")
                .language,
            "second"
        );
    }

    #[test]
    fn initialized_reader_does_not_wait_for_writer_gate() {
        let state = Arc::new(SettingsState::new_uninitialized());
        let previous = AppSettings {
            language: "previous".to_owned(),
            ..AppSettings::default()
        };
        state.publish(previous);
        let (writer_ready_tx, writer_ready_rx) = mpsc::sync_channel(0);
        let (release_writer_tx, release_writer_rx) = mpsc::sync_channel(0);

        let writer_state = Arc::clone(&state);
        let writer = thread::spawn(move || {
            let mut transaction = writer_state
                .begin_transaction()
                .expect("initialized state should start a transaction");
            transaction.candidate_mut().language = "next".to_owned();
            writer_ready_tx
                .send(())
                .expect("test should observe stalled writer");
            release_writer_rx
                .recv()
                .expect("test should release stalled writer");
            transaction.commit();
        });
        writer_ready_rx
            .recv()
            .expect("writer should hold mutation gate");

        let (reader_tx, reader_rx) = mpsc::sync_channel(0);
        let reader_state = Arc::clone(&state);
        let reader = thread::spawn(move || {
            reader_tx
                .send(reader_state.committed_snapshot())
                .expect("test should receive reader snapshot");
        });
        let snapshot = match reader_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(snapshot) => snapshot.expect("initialized reader should return settings"),
            Err(error) => {
                release_writer_tx
                    .send(())
                    .expect("writer should still be waiting");
                writer.join().expect("writer should finish after release");
                reader.join().expect("reader should finish after release");
                panic!("reader waited for settings mutation gate: {error}");
            }
        };
        assert_eq!(snapshot.language, "previous");
        release_writer_tx
            .send(())
            .expect("writer should still be waiting");
        writer.join().expect("writer should finish");
        reader.join().expect("reader should finish");
        assert_eq!(
            state
                .committed_snapshot()
                .expect("writer should publish candidate")
                .language,
            "next"
        );
    }

    #[test]
    fn failed_transaction_never_publishes_candidate() {
        let state = Arc::new(SettingsState::new_uninitialized());
        let previous = AppSettings {
            language: "previous".to_owned(),
            ..AppSettings::default()
        };
        state.publish(previous);
        let (candidate_ready_tx, candidate_ready_rx) = mpsc::sync_channel(0);
        let (release_failure_tx, release_failure_rx) = mpsc::sync_channel(0);

        let writer_state = Arc::clone(&state);
        let writer = thread::spawn(move || {
            let mut transaction = writer_state
                .begin_transaction()
                .expect("initialized state should start a transaction");
            transaction.candidate_mut().language = "uncommitted".to_owned();
            candidate_ready_tx
                .send(())
                .expect("test should observe private candidate");
            release_failure_rx
                .recv()
                .expect("test should release failed writer");
            drop(transaction);
        });
        candidate_ready_rx
            .recv()
            .expect("writer should hold an uncommitted candidate");
        assert_eq!(
            state
                .committed_snapshot()
                .expect("reader should keep seeing committed settings")
                .language,
            "previous"
        );
        release_failure_tx
            .send(())
            .expect("writer should still be waiting");
        writer.join().expect("failed writer should finish");
        assert_eq!(
            state
                .committed_snapshot()
                .expect("failed candidate must not uninitialize state")
                .language,
            "previous"
        );
    }

    #[test]
    fn invalid_recovery_preserves_source_until_restored_snapshot_is_durable() {
        let root = settings_fixture("invalid-recovery");
        let path = root.join("settings.json");
        let original = br#"{"language":"ru","providerEnvKeys":["OPENAI_API_KEY"]"#;
        fs::create_dir_all(&root).expect("fixture directory should be writable");
        fs::write(&path, original).expect("invalid settings fixture should be writable");

        let (defaults, backup) = recover_invalid_settings_with(
            &path,
            "injected parse failure",
            crate::sessions::atomic_write_private_file,
        )
        .expect("recovery backup should be durable");
        assert_eq!(
            fs::read(&path).expect("source should remain readable"),
            original
        );
        assert_eq!(
            fs::read(&backup).expect("backup should remain readable"),
            original
        );

        save_settings_to_path(&path, &defaults).expect("restored defaults should be durable");
        let persisted = fs::read_to_string(&path).expect("restored settings should be readable");
        serde_json::from_str::<AppSettings>(&persisted)
            .expect("restored settings should be valid JSON");
        assert_eq!(
            fs::read(&backup).expect("recovery backup should remain byte-identical"),
            original
        );
        fs::remove_dir_all(root).expect("fixture directory should be removable");
    }

    #[test]
    fn malformed_settings_recover_safe_fields_without_secret_values() {
        let root = settings_fixture("partial-recovery");
        let path = root.join("settings.json");
        fs::create_dir_all(&root).expect("partial recovery directory should be writable");
        let original = br#"{
          "ompExecutable": "omp-custom",
          "sessionRoot": "C:/private/sessions",
          "recentWorkspaces": ["C:/work/project"],
          "workspaceNames": {"C:/work/project": "Project"},
          "hiddenWorkspaces": ["C:/work/hidden"],
          "sessionTitlePins": {"C:/private/sessions/a.jsonl": "Pinned"},
          "primaryProviderPins": ["C:/private/sessions/a.jsonl"],
          "brokenField": not-json,
          "providerEnvKeys": ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
          "providerEnv": {"OPENAI_API_KEY": "must-never-be-recovered"}
        "#;
        fs::write(&path, original).expect("partial settings fixture should be writable");

        let (recovered, backup) = recover_invalid_settings_with(
            &path,
            "partial parse failure",
            crate::sessions::atomic_write_private_file,
        )
        .expect("partial recovery should preserve the source");

        assert_eq!(recovered.omp_executable.as_deref(), Some("omp-custom"));
        assert_eq!(
            recovered.session_root.as_deref(),
            Some("C:/private/sessions")
        );
        assert_eq!(recovered.recent_workspaces, ["C:/work/project"]);
        assert_eq!(
            recovered.workspace_names.get("C:/work/project"),
            Some(&"Project".to_owned())
        );
        assert_eq!(recovered.hidden_workspaces, ["C:/work/hidden"]);
        let session_key = crate::sessions::path_key("C:/private/sessions/a.jsonl");
        assert_eq!(
            recovered.session_title_pins.get(&session_key),
            Some(&"Pinned".to_owned())
        );
        assert!(recovered.primary_provider_pins.contains(&session_key));
        assert_eq!(
            recovered.provider_env_keys,
            ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
        );
        assert!(recovered.provider_env.is_empty());
        assert_eq!(
            recovered
                .settings_warning
                .as_ref()
                .map(|warning| warning.code.as_str()),
            Some("settings_recovered")
        );
        assert_eq!(
            fs::read(&backup).expect("backup should be readable"),
            original
        );
        fs::remove_dir_all(root).expect("partial recovery fixture should be removable");
    }

    #[test]
    fn failed_recovery_backup_never_replaces_invalid_source() {
        let root = settings_fixture("failed-recovery-backup");
        let path = root.join("settings.json");
        let original = b"{ invalid settings";
        fs::create_dir_all(&root).expect("fixture directory should be writable");
        fs::write(&path, original).expect("invalid settings fixture should be writable");

        let result = recover_invalid_settings_with(&path, "parse failed", |_backup, _contents| {
            Err("injected backup failure".to_owned())
        });
        assert!(result.is_err());
        assert_eq!(
            fs::read(&path).expect("source should remain readable"),
            original
        );
        assert_eq!(
            fs::read_dir(&root)
                .expect("fixture directory should be readable")
                .count(),
            1
        );
        fs::remove_dir_all(root).expect("fixture directory should be removable");
    }

    #[test]
    fn explicit_defaults_preserve_byte_identical_backup() {
        let root = settings_fixture("explicit-defaults");
        let path = root.join("settings.json");
        let original = b"source settings bytes\r\nwith non-json data\0";
        fs::create_dir_all(&root).expect("fixture directory should be writable");
        fs::write(&path, original).expect("source settings fixture should be writable");

        let defaults =
            start_with_defaults_at_with(&path, crate::sessions::atomic_write_private_file)
                .expect("explicit defaults should succeed after backup");
        let backup = PathBuf::from(
            defaults
                .settings_warning
                .as_ref()
                .and_then(|warning| warning.details.as_ref())
                .expect("successful recovery should report its backup"),
        );
        assert_eq!(
            fs::read(&backup).expect("backup should remain readable"),
            original
        );
        let persisted = fs::read_to_string(&path).expect("defaults should be readable");
        let persisted = serde_json::from_str::<AppSettings>(&persisted)
            .expect("defaults should be valid settings JSON");
        assert!(persisted.settings_warning.is_none());
        fs::remove_dir_all(root).expect("fixture directory should be removable");
    }

    #[test]
    fn failed_defaults_write_keeps_source_and_completed_backup() {
        let root = settings_fixture("failed-defaults-write");
        let path = root.join("settings.json");
        let original = b"original settings bytes";
        fs::create_dir_all(&root).expect("fixture directory should be writable");
        fs::write(&path, original).expect("source settings fixture should be writable");
        let mut writes = 0;

        let result = start_with_defaults_at_with(&path, |destination, contents| {
            writes += 1;
            if writes == 1 {
                crate::sessions::atomic_write_private_file(destination, contents)
            } else {
                Err("injected defaults write failure".to_owned())
            }
        });
        assert!(result.is_err());
        assert_eq!(
            fs::read(&path).expect("source should remain readable"),
            original
        );
        let backups = fs::read_dir(&root)
            .expect("fixture directory should be readable")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|candidate| {
                candidate
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("settings.backup-"))
            })
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            fs::read(&backups[0]).expect("completed backup should remain readable"),
            original
        );
        fs::remove_dir_all(root).expect("fixture directory should be removable");
    }
}
