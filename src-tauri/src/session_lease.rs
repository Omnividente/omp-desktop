use crate::sessions::{atomic_write_private_file, harden_private_file};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::cell::Cell;
use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::LazyLock,
    time::{SystemTime, UNIX_EPOCH},
};

const LOCK_SUFFIX: &str = ".omp-desktop.lock";
const MAX_LEASE_METADATA_BYTES: u64 = 64 * 1024;
const MAX_RECLAIM_QUARANTINES: usize = 3;
const RECLAIM_PENDING_SUFFIX: &str = ".reclaiming.json";
const ACTIVE_ERROR_CODE: &str = "session_lease_active";
const STALE_ERROR_CODE: &str = "session_lease_stale";
const LEASE_ERROR_CODE: &str = "session_lease_failed";

static PROCESS_STARTED_AT: LazyLock<String> = LazyLock::new(now_timestamp);
static PROCESS_IDENTITY: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{}-{}-{:032x}",
        std::process::id(),
        PROCESS_STARTED_AT.as_str(),
        rand::random::<u128>()
    )
});

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionLeasePurpose {
    Resume,
    #[serde(alias = "discovered")]
    RuntimeDiscovered,
    Delete,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLeaseOwner {
    owner_token: String,
    desktop_pid: u32,
    desktop_started_at: String,
    acquired_at: String,
    session_path: String,
    purpose: SessionLeasePurpose,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionLeaseFailureWire<'a> {
    metadata_state: &'a str,
    owner_pid: Option<u32>,
    owner_started_at: Option<&'a str>,
    acquired_at: Option<&'a str>,
    session_path: &'a str,
}

#[derive(Debug)]
enum ExistingMetadata {
    Empty,
    Valid(SessionLeaseOwner, Vec<u8>),
    Corrupt(Vec<u8>),
    ReclaimPending {
        owner: Option<SessionLeaseOwner>,
        path: PathBuf,
    },
}
#[cfg(test)]
thread_local! {
    static FAIL_NEXT_METADATA_WRITE: Cell<bool> = const { Cell::new(false) };
}

pub struct SessionLease {
    file: File,
    _lock_path: PathBuf,
    owner: SessionLeaseOwner,
    clear_on_drop: bool,
}

impl SessionLease {
    pub fn acquire(
        session_path: &Path,
        purpose: SessionLeasePurpose,
        force_reclaim: bool,
    ) -> Result<Self, String> {
        let session_path = session_path.canonicalize().map_err(|error| {
            coded_error(
                LEASE_ERROR_CODE,
                format!(
                    "Не удалось определить session JSONL {}: {error}",
                    session_path.display()
                ),
            )
        })?;
        let lock_path = lease_path(&session_path)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&lock_path).map_err(|error| {
            coded_error(
                LEASE_ERROR_CODE,
                format!("Не удалось открыть lease {}: {error}", lock_path.display()),
            )
        })?;
        harden_private_file(&lock_path).map_err(|error| {
            coded_error(
                LEASE_ERROR_CODE,
                format!(
                    "Не удалось ограничить права lease {}: {error}",
                    lock_path.display()
                ),
            )
        })?;

        if let Err(error) = file.try_lock_exclusive() {
            let metadata = read_existing_metadata(&mut file, &lock_path)
                .unwrap_or(ExistingMetadata::Corrupt(Vec::new()));
            let detail = failure_detail(&session_path, &metadata);
            return if lock_is_contended(&error) {
                Err(format!("[{ACTIVE_ERROR_CODE}] {detail}"))
            } else {
                Err(coded_error(
                    LEASE_ERROR_CODE,
                    format!(
                        "Не удалось получить exclusive lease {}: {error}; {detail}",
                        lock_path.display()
                    ),
                ))
            };
        }

        let existing = match read_existing_metadata(&mut file, &lock_path) {
            Ok(existing) => existing,
            Err(error) => {
                let _ = FileExt::unlock(&file);
                return Err(coded_error(LEASE_ERROR_CODE, error));
            }
        };
        if !matches!(existing, ExistingMetadata::Empty) && !force_reclaim {
            let detail = failure_detail(&session_path, &existing);
            let _ = FileExt::unlock(&file);
            return Err(format!("[{STALE_ERROR_CODE}] {detail}"));
        }
        let pending_reclaim = match &existing {
            ExistingMetadata::Empty => None,
            ExistingMetadata::Valid(_, bytes) | ExistingMetadata::Corrupt(bytes) => {
                match begin_reclaim_metadata(&lock_path, bytes) {
                    Ok(path) => Some(path),
                    Err(error) => {
                        let _ = FileExt::unlock(&file);
                        return Err(coded_error(LEASE_ERROR_CODE, error));
                    }
                }
            }
            ExistingMetadata::ReclaimPending { path, .. } => Some(path.clone()),
        };

        let owner = SessionLeaseOwner {
            owner_token: PROCESS_IDENTITY.clone(),
            desktop_pid: std::process::id(),
            desktop_started_at: PROCESS_STARTED_AT.clone(),
            acquired_at: now_timestamp(),
            session_path: session_path.to_string_lossy().into_owned(),
            purpose,
        };
        if let Err(error) = write_metadata(&mut file, &owner) {
            let _ = FileExt::unlock(&file);
            return Err(coded_error(LEASE_ERROR_CODE, error));
        }
        if let Some(pending_path) = pending_reclaim {
            if let Err(error) = finish_reclaim_metadata(&lock_path, &pending_path) {
                let _ = restore_metadata(&mut file, &existing);
                let _ = FileExt::unlock(&file);
                return Err(coded_error(LEASE_ERROR_CODE, error));
            }
        }
        prune_reclaim_quarantines(&lock_path);
        Ok(Self {
            file,
            _lock_path: lock_path,
            owner,
            clear_on_drop: true,
        })
    }

    #[cfg(test)]
    fn lock_path(&self) -> &Path {
        &self._lock_path
    }

    fn release_cleanly(&mut self) {
        if !self.clear_on_drop {
            return;
        }
        clear_metadata_if_owned(&mut self.file, &self.owner.owner_token);
        // Keep the empty sidecar. Unlinking after unlock can split ownership when
        // another process already opened the old inode before the deletion.
        let _ = FileExt::unlock(&self.file);
        self.clear_on_drop = false;
    }
}

