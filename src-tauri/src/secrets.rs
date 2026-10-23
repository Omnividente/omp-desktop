use crate::{
    diagnostics,
    sessions::{atomic_write_private_file, harden_private_directory, harden_private_file},
};
use keyring::v1::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, LazyLock, Mutex},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "com.ompdesk.desktop";
pub const FALLBACK_WARNING: &str = "fallback_file";
const KEYRING_TIMEOUT: Duration = Duration::from_secs(5);

pub const UNAVAILABLE_WARNING: &str = "unavailable";
pub const PENDING_DELETION_WARNING: &str = "pending_deletion";

#[derive(Debug)]
pub struct LoadedSecrets {
    pub values: HashMap<String, String>,
    pub keys: Vec<String>,
    pub warning: Option<String>,
    pub migrated: bool,
}
// `keys: None` is the old, merge-only fallback format. A key set (including an
// empty set) makes this a complete authoritative snapshot, not a seed to merge.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
struct FallbackSecrets {
    #[serde(default)]
    values: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    keys: Option<BTreeSet<String>>,
    #[serde(default)]
    pending_deletions: BTreeSet<String>,
}

impl FallbackSecrets {
    fn is_empty_snapshot(&self) -> bool {
        self.values.is_empty() && self.keys.as_ref().is_some_and(BTreeSet::is_empty)
    }

    fn is_clean_tombstone(&self) -> bool {
        self.is_empty_snapshot() && self.pending_deletions.is_empty()
    }

    fn warning(&self) -> String {
        if !self.pending_deletions.is_empty() {
            PENDING_DELETION_WARNING.to_owned()
        } else if self.values.is_empty() {
            UNAVAILABLE_WARNING.to_owned()
        } else {
            FALLBACK_WARNING.to_owned()
        }
    }

    fn loaded(self, warning: Option<String>, migrated: bool) -> LoadedSecrets {
        LoadedSecrets {
            keys: self.keys.unwrap_or_default().into_iter().collect(),
            values: self.values.into_iter().collect(),
            warning,
            migrated,
        }
    }
}

pub fn load_provider_secrets(
    app: &AppHandle,
    configured_keys: &[String],
    legacy_values: HashMap<String, String>,
) -> Result<LoadedSecrets, String> {
    load_from_path(
        coordinator(),
        &fallback_path(app)?,
        configured_keys,
        legacy_values,
        KEYRING_TIMEOUT,
    )
}

fn load_from_path(
    coordinator: &Arc<KeyringCoordinator>,
    path: &Path,
    configured_keys: &[String],
    legacy_values: HashMap<String, String>,
    timeout: Duration,
) -> Result<LoadedSecrets, String> {
    let mut stored = coordinator.read_recovery(path)?;
    if stored.as_ref().is_some_and(|stored| stored.keys.is_some()) {
        // In particular, never merge old configured/legacy keys into a deletion
        // tombstone. Restart must not resurrect a key still present in the OS.
        let stored = stored.take().expect("authoritative snapshot exists");
        if stored.is_clean_tombstone() {
            let migrated = !configured_keys.is_empty() || !legacy_values.is_empty();
            return Ok(stored.loaded(None, migrated));
        }
        let outcome = coordinator.recover(path, &stored, timeout);
        return Ok(loaded_after_reconciliation(stored, outcome, true));
    }

    let fallback_existed = stored.is_some();
    let legacy_existed = !legacy_values.is_empty();
    let mut seed = stored.unwrap_or_default().values;
    seed.extend(legacy_values);
    let mut keys = configured_keys.iter().cloned().collect::<BTreeSet<_>>();
    keys.extend(seed.keys().cloned());
    if fallback_existed || legacy_existed {
        let stored = FallbackSecrets {
            values: seed,
            keys: Some(keys),
            pending_deletions: BTreeSet::new(),
        };
        let (stored, outcome) = coordinator.store(path, &[], stored, false, timeout)?;
        return Ok(loaded_after_reconciliation(stored, outcome, true));
    }
    if keys.is_empty() {
        return Ok(FallbackSecrets::default().loaded(None, false));
    }
    let result = coordinator.read_keys(keys.clone(), timeout);
    let (values, warning) = match result {
        Ok(values) => (values, None),
        Err(error) => {
            diagnostics::warn("keyring.read", &error);
            (BTreeMap::new(), Some(UNAVAILABLE_WARNING.to_owned()))
        }
    };
    Ok(FallbackSecrets {
        values,
        keys: Some(keys),
        pending_deletions: BTreeSet::new(),
    }
    .loaded(warning, false))
}

