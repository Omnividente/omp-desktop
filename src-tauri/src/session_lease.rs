use crate::sessions::{atomic_write_private_file, harden_private_file};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs::{File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::LazyLock,
    time::{SystemTime, UNIX_EPOCH},
};

const LOCK_SUFFIX: &str = ".omp-desktop.lock";
const MAX_LEASE_METADATA_BYTES: u64 = 64 * 1024;
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
    Discovered,
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
            let metadata =
                read_existing_metadata(&mut file).unwrap_or(ExistingMetadata::Corrupt(Vec::new()));
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

        let existing = match read_existing_metadata(&mut file) {
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
        if !matches!(existing, ExistingMetadata::Empty) {
            let bytes = match &existing {
                ExistingMetadata::Valid(_, bytes) | ExistingMetadata::Corrupt(bytes) => bytes,
                ExistingMetadata::Empty => unreachable!(),
            };
            quarantine_metadata(&lock_path, bytes).map_err(|error| {
                let _ = FileExt::unlock(&file);
                coded_error(LEASE_ERROR_CODE, error)
            })?;
        }

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
        if metadata_belongs_to(&mut self.file, &self.owner.owner_token) {
            let _ = self.file.set_len(0);
            let _ = self.file.seek(SeekFrom::Start(0));
            let _ = self.file.sync_data();
        }
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
        return matches!(error.raw_os_error(), Some(libc::EAGAIN | libc::EWOULDBLOCK));
    }
    #[allow(unreachable_code)]
    false
}

fn read_existing_metadata(file: &mut File) -> Result<ExistingMetadata, String> {
    let length = file
        .metadata()
        .map_err(|error| format!("Не удалось прочитать metadata lease: {error}"))?
        .len();
    if length == 0 {
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
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("Не удалось начать запись lease metadata: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_data())
        .map_err(|error| format!("Не удалось записать lease metadata: {error}"))
}

fn metadata_belongs_to(file: &mut File, owner_token: &str) -> bool {
    matches!(
        read_existing_metadata(file),
        Ok(ExistingMetadata::Valid(owner, _)) if owner.owner_token == owner_token
    )
}

fn quarantine_metadata(lock_path: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
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
        atomic_write_private_file(&quarantine, bytes)?;
        return Ok(quarantine);
    }
    Err("Не удалось подобрать уникальный путь карантина lease metadata".to_owned())
}

fn failure_detail(session_path: &Path, metadata: &ExistingMetadata) -> String {
    let (state, owner) = match metadata {
        ExistingMetadata::Empty => ("missing", None),
        ExistingMetadata::Valid(owner, _) => ("valid", Some(owner)),
        ExistingMetadata::Corrupt(_) => ("corrupt", None),
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
    use super::{lease_path, SessionLease, SessionLeaseOwner, SessionLeasePurpose};
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
}