impl Drop for SessionLease {
    fn drop(&mut self) {
        self.release_cleanly();
    }
}

fn lease_path(session_path: &Path) -> Result<PathBuf, String> {
    let name = session_path.file_name().ok_or_else(|| {
        coded_error(
            LEASE_ERROR_CODE,
            format!(
                "Не удалось определить имя session JSONL {}",
                session_path.display()
            ),
        )
    })?;
    let mut lock_name = OsString::from(name);
    lock_name.push(LOCK_SUFFIX);
    Ok(session_path.with_file_name(lock_name))
}
fn lock_is_contended(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::WouldBlock {
        return true;
    }
    #[cfg(windows)]
    {
        // LockFileEx reports ERROR_LOCK_VIOLATION; some filesystems surface
        // ERROR_SHARING_VIOLATION for the same non-blocking contention.
        return matches!(error.raw_os_error(), Some(32 | 33));
    }
    #[cfg(unix)]
    {
        return error
            .raw_os_error()
            .is_some_and(|code| code == libc::EAGAIN || code == libc::EWOULDBLOCK);
    }
    #[allow(unreachable_code)]
    false
}

fn read_existing_metadata(file: &mut File, lock_path: &Path) -> Result<ExistingMetadata, String> {
    let length = file
        .metadata()
        .map_err(|error| format!("Не удалось прочитать metadata lease: {error}"))?
        .len();
    if length == 0 {
        let pending = reclaim_pending_path(lock_path)?;
        if pending.is_file() {
            let bytes = fs::read(&pending).map_err(|error| {
                format!(
                    "Не удалось прочитать незавершённый reclaim {}: {error}",
                    pending.display()
                )
            })?;
            let owner = serde_json::from_slice::<SessionLeaseOwner>(&bytes).ok();
            return Ok(ExistingMetadata::ReclaimPending {
                owner,
                path: pending,
            });
        }
        return Ok(ExistingMetadata::Empty);
    }
    if length > MAX_LEASE_METADATA_BYTES {
        return Err(format!(
            "Lease metadata превышает безопасный лимит {MAX_LEASE_METADATA_BYTES} байт"
        ));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("Не удалось начать чтение lease metadata: {error}"))?;
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(MAX_LEASE_METADATA_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Не удалось прочитать lease metadata: {error}"))?;
    match serde_json::from_slice::<SessionLeaseOwner>(&bytes) {
        Ok(owner) => Ok(ExistingMetadata::Valid(owner, bytes)),
        Err(_) => Ok(ExistingMetadata::Corrupt(bytes)),
    }
}

fn write_metadata(file: &mut File, owner: &SessionLeaseOwner) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(owner)
        .map_err(|error| format!("Не удалось сериализовать lease metadata: {error}"))?;
    file.set_len(0)
        .map_err(|error| format!("Не удалось очистить lease metadata: {error}"))?;
    #[cfg(test)]
    if FAIL_NEXT_METADATA_WRITE.with(|flag| flag.replace(false)) {
        return Err("simulated write metadata failure after truncate".to_owned());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("Не удалось начать запись lease metadata: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_data())
        .map_err(|error| format!("Не удалось записать lease metadata: {error}"))
}

fn restore_metadata(file: &mut File, metadata: &ExistingMetadata) -> Result<(), String> {
    let bytes = match metadata {
        ExistingMetadata::Valid(_, bytes) | ExistingMetadata::Corrupt(bytes) => bytes,
        ExistingMetadata::ReclaimPending { .. } => return Ok(()),
        ExistingMetadata::Empty => {
            file.set_len(0).map_err(|error| {
                format!("Не удалось восстановить пустую lease metadata: {error}")
            })?;
            return Ok(());
        }
    };
    file.set_len(0)
        .and_then(|_| file.seek(SeekFrom::Start(0)))
        .and_then(|_| file.write_all(bytes))
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_data())
        .map_err(|error| format!("Не удалось восстановить lease metadata: {error}"))
}

fn clear_metadata_if_owned(file: &mut File, owner_token: &str) {
    if metadata_belongs_to(file, owner_token) {
        let _ = file.set_len(0);
        let _ = file.seek(SeekFrom::Start(0));
        let _ = file.sync_data();
    }
}

fn metadata_belongs_to(file: &mut File, owner_token: &str) -> bool {
    let Ok(length) = file.metadata().map(|metadata| metadata.len()) else {
        return false;
    };
    if length == 0 || length > MAX_LEASE_METADATA_BYTES {
        return false;
    }
    let Ok(_) = file.seek(SeekFrom::Start(0)) else {
        return false;
    };
    let mut bytes = Vec::with_capacity(length as usize);
    if file
        .take(MAX_LEASE_METADATA_BYTES)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return false;
    }
    match serde_json::from_slice::<SessionLeaseOwner>(&bytes) {
        Ok(owner) => owner.owner_token == owner_token,
        Err(_) => false,
    }
}