pub fn update_provider_secrets(
    app: &AppHandle,
    current: &HashMap<String, String>,
    configured_keys: &[String],
    requested: HashMap<String, String>,
) -> Result<LoadedSecrets, String> {
    let (next, next_keys) = merge_requested_secrets(current, requested);
    let unchanged = next
        .iter()
        .all(|(key, value)| current.get(key) == Some(value))
        && next.len() == current.len()
        && configured_keys.iter().cloned().collect::<BTreeSet<_>>() == next_keys;
    store_provider_secrets(app, configured_keys, next, next_keys, unchanged)
}

pub fn replace_provider_secrets(
    app: &AppHandle,
    current_keys: &[String],
    values: &HashMap<String, String>,
    configured_keys: &[String],
) -> Result<LoadedSecrets, String> {
    let next = values
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut next_keys = configured_keys.iter().cloned().collect::<BTreeSet<_>>();
    next_keys.extend(next.keys().cloned());
    store_provider_secrets(app, current_keys, next, next_keys, false)
}

fn store_provider_secrets(
    app: &AppHandle,
    current_keys: &[String],
    next: BTreeMap<String, String>,
    next_keys: BTreeSet<String>,
    unchanged: bool,
) -> Result<LoadedSecrets, String> {
    let stored = FallbackSecrets {
        values: next,
        keys: Some(next_keys),
        pending_deletions: BTreeSet::new(),
    };
    let (stored, outcome) = coordinator().store(
        &fallback_path(app)?,
        current_keys,
        stored,
        unchanged,
        KEYRING_TIMEOUT,
    )?;
    Ok(loaded_after_reconciliation(stored, outcome, false))
}

fn loaded_after_reconciliation(
    mut stored: FallbackSecrets,
    outcome: Result<BTreeMap<String, String>, String>,
    migrated: bool,
) -> LoadedSecrets {
    let warning = match outcome {
        Ok(values) => {
            stored.values.extend(values);
            None
        }
        Err(error) => {
            diagnostics::warn("keyring.reconcile", &error);
            Some(stored.warning())
        }
    };
    stored.loaded(warning, migrated)
}

trait SecretBackend: Send + Sync {
    fn read(&self, key: &str) -> Result<Option<String>, String>;
    fn write(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

struct NativeKeyring;

impl SecretBackend for NativeKeyring {
    fn read(&self, key: &str) -> Result<Option<String>, String> {
        read_keyring(key)
    }

    fn write(&self, key: &str, value: &str) -> Result<(), String> {
        entry(key)?.set_password(value).map_err(|error| {
            format!("Не удалось сохранить credential `{key}` в системном хранилище: {error}")
        })
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        match entry(key)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(format!(
                "Не удалось удалить credential `{key}` из системного хранилища: {error}"
            )),
        }
    }
}

struct PendingSecrets {
    revision: u64,
    path: PathBuf,
    stored: FallbackSecrets,
    preparation_warning: Option<String>,
}

type KeyringValuesResult = Result<BTreeMap<String, String>, String>;

#[derive(Default)]
struct WorkerState {
    running: bool,
    revision: u64,
    latest: Option<Arc<PendingSecrets>>,
}

struct KeyringCoordinator {
    state: Mutex<WorkerState>,
    backend: Arc<dyn SecretBackend>,
}

fn coordinator() -> &'static Arc<KeyringCoordinator> {
    static COORDINATOR: LazyLock<Arc<KeyringCoordinator>> =
        LazyLock::new(|| KeyringCoordinator::new(Arc::new(NativeKeyring)));
    &COORDINATOR
}

impl KeyringCoordinator {
    fn new(backend: Arc<dyn SecretBackend>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(WorkerState::default()),
            backend,
        })
    }

    fn read_recovery(&self, path: &Path) -> Result<Option<FallbackSecrets>, String> {
        let _state = self
            .state
            .lock()
            .map_err(|_| "Хранилище credentials занято ошибкой")?;
        read_fallback(path)
    }

    // All fallible durable preparation happens before publishing a job, hence
    // Err cannot leave this operation's partial native mutation behind an early ?.
    fn store(
        self: &Arc<Self>,
        path: &Path,
        current_keys: &[String],
        stored: FallbackSecrets,
        unchanged: bool,
        timeout: Duration,
    ) -> Result<(FallbackSecrets, KeyringValuesResult), String> {
        self.store_with_write(
            path,
            current_keys,
            stored,
            unchanged,
            timeout,
            write_fallback,
        )
    }

    fn store_with_write<F>(
        self: &Arc<Self>,
        path: &Path,
        current_keys: &[String],
        mut stored: FallbackSecrets,
        unchanged: bool,
        timeout: Duration,
        write: F,
    ) -> Result<(FallbackSecrets, KeyringValuesResult), String>
    where
        F: FnOnce(&Path, &FallbackSecrets) -> Result<(), String>,
    {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Хранилище credentials занято ошибкой")?;
        let previous = read_fallback(path)?;
        let same = |previous: &FallbackSecrets| {
            previous.values == stored.values && previous.keys == stored.keys
        };
        if unchanged
            && previous.as_ref().is_none_or(same)
            && state
                .latest
                .as_ref()
                .is_none_or(|pending| same(&pending.stored))
        {
            // Placeholder-only saves must not wait for or retry a broken OS store.
            return Ok(match previous {
                Some(previous) if previous.is_clean_tombstone() => (previous, Ok(BTreeMap::new())),
                Some(previous) => (
                    previous,
                    Err("Credentials ожидают системного хранилища".to_owned()),
                ),
                None => (stored, Ok(BTreeMap::new())),
            });
        }
        let keys = stored.keys.as_ref().expect("complete desired snapshot");
        stored.pending_deletions.extend(
            current_keys
                .iter()
                .filter(|key| !keys.contains(*key))
                .cloned(),
        );
        for previous in previous
            .iter()
            .chain(state.latest.iter().map(|pending| &pending.stored))
        {
            stored
                .pending_deletions
                .extend(previous.pending_deletions.iter().cloned());
            if let Some(previous_keys) = previous.keys.as_ref() {
                stored.pending_deletions.extend(
                    previous_keys
                        .iter()
                        .filter(|key| !keys.contains(*key))
                        .cloned(),
                );
            } else {
                stored.pending_deletions.extend(
                    previous
                        .values
                        .keys()
                        .filter(|key| !keys.contains(*key))
                        .cloned(),
                );
            }
        }
        // A key removed by an older snapshot may have been explicitly re-added.
        stored.pending_deletions.retain(|key| !keys.contains(key));
        let preparation_warning = match write(path, &stored) {
            Ok(()) => None,
            Err(error) => {
                // The atomic helper can report directory-sync failure after rename.
                // A visible complete new journal is accepted recovery, not a
                // failed-before-write result that the caller could safely ignore.
                if read_fallback(path).ok().flatten().as_ref() != Some(&stored) {
                    return Err(error);
                }
                Some(error)
            }
        };
        let receiver = self.publish(&mut state, path, &stored, preparation_warning);
        drop(state);
        let outcome = receive_reconciliation(receiver, timeout);
        Ok((stored, outcome))
    }

    fn recover(
        self: &Arc<Self>,
        path: &Path,
        stored: &FallbackSecrets,
        timeout: Duration,
    ) -> Result<BTreeMap<String, String>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Хранилище credentials занято ошибкой")?;
        // Do not overwrite a newer job from a concurrently read snapshot.
        if state.running {
            return Err("Credentials ожидают завершения системного хранилища".to_owned());
        }
        if read_fallback(path)?.as_ref() != Some(stored) {
            return Err("Резервное состояние credentials уже заменено".to_owned());
        }
        let receiver = self.publish(&mut state, path, stored, None);
        drop(state);
        receive_reconciliation(receiver, timeout)
    }

    fn publish(
        self: &Arc<Self>,
        state: &mut WorkerState,
        path: &Path,
        stored: &FallbackSecrets,
        preparation_warning: Option<String>,
    ) -> Result<mpsc::Receiver<KeyringValuesResult>, String> {
        state.revision += 1;
        let pending = Arc::new(PendingSecrets {
            revision: state.revision,
            path: path.to_owned(),
            stored: stored.clone(),
            preparation_warning,
        });
        state.latest = Some(Arc::clone(&pending));
        if state.running {
            // One coalesced desired snapshot, never one queued thread per save.
            return Err("Credentials ожидают завершения системного хранилища".to_owned());
        }
        state.running = true;
        let (sender, receiver) = mpsc::sync_channel(1);
        let coordinator = Arc::clone(self);
        if let Err(error) = thread::Builder::new()
            .name("omp-keyring".to_owned())
            .spawn(move || {
                coordinator.drain(Some((pending, sender)));
            })
        {
            state.running = false;
            return Err(format!(
                "Не удалось запустить обновление credentials: {error}"
            ));
        }
        Ok(receiver)
    }

    // No state mutex is held across a noncancelable OS call. Only this single
    // worker calls the backend. B can commit its journal while A is blocked;
    // once A returns, B is applied *after* A, before native quiescence.
    fn drain(
        &self,
        mut first: Option<(Arc<PendingSecrets>, mpsc::SyncSender<KeyringValuesResult>)>,
    ) {
        loop {
            let (pending, response) = if let Some((pending, sender)) = first.take() {
                (pending, Some(sender))
            } else {
                let Ok(mut state) = self.state.lock() else {
                    return;
                };
                let Some(pending) = state.latest.clone() else {
                    state.running = false;
                    return;
                };
                (pending, None)
            };
            let mut outcome = self.apply(&pending.stored);
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            let current =
                state.latest.as_ref().map(|latest| latest.revision) == Some(pending.revision);
            if current {
                if outcome.is_ok() {
                    if let Some(error) = pending.preparation_warning.as_ref() {
                        // Keep the visible journal after a post-replace sync
                        // failure. The caller gets accepted state + truthful
                        // recovery warning, even when native mutation succeeded.
                        outcome = Err(error.clone());
                    } else {
                        let cleanup = if pending.stored.is_empty_snapshot() {
                            // A non-secret deletion marker must outlive stale
                            // settings/legacy seeds, even after OS confirmation.
                            let clean = FallbackSecrets {
                                keys: Some(BTreeSet::new()),
                                ..FallbackSecrets::default()
                            };
                            write_fallback(&pending.path, &clean)
                        } else {
                            remove_fallback(&pending.path)
                        };
                        if let Err(error) = cleanup {
                            // Native success with failed journal cleanup is still
                            // accepted desired state, not unsafe Err to caller.
                            outcome = Err(error);
                        }
                    }
                }
                state.latest = None;
                state.running = false;
            } else {
                // An old result cannot clear or replace the newer authority.
                outcome = Err("Применяется более новое состояние credentials".to_owned());
            }
            if let Some(sender) = response {
                let _ = sender.send(outcome);
            }
            if current {
                return;
            }
        }
    }

    fn apply(&self, stored: &FallbackSecrets) -> Result<BTreeMap<String, String>, String> {
        for (key, value) in &stored.values {
            self.backend.write(key, value)?;
        }
        for key in &stored.pending_deletions {
            self.backend.delete(key)?;
        }
        let mut values = BTreeMap::new();
        // Blank placeholders preserve existing OS values without deleting them.
        for key in stored.keys.iter().flatten() {
            if !stored.values.contains_key(key) {
                if let Some(value) = self.backend.read(key)? {
                    values.insert(key.clone(), value);
                }
            }
        }
        Ok(values)
    }

    fn read_keys(
        self: &Arc<Self>,
        keys: BTreeSet<String>,
        timeout: Duration,
    ) -> Result<BTreeMap<String, String>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Хранилище credentials занято ошибкой")?;
        if state.running {
            return Err("Credentials ожидают завершения системного хранилища".to_owned());
        }
        state.running = true;
        let (sender, receiver) = mpsc::sync_channel(1);
        let coordinator = Arc::clone(self);
        if let Err(error) = thread::Builder::new()
            .name("omp-keyring".to_owned())
            .spawn(move || {
                let result = (|| {
                    let mut values = BTreeMap::new();
                    for key in keys {
                        if let Some(value) = coordinator.backend.read(&key)? {
                            values.insert(key, value);
                        }
                    }
                    Ok(values)
                })();
                let _ = sender.send(result);
                coordinator.drain(None);
            })
        {
            state.running = false;
            return Err(format!("Не удалось запустить чтение credentials: {error}"));
        }
        drop(state);
        receive_reconciliation(Ok(receiver), timeout)
    }
}