fn reclaim_pending_path(lock_path: &Path) -> Result<PathBuf, String> {
    let file_name = lock_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("session.omp-desktop.lock");
    let parent = lock_path.parent().ok_or_else(|| {
        format!(
            "Не удалось определить каталог lease {}",
            lock_path.display()
        )
    })?;
    Ok(parent.join(format!(".{file_name}{RECLAIM_PENDING_SUFFIX}")))
}

fn begin_reclaim_metadata(lock_path: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    let pending = reclaim_pending_path(lock_path)?;
    atomic_write_private_file(&pending, bytes)?;
    Ok(pending)
}

fn finish_reclaim_metadata(lock_path: &Path, pending: &Path) -> Result<(), String> {
    let file_name = lock_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("session.omp-desktop.lock");
    let parent = lock_path.parent().ok_or_else(|| {
        format!(
            "Не удалось определить каталог lease {}",
            lock_path.display()
        )
    })?;
    for _ in 0..16 {
        let quarantine = parent.join(format!(
            ".{file_name}.stale-{}-{:016x}.json",
            now_millis(),
            rand::random::<u64>()
        ));
        if quarantine.exists() {
            continue;
        }
        if fs::rename(pending, &quarantine).is_ok() {
            return Ok(());
        }
    }
    let bytes = fs::read(pending)
        .map_err(|error| format!("Не удалось прочитать {}: {error}", pending.display()))?;
    let quarantine = parent.join(format!(
        ".{file_name}.stale-{}-{:016x}.json",
        now_millis(),
        rand::random::<u64>()
    ));
    atomic_write_private_file(&quarantine, &bytes)?;
    let _ = fs::remove_file(pending);
    Ok(())
}