fn receive_reconciliation(
    receiver: Result<mpsc::Receiver<KeyringValuesResult>, String>,
    timeout: Duration,
) -> Result<BTreeMap<String, String>, String> {
    match receiver?.recv_timeout(timeout) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => Err(format!(
            "Операция credentials превысила таймаут {} мс",
            timeout.as_millis()
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("Операция credentials завершилась без результата".to_owned())
        }
    }
}

fn merge_requested_secrets(
    current: &HashMap<String, String>,
    requested: HashMap<String, String>,
) -> (BTreeMap<String, String>, BTreeSet<String>) {
    let mut values = BTreeMap::new();
    let mut keys = BTreeSet::new();
    for (raw_key, value) in requested {
        let key = raw_key.trim().to_owned();
        if key.is_empty() {
            continue;
        }
        keys.insert(key.clone());
        if value.trim().is_empty() {
            if let Some(existing) = current.get(&key) {
                values.insert(key, existing.clone());
            }
        } else {
            values.insert(key, value);
        }
    }
    (values, keys)
}

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, key)
        .map_err(|error| format!("Системное хранилище недоступно для `{key}`: {error}"))
}

fn read_keyring(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Не удалось прочитать credential `{key}` из системного хранилища: {error}"
        )),
    }
}

fn fallback_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Не удалось определить папку настроек: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Не удалось создать {}: {error}", directory.display()))?;
    harden_private_directory(&directory).map_err(|error| {
        format!(
            "Не удалось ограничить права каталога {}: {error}",
            directory.display()
        )
    })?;
    Ok(directory.join("provider-secrets.json"))
}

fn read_fallback(path: &Path) -> Result<Option<FallbackSecrets>, String> {
    match fs::metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Не удалось проверить резервное хранилище: {error}")),
    }
    set_private_permissions(path)?;
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Не удалось прочитать резервное хранилище: {error}"))?;
    serde_json::from_str(&contents)
        .map(Some)
        .map_err(|error| format!("Резервное хранилище повреждено: {error}"))
}

fn write_fallback(path: &Path, stored: &FallbackSecrets) -> Result<(), String> {
    // Empty authoritative snapshots are deletion tombstones, not absent files.
    let contents = serde_json::to_vec(stored)
        .map_err(|error| format!("Не удалось подготовить резервное хранилище: {error}"))?;
    atomic_write_private_file(path, &contents)
}

fn remove_fallback(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Не удалось удалить резервное хранилище: {error}")),
    }
}

pub fn set_private_permissions(path: &Path) -> Result<(), String> {
    harden_private_file(path)
        .map_err(|error| format!("Не удалось ограничить права {}: {error}", path.display()))
}

pub fn set_private_directory_permissions(path: &Path) -> Result<(), String> {
    harden_private_directory(path)
        .map_err(|error| format!("Не удалось ограничить права {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
        time::{Instant, SystemTime, UNIX_EPOCH},
    };

    const TEST_TIMEOUT: Duration = Duration::from_secs(3);

    // Inspect synthetic fixture state even after a worker assertion poisoned it.
    // Production locks deliberately propagate poison instead of unwrapping it.
    fn test_lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        match mutex.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    #[derive(Default)]
    struct FakeBackend {
        values: Mutex<BTreeMap<String, String>>,
        writes: AtomicUsize,
        reads: AtomicUsize,
        deletes: AtomicUsize,
        unavailable: AtomicBool,
        fail_write: AtomicUsize,
        recovery_writable: AtomicBool,
        before_write: Mutex<Option<(mpsc::SyncSender<()>, mpsc::Receiver<()>)>>,
    }

    impl SecretBackend for FakeBackend {
        fn read(&self, key: &str) -> Result<Option<String>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if self.unavailable.load(Ordering::SeqCst) {
                return Err("synthetic unavailable".to_owned());
            }
            Ok(test_lock(&self.values).get(key).cloned())
        }

        fn write(&self, key: &str, value: &str) -> Result<(), String> {
            let call = self.writes.fetch_add(1, Ordering::SeqCst) + 1;
            let barrier = test_lock(&self.before_write).take();
            if let Some((entered, release)) = barrier {
                entered.send(()).unwrap();
                release.recv_timeout(Duration::from_secs(10)).unwrap();
            }
            if self.unavailable.load(Ordering::SeqCst)
                || self.fail_write.load(Ordering::SeqCst) == call
            {
                self.recovery_writable.store(false, Ordering::SeqCst);
                return Err("synthetic write failure".to_owned());
            }
            test_lock(&self.values).insert(key.to_owned(), value.to_owned());
            Ok(())
        }

        fn delete(&self, key: &str) -> Result<(), String> {
            self.deletes.fetch_add(1, Ordering::SeqCst);
            if self.unavailable.load(Ordering::SeqCst) {
                return Err("synthetic deletion failure".to_owned());
            }
            test_lock(&self.values).remove(key);
            Ok(())
        }
    }

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "omp-synthetic-secrets-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }

        fn path(&self) -> PathBuf {
            self.0.join("provider-secrets.json")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn snapshot(entries: &[(&str, &str)]) -> FallbackSecrets {
        let values = entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect::<BTreeMap<_, _>>();
        FallbackSecrets {
            keys: Some(values.keys().cloned().collect()),
            values,
            pending_deletions: BTreeSet::new(),
        }
    }

    fn wait_idle(coordinator: &KeyringCoordinator) {
        let deadline = Instant::now() + TEST_TIMEOUT;
        while test_lock(&coordinator.state).running {
            assert!(
                Instant::now() < deadline,
                "synthetic worker did not quiesce"
            );
            thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn last_fallback_deletion_stays_deleted_on_restart_with_unavailable_keyring() {
        let fixture = Fixture::new();
        let path = fixture.path();
        let backend = Arc::new(FakeBackend::default());
        backend.unavailable.store(true, Ordering::SeqCst);
        let coordinator = KeyringCoordinator::new(backend.clone());
        // Exercise compatibility with the old merge-only fallback format.
        let old = FallbackSecrets {
            keys: None,
            ..snapshot(&[("SYNTH_LAST", "synthetic-old")])
        };
        write_fallback(&path, &old).unwrap();
        let (stored, outcome) = coordinator
            .store(
                &path,
                &["SYNTH_LAST".to_owned()],
                snapshot(&[]),
                false,
                TEST_TIMEOUT,
            )
            .unwrap();
        let deleted = loaded_after_reconciliation(stored, outcome, false);
        assert!(deleted.values.is_empty());
        assert!(deleted.keys.is_empty());
        assert_eq!(deleted.warning.as_deref(), Some(PENDING_DELETION_WARNING));
        let durable = read_fallback(&path).unwrap().unwrap();
        assert!(durable.values.is_empty());
        assert_eq!(durable.keys, Some(BTreeSet::new()));
        assert!(durable.pending_deletions.contains("SYNTH_LAST"));

        let restarted = KeyringCoordinator::new(backend.clone());
        let loaded = load_from_path(
            &restarted,
            &path,
            &["SYNTH_LAST".to_owned()],
            HashMap::from([("SYNTH_LAST".to_owned(), "synthetic-legacy".to_owned())]),
            TEST_TIMEOUT,
        )
        .unwrap();
        assert!(loaded.values.is_empty());
        assert!(loaded.keys.is_empty());
        assert_eq!(loaded.warning.as_deref(), Some(PENDING_DELETION_WARNING));
        backend.unavailable.store(false, Ordering::SeqCst);
        let confirmed =
            load_from_path(&restarted, &path, &[], HashMap::new(), TEST_TIMEOUT).unwrap();
        assert!(confirmed.values.is_empty());
        assert!(confirmed.keys.is_empty());
        assert!(confirmed.warning.is_none());
        assert!(test_lock(&backend.values).is_empty());
        assert!(read_fallback(&path).unwrap().unwrap().is_clean_tombstone());
        backend.unavailable.store(true, Ordering::SeqCst);
        let deletes = backend.deletes.load(Ordering::SeqCst);
        let clean_restart = load_from_path(
            &restarted,
            &path,
            &["SYNTH_LAST".to_owned()],
            HashMap::from([("SYNTH_LAST".to_owned(), "synthetic-stale".to_owned())]),
            TEST_TIMEOUT,
        )
        .unwrap();
        assert!(clean_restart.values.is_empty());
        assert!(clean_restart.keys.is_empty());
        assert!(clean_restart.warning.is_none());
        assert_eq!(backend.deletes.load(Ordering::SeqCst), deletes);
    }

    #[test]
    fn first_write_second_failure_and_later_fallback_denial_keep_authority_for_restart() {
        let fixture = Fixture::new();
        let path = fixture.path();
        let backend = Arc::new(FakeBackend::default());
        let before = snapshot(&[("SYNTH_A", "old-a"), ("SYNTH_B", "old-b")]);
        *test_lock(&backend.values) = before.values.clone();
        backend.fail_write.store(2, Ordering::SeqCst);
        backend.recovery_writable.store(true, Ordering::SeqCst);
        let coordinator = KeyringCoordinator::new(backend.clone());
        let desired = snapshot(&[("SYNTH_A", "new-a"), ("SYNTH_B", "new-b")]);
        let mut fallback_writes = 0;
        let (stored, outcome) = coordinator
            .store_with_write(
                &path,
                &["SYNTH_A".to_owned(), "SYNTH_B".to_owned()],
                desired.clone(),
                false,
                TEST_TIMEOUT,
                |path, stored| {
                    fallback_writes += 1;
                    if !backend.recovery_writable.load(Ordering::SeqCst) {
                        return Err("synthetic fallback write denied".to_owned());
                    }
                    write_fallback(path, stored)
                },
            )
            .unwrap();
        assert!(outcome.is_err());
        assert_eq!(fallback_writes, 1);
        assert_eq!(backend.writes.load(Ordering::SeqCst), 2);
        assert!(!backend.recovery_writable.load(Ordering::SeqCst));
        assert_ne!(*test_lock(&backend.values), before.values);
        assert_ne!(*test_lock(&backend.values), desired.values);
        assert_eq!(
            read_fallback(&path).unwrap().unwrap().values,
            desired.values
        );
        let committed = loaded_after_reconciliation(stored, outcome, false);
        assert_eq!(
            committed.values,
            desired.values.clone().into_iter().collect()
        );

        // Even a subsequent total native outage must not expose the native mix.
        backend.unavailable.store(true, Ordering::SeqCst);
        let restarted = KeyringCoordinator::new(backend.clone());
        let loaded = load_from_path(
            &restarted,
            &path,
            &["SYNTH_A".to_owned(), "SYNTH_B".to_owned()],
            HashMap::new(),
            TEST_TIMEOUT,
        )
        .unwrap();
        assert_eq!(loaded.values, desired.values.clone().into_iter().collect());
        assert_eq!(loaded.warning.as_deref(), Some(FALLBACK_WARNING));
        backend.unavailable.store(false, Ordering::SeqCst);
        let recovered = load_from_path(
            &restarted,
            &path,
            &loaded.keys,
            HashMap::new(),
            TEST_TIMEOUT,
        )
        .unwrap();
        assert!(recovered.warning.is_none());
        assert_eq!(*test_lock(&backend.values), desired.values);
        assert!(!path.exists());
    }

    #[test]
    fn denied_journal_write_prevents_even_first_native_write() {
        let fixture = Fixture::new();
        let parent = fixture.0.join("not-a-directory");
        fs::write(&parent, b"synthetic blocker").unwrap();
        let backend = Arc::new(FakeBackend::default());
        backend.fail_write.store(2, Ordering::SeqCst);
        let before = snapshot(&[("SYNTH_A", "old-a"), ("SYNTH_B", "old-b")]);
        *test_lock(&backend.values) = before.values.clone();
        let coordinator = KeyringCoordinator::new(backend.clone());
        let result = coordinator.store(
            &parent.join("provider-secrets.json"),
            &["SYNTH_A".to_owned(), "SYNTH_B".to_owned()],
            snapshot(&[("SYNTH_A", "new-a"), ("SYNTH_B", "new-b")]),
            false,
            TEST_TIMEOUT,
        );
        assert!(result.is_err());
        assert_eq!(backend.writes.load(Ordering::SeqCst), 0);
        assert_eq!(*test_lock(&backend.values), before.values);
        assert!(!test_lock(&coordinator.state).running);
    }

    #[test]
    fn post_replace_sync_failure_returns_accepted_desired_and_keeps_recovery() {
        let fixture = Fixture::new();
        let path = fixture.path();
        let backend = Arc::new(FakeBackend::default());
        let coordinator = KeyringCoordinator::new(backend.clone());
        let desired = snapshot(&[("SYNTH_COMMITTED", "synthetic-new")]);
        let (stored, outcome) = coordinator
            .store_with_write(
                &path,
                &[],
                desired.clone(),
                false,
                TEST_TIMEOUT,
                |path, stored| {
                    write_fallback(path, stored)?;
                    Err("synthetic directory-sync failure after replace".to_owned())
                },
            )
            .expect("published journal must be accepted rather than early Err");
        assert!(outcome.is_err());
        let accepted = loaded_after_reconciliation(stored, outcome, false);
        assert_eq!(
            accepted.values,
            desired.values.clone().into_iter().collect()
        );
        assert_eq!(accepted.warning.as_deref(), Some(FALLBACK_WARNING));
        assert_eq!(*test_lock(&backend.values), desired.values);
        assert_eq!(
            read_fallback(&path).unwrap().unwrap().values,
            desired.values
        );
        let restarted = KeyringCoordinator::new(backend);
        let recovered = load_from_path(
            &restarted,
            &path,
            &accepted.keys,
            HashMap::new(),
            TEST_TIMEOUT,
        )
        .unwrap();
        assert_eq!(recovered.values, accepted.values);
        assert!(recovered.warning.is_none());
        assert!(!path.exists());
    }

    #[test]
    fn timed_out_old_mutation_is_serialized_before_newest_desired_deletion() {
        let fixture = Fixture::new();
        let path = fixture.path();
        let backend = Arc::new(FakeBackend::default());
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        *test_lock(&backend.before_write) = Some((entered_tx, release_rx));
        let coordinator = KeyringCoordinator::new(backend.clone());
        let (stored, outcome) = coordinator
            .store(
                &path,
                &[],
                snapshot(&[("SYNTH_REMOVED", "old-worker")]),
                false,
                Duration::from_millis(10),
            )
            .unwrap();
        entered_rx.recv_timeout(TEST_TIMEOUT).unwrap();
        assert!(outcome.is_err());
        assert_eq!(stored.values.len(), 1);
        // A stays blocked before its OS mutation until every superseding save
        // has returned; channel/state assertions prove ordering, not wall time.
        for _ in 0..16 {
            let (stored, outcome) = coordinator
                .store(
                    &path,
                    &["SYNTH_REMOVED".to_owned()],
                    snapshot(&[]),
                    false,
                    TEST_TIMEOUT,
                )
                .unwrap();
            assert!(outcome.is_err());
            assert!(stored.values.is_empty());
        }
        let newest = snapshot(&[("SYNTH_CURRENT", "newest-worker")]);
        let (latest, outcome) = coordinator
            .store(
                &path,
                &["SYNTH_REMOVED".to_owned()],
                newest.clone(),
                false,
                TEST_TIMEOUT,
            )
            .unwrap();
        assert!(outcome.is_err());
        assert!(!latest.keys.as_ref().unwrap().contains("SYNTH_REMOVED"));
        assert_eq!(backend.writes.load(Ordering::SeqCst), 1);
        assert_eq!(backend.deletes.load(Ordering::SeqCst), 0);
        assert_eq!(read_fallback(&path).unwrap().unwrap().values, newest.values);
        assert!(test_lock(&backend.values).is_empty());
        release_tx.send(()).unwrap();
        wait_idle(&coordinator);
        assert_eq!(*test_lock(&backend.values), newest.values);
        assert!(!path.exists());
        let restarted = KeyringCoordinator::new(backend.clone());
        let loaded = load_from_path(
            &restarted,
            &path,
            &["SYNTH_CURRENT".to_owned()],
            HashMap::new(),
            TEST_TIMEOUT,
        )
        .unwrap();
        assert_eq!(loaded.values, newest.values.into_iter().collect());
        assert_eq!(loaded.keys, vec!["SYNTH_CURRENT".to_owned()]);
        assert!(!loaded.values.contains_key("SYNTH_REMOVED"));
        assert_eq!(backend.writes.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn placeholder_noop_does_not_touch_unavailable_keyring_or_spawn_worker() {
        let fixture = Fixture::new();
        let backend = Arc::new(FakeBackend::default());
        backend.unavailable.store(true, Ordering::SeqCst);
        let coordinator = KeyringCoordinator::new(backend.clone());
        let desired = snapshot(&[("SYNTH_KEEP", "synthetic-existing")]);
        let (values, keys) = merge_requested_secrets(
            &desired.values.clone().into_iter().collect(),
            HashMap::from([("SYNTH_KEEP".to_owned(), String::new())]),
        );
        let stored = FallbackSecrets {
            values,
            keys: Some(keys),
            pending_deletions: BTreeSet::new(),
        };
        let (_, outcome) = coordinator
            .store(
                &fixture.path(),
                &["SYNTH_KEEP".to_owned()],
                stored,
                true,
                TEST_TIMEOUT,
            )
            .unwrap();
        assert!(outcome.is_ok());
        assert_eq!(backend.writes.load(Ordering::SeqCst), 0);
        assert_eq!(backend.reads.load(Ordering::SeqCst), 0);
        assert_eq!(backend.deletes.load(Ordering::SeqCst), 0);
        assert!(!test_lock(&coordinator.state).running);
        assert!(!fixture.path().exists());
        write_fallback(&fixture.path(), &desired).unwrap();
        let (stored, outcome) = coordinator
            .store(
                &fixture.path(),
                &["SYNTH_KEEP".to_owned()],
                desired,
                true,
                TEST_TIMEOUT,
            )
            .unwrap();
        assert!(outcome.is_err());
        let loaded = loaded_after_reconciliation(stored, outcome, false);
        assert_eq!(loaded.warning.as_deref(), Some(FALLBACK_WARNING));
        assert_eq!(backend.writes.load(Ordering::SeqCst), 0);
        assert_eq!(backend.reads.load(Ordering::SeqCst), 0);
        assert!(!test_lock(&coordinator.state).running);
    }

    #[test]
    fn blank_existing_values_are_preserved_without_round_tripping_to_ui() {
        let current = HashMap::from([
            ("SYNTH_KEEP".to_owned(), "synthetic-keep".to_owned()),
            ("SYNTH_CHANGE".to_owned(), "synthetic-old".to_owned()),
        ]);
        let requested = HashMap::from([
            ("SYNTH_KEEP".to_owned(), String::new()),
            ("SYNTH_CHANGE".to_owned(), "synthetic-new".to_owned()),
        ]);
        let (merged, keys) = merge_requested_secrets(&current, requested);
        assert_eq!(
            merged.get("SYNTH_KEEP").map(String::as_str),
            Some("synthetic-keep")
        );
        assert_eq!(
            merged.get("SYNTH_CHANGE").map(String::as_str),
            Some("synthetic-new")
        );
        assert!(keys.contains("SYNTH_KEEP"));
    }

    #[test]
    fn omitted_keys_are_deleted() {
        let current = HashMap::from([("SYNTH_REMOVE".to_owned(), "synthetic-value".to_owned())]);
        let (merged, keys) = merge_requested_secrets(&current, HashMap::new());
        assert!(merged.is_empty());
        assert!(keys.is_empty());
    }

    #[test]
    fn blank_unavailable_secret_keeps_non_secret_key_metadata() {
        let requested = HashMap::from([("SYNTH_UNAVAILABLE".to_owned(), String::new())]);
        let (values, keys) = merge_requested_secrets(&HashMap::new(), requested);
        assert!(values.is_empty());
        assert!(keys.contains("SYNTH_UNAVAILABLE"));
    }
}