fn prune_reclaim_quarantines(lock_path: &Path) {
    let file_name = lock_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("session.omp-desktop.lock");
    let Some(parent) = lock_path.parent() else {
        return;
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    let prefix = format!(".{file_name}.stale-");
    let mut files = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let text = name.to_string_lossy();
            text.starts_with(&prefix) && text.ends_with(".json")
        })
        .map(|entry| {
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            (modified, entry.path())
        })
        .collect::<Vec<_>>();
    files.sort_unstable_by_key(|entry| std::cmp::Reverse(entry.0));
    for (_, path) in files.into_iter().skip(MAX_RECLAIM_QUARANTINES) {
        let _ = fs::remove_file(path);
    }
}

fn failure_detail(session_path: &Path, metadata: &ExistingMetadata) -> String {
    let (state, owner) = match metadata {
        ExistingMetadata::Empty => ("missing", None),
        ExistingMetadata::Valid(owner, _) => ("valid", Some(owner)),
        ExistingMetadata::Corrupt(_) => ("corrupt", None),
        ExistingMetadata::ReclaimPending { owner, .. } => ("reclaim_pending", owner.as_ref()),
    };
    serde_json::to_string(&SessionLeaseFailureWire {
        metadata_state: state,
        owner_pid: owner.map(|owner| owner.desktop_pid),
        owner_started_at: owner.map(|owner| owner.desktop_started_at.as_str()),
        acquired_at: owner.map(|owner| owner.acquired_at.as_str()),
        session_path: session_path.to_string_lossy().as_ref(),
    })
    .unwrap_or_else(|_| "session lease is unavailable".to_owned())
}

fn coded_error(code: &str, detail: String) -> String {
    format!("[{code}] {detail}")
}

fn now_timestamp() -> String {
    now_millis().to_string()
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::{
        lease_path, SessionLease, SessionLeaseOwner, SessionLeasePurpose, FAIL_NEXT_METADATA_WRITE,
    };
    use std::{
        fs,
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    fn fixture(label: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-session-lease-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("lease fixture directory should be creatable");
        let session = root.join("session.jsonl");
        fs::write(&session, b"{}\n").expect("session fixture should be writable");
        (root, session)
    }

    #[test]
    fn runtime_discovered_purpose_has_stable_wire_name_and_reads_legacy_name() {
        assert_eq!(
            serde_json::to_string(&SessionLeasePurpose::RuntimeDiscovered)
                .expect("purpose should serialize"),
            "\"runtime_discovered\"",
        );
        assert_eq!(
            serde_json::from_str::<SessionLeasePurpose>("\"discovered\"")
                .expect("legacy purpose should remain readable"),
            SessionLeasePurpose::RuntimeDiscovered,
        );
    }

    #[test]
    fn active_lease_refuses_normal_and_force_acquisition() {
        let (root, session) = fixture("active");
        let owner = SessionLease::acquire(&session, SessionLeasePurpose::Resume, false)
            .expect("first writer should acquire the lease");

        let normal = SessionLease::acquire(&session, SessionLeasePurpose::Resume, false)
            .err()
            .expect("second writer should be refused");
        let forced = SessionLease::acquire(&session, SessionLeasePurpose::Resume, true)
            .err()
            .expect("force must not override an OS-held lease");

        assert!(normal.starts_with("[session_lease_active] "));
        assert!(forced.starts_with("[session_lease_active] "));
        drop(owner);
        fs::remove_dir_all(root).expect("lease fixture should be removable");
    }

    #[test]
    fn clean_release_allows_resume_without_force() {
        let (root, session) = fixture("clean");
        let lease = SessionLease::acquire(&session, SessionLeasePurpose::Resume, false)
            .expect("lease should be acquirable");
        let lock_path = lease.lock_path().to_path_buf();
        drop(lease);
        assert_eq!(
            fs::metadata(&lock_path)
                .expect("lock file should remain")
                .len(),
            0
        );

        SessionLease::acquire(&session, SessionLeasePurpose::Resume, false)
            .expect("cleanly released lease should be reusable");
        fs::remove_dir_all(root).expect("lease fixture should be removable");
    }

    #[test]
    fn stale_pid_metadata_requires_explicit_reclaim_and_is_quarantined() {
        let (root, session) = fixture("stale");
        let lock_path = lease_path(&session).expect("lock path should resolve");
        let stale = SessionLeaseOwner {
            owner_token: "reused-pid-old-start".to_owned(),
            desktop_pid: std::process::id(),
            desktop_started_at: "old-start".to_owned(),
            acquired_at: "old-acquisition".to_owned(),
            session_path: session.to_string_lossy().into_owned(),
            purpose: SessionLeasePurpose::Resume,
        };
        fs::write(
            &lock_path,
            serde_json::to_vec(&stale).expect("metadata should serialize"),
        )
        .expect("stale metadata should be writable");

        let error = SessionLease::acquire(&session, SessionLeasePurpose::Resume, false)
            .err()
            .expect("stale metadata should require confirmation");
        assert!(error.starts_with("[session_lease_stale] "));

        let lease = SessionLease::acquire(&session, SessionLeasePurpose::Resume, true)
            .expect("explicit reclaim should succeed when OS lock is free");
        let quarantines = fs::read_dir(&root)
            .expect("fixture directory should be readable")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".stale-"))
            .count();
        assert_eq!(quarantines, 1);
        drop(lease);
        fs::remove_dir_all(root).expect("lease fixture should be removable");
    }

    #[test]
    fn corrupt_metadata_can_only_be_reclaimed_explicitly() {
        let (root, session) = fixture("corrupt");
        let lock_path = lease_path(&session).expect("lock path should resolve");
        fs::write(&lock_path, b"{not-json").expect("corrupt metadata should be writable");

        let error = SessionLease::acquire(&session, SessionLeasePurpose::Resume, false)
            .err()
            .expect("corrupt metadata should require confirmation");
        assert!(error.contains("\"metadataState\":\"corrupt\""));
        SessionLease::acquire(&session, SessionLeasePurpose::Resume, true)
            .expect("explicit reclaim should quarantine corrupt metadata");
        fs::remove_dir_all(root).expect("lease fixture should be removable");
    }

    #[test]
    fn acquisition_failure_is_fail_closed() {
        let (root, session) = fixture("failed");
        fs::remove_file(&session).expect("session fixture should be removable");
        let error = SessionLease::acquire(&session, SessionLeasePurpose::Resume, false)
            .err()
            .expect("missing session must fail closed");
        assert!(error.starts_with("[session_lease_failed] "));
        fs::remove_dir_all(root).expect("lease fixture should be removable");
    }

    #[test]
    fn crash_helper_holds_lease() {
        let Some(session) = std::env::var_os("OMP_DESKTOP_LEASE_CRASH_HELPER") else {
            return;
        };
        let ready = std::env::var_os("OMP_DESKTOP_LEASE_CRASH_READY")
            .expect("helper ready path should be configured");
        let _lease = SessionLease::acquire(
            std::path::Path::new(&session),
            SessionLeasePurpose::Resume,
            false,
        )
        .expect("crash helper should acquire lease");
        fs::write(ready, b"ready").expect("crash helper should signal readiness");
        loop {
            thread::sleep(Duration::from_secs(60));
        }
    }

    #[test]
    fn crashed_owner_leaves_stale_metadata_but_not_an_os_lock() {
        let (root, session) = fixture("crash");
        let ready = root.join("ready");
        let mut child =
            Command::new(std::env::current_exe().expect("test executable should resolve"))
                .args([
                    "--exact",
                    "session_lease::tests::crash_helper_holds_lease",
                    "--nocapture",
                ])
                .env("OMP_DESKTOP_LEASE_CRASH_HELPER", &session)
                .env("OMP_DESKTOP_LEASE_CRASH_READY", &ready)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("crash helper should start");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.is_file() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(ready.is_file(), "crash helper did not acquire the lease");
        child.kill().expect("crash helper should be killable");
        child.wait().expect("crash helper should be reaped");

        let stale = SessionLease::acquire(&session, SessionLeasePurpose::Resume, false)
            .err()
            .expect("crash metadata should require explicit reclaim");
        assert!(stale.starts_with("[session_lease_stale] "));
        SessionLease::acquire(&session, SessionLeasePurpose::Resume, true)
            .expect("OS lock should be released automatically when owner crashes");
        fs::remove_dir_all(root).expect("lease fixture should be removable");
    }
    #[test]
    fn failed_write_metadata_during_reclaim_preserves_stale_confirmation_requirement() {
        let (root, session) = fixture("reclaim-failure");
        let lock_path = lease_path(&session).expect("lock path should resolve");
        let stale = SessionLeaseOwner {
            owner_token: "old-owner-token".to_owned(),
            desktop_pid: std::process::id(),
            desktop_started_at: "old-started".to_owned(),
            acquired_at: "old-time".to_owned(),
            session_path: session.to_string_lossy().into_owned(),
            purpose: SessionLeasePurpose::Resume,
        };
        fs::write(
            &lock_path,
            serde_json::to_vec(&stale).expect("metadata should serialize"),
        )
        .expect("stale metadata should be writable");

        FAIL_NEXT_METADATA_WRITE.with(|flag| flag.set(true));
        let failed_reclaim = SessionLease::acquire(&session, SessionLeasePurpose::Resume, true)
            .err()
            .expect("injected metadata write failure should fail acquisition");
        assert!(failed_reclaim.contains("simulated write metadata failure"));
        let pending = super::reclaim_pending_path(&lock_path).expect("pending path should resolve");
        assert_eq!(
            fs::read(&pending).expect("reclaim journal should survive write failure"),
            serde_json::to_vec(&stale).expect("metadata should serialize"),
        );

        // Confirmation MUST still be required; normal acquisition without force MUST fail.
        let retry_normal = SessionLease::acquire(&session, SessionLeasePurpose::Resume, false)
            .err()
            .expect("reclaim failure must not silently bypass confirmation on next attempt");
        assert!(retry_normal.starts_with("[session_lease_stale] "));

        let retry_forced = SessionLease::acquire(&session, SessionLeasePurpose::Resume, true)
            .expect("subsequent explicit reclaim should succeed");
        drop(retry_forced);
        fs::remove_dir_all(root).expect("lease fixture should be removable");
    }

    #[test]
    fn reclaim_quarantines_are_bounded_to_retention_limit() {
        let (root, session) = fixture("quarantine-bound");
        let lock_path = lease_path(&session).expect("lock path should resolve");

        for i in 0..6 {
            let stale = SessionLeaseOwner {
                owner_token: format!("owner-{i}"),
                desktop_pid: std::process::id(),
                desktop_started_at: format!("started-{i}"),
                acquired_at: format!("acquired-{i}"),
                session_path: session.to_string_lossy().into_owned(),
                purpose: SessionLeasePurpose::Resume,
            };
            fs::write(
                &lock_path,
                serde_json::to_vec(&stale).expect("metadata should serialize"),
            )
            .expect("stale metadata should be writable");

            let lease = SessionLease::acquire(&session, SessionLeasePurpose::Resume, true)
                .expect("reclaim should succeed");
            drop(lease);
        }

        let quarantines = fs::read_dir(&root)
            .expect("fixture directory should be readable")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".stale-"))
            .count();
        assert!(
            quarantines <= super::MAX_RECLAIM_QUARANTINES,
            "quarantine count {quarantines} exceeded limit {}",
            super::MAX_RECLAIM_QUARANTINES
        );
        fs::remove_dir_all(root).expect("lease fixture should be removable");
    }
}
