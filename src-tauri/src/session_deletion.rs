//! Recoverable deletion. No artifact bytes are removed before the commit record.
use crate::{
    models::SessionScanWarning,
    session_lease::SessionLease,
    sessions::{atomic_write_private_file, harden_private_directory, sync_parent_directory},
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Component, Path, PathBuf},
};

const PREFIX: &str = ".omp-delete-txn-";
const PRIVATE_PREFIX: &str = ".omp-delete-";

pub(crate) fn is_private_directory_name(name: &std::ffi::OsStr) -> bool {
    let Some((kind, nonce)) = name
        .to_str()
        .and_then(|name| name.strip_prefix(PRIVATE_PREFIX))
        .and_then(|name| name.split_once('-'))
    else {
        return false;
    };
    matches!(kind, "txn" | "build" | "done")
        && nonce.len() == 32
        && nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum Phase {
    Prepared,
    RollingBack,
    Committed,
}

#[derive(Debug)]
pub(crate) enum DeleteOutcome {
    Committed(Option<String>),
    RecoveryRequired(String),
}

/// Pin cleanup is deliberately downstream of the durable deletion decision.
/// Failure before commit never writes settings; failure afterwards is a warning,
/// not a claim that history can be restored after committed garbage collection.
pub(crate) fn settle<F>(
    result: Result<DeleteOutcome, String>,
    clean_settings: F,
) -> Result<Option<String>, String>
where
    F: FnOnce() -> Result<(), String>,
{
    let warning = match result? {
        DeleteOutcome::Committed(warning) => warning,
        DeleteOutcome::RecoveryRequired(message) => {
            return Err(format!(
                "[session_delete_recovery_required] Исход требует восстановления: {message}"
            ));
        }
    };
    match clean_settings() {
        Ok(()) => Ok(warning),
        Err(error) => Ok(Some(format!(
            "{}Сессия удалена; очистка закреплений не подтверждена: {error}",
            warning.map(|warning| format!("{warning}; ")).unwrap_or_default()
        ))),
    }
}

#[cfg(test)]
thread_local! {
    static WRITE_FAULT: std::cell::Cell<Option<(usize, bool)>> = const { std::cell::Cell::new(None) };
    static WRITE_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    source: String,
    artifacts: bool,
    phase: Phase,
}

fn problem(path: &Path, error: impl std::fmt::Display) -> String {
    format!("Восстановление удаления {}: {error}", path.display())
}

fn exists(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

// Opening a replaced FIFO must not block a scan. Never follow a marker/lock symlink.
fn open_regular(path: &Path, write: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(write);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() || fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(io::Error::other("ожидался обычный файл"));
    }
    Ok(file)
}

fn read_intent(directory: &Path) -> Result<Intent, String> {
    let path = directory.join("intent.json");
    let mut bytes = Vec::new();
    open_regular(&path, false)
        .and_then(|file| file.take(4097).read_to_end(&mut bytes))
        .map_err(|error| problem(&path, error))?;
    if bytes.len() > 4096 {
        return Err(problem(&path, "слишком большой журнал"));
    }
    let intent: Intent = serde_json::from_slice(&bytes).map_err(|error| problem(&path, error))?;
    let source = Path::new(&intent.source);
    let mut components = source.components();
    if intent.version != 1
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
        || (cfg!(windows) && intent.source.contains(':'))
        || !source
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl"))
    {
        return Err(problem(&path, "некорректное имя сессии или версия журнала"));
    }
    Ok(intent)
}

fn write_intent(directory: &Path, intent: &Intent) -> Result<(), String> {
    let bytes = serde_json::to_vec(intent).map_err(|error| problem(directory, error))?;
    #[cfg(test)]
    let fault = {
        let count = WRITE_COUNT.with(|count| {
            count.set(count.get() + 1);
            count.get()
        });
        WRITE_FAULT.with(|fault| fault.get().filter(|(at, _)| *at == count))
    };
    #[cfg(test)]
    if fault.is_some_and(|(_, after)| !after) {
        return Err("injected intent write failure".into());
    }
    atomic_write_private_file(&directory.join("intent.json"), &bytes)?;
    #[cfg(test)]
    if fault.is_some_and(|(_, after)| after) {
        return Err("injected post-publication sync failure".into());
    }
    Ok(())
}

fn atomic_metadata_name(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str().and_then(|name| name.strip_prefix(".atomic-")) else {
        return false;
    };
    let Some((pid, nonce)) = name
        .strip_suffix(".tmp")
        .and_then(|name| name.split_once('-'))
    else {
        return false;
    };
    pid.parse::<u32>().is_ok() && nonce.parse::<u64>().is_ok()
}

fn check_inventory(directory: &Path, intent: &Intent) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| problem(directory, error))? {
        let entry = entry.map_err(|error| problem(directory, error))?;
        let name = entry.file_name();
        let kind = entry
            .file_type()
            .map_err(|error| problem(directory, error))?;
        if name == "intent.json" || name == "session" || atomic_metadata_name(&name) {
            if !kind.is_file() {
                return Err(problem(&entry.path(), "ожидался обычный файл"));
            }
        } else if name == "artifacts" && intent.artifacts && (kind.is_dir() || kind.is_symlink()) {
            // A staged artifact symlink is moved/unlinked, never followed.
        } else {
            return Err(problem(
                &entry.path(),
                "неизвестный объект; данные сохранены",
            ));
        }
    }
    Ok(())
}

// Do not replace a new writer's file during rollback, even if a preflight saw no file.
#[cfg(target_os = "linux")]
fn move_new(source: &Path, target: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes())?;
    let target = CString::new(target.as_os_str().as_bytes())?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn move_new(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) } != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
fn move_new(_source: &Path, _target: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "атомарное перемещение без замены не поддерживается",
    ))
}

fn sync_transaction(directory: &Path) -> io::Result<()> {
    sync_parent_directory(directory)?;
    sync_parent_directory(directory.parent().unwrap())
}

fn finish_directory(directory: &Path) -> Result<(), String> {
    // Unknown entries are retained; never recursively remove a transaction directory.
    let entries = fs::read_dir(directory).map_err(|error| problem(directory, error))?;
    for entry in entries {
        let entry = entry.map_err(|error| problem(directory, error))?;
        if entry.file_name() != "intent.json" && !atomic_metadata_name(&entry.file_name()) {
            return Err(problem(directory, "сохранён неизвестный файл журнала"));
        }
    }
    // Rename out of the recoverable namespace while the last marker still exists.
    // An interruption during final metadata cleanup cannot create an invalid active journal.
    let parent = directory.parent().unwrap();
    let done = parent.join(format!(
        "{PRIVATE_PREFIX}done-{:032x}",
        rand::random::<u128>()
    ));
    move_new(directory, &done).map_err(|error| problem(directory, error))?;
    sync_parent_directory(parent).map_err(|error| problem(&done, error))?;
    for entry in fs::read_dir(&done).map_err(|error| problem(&done, error))? {
        let entry = entry.map_err(|error| problem(&done, error))?;
        if atomic_metadata_name(&entry.file_name()) {
            fs::remove_file(entry.path()).map_err(|error| problem(&done, error))?;
        }
    }
    fs::remove_file(done.join("intent.json")).map_err(|error| problem(&done, error))?;
    fs::remove_dir(&done).map_err(|error| problem(&done, error))?;
    sync_parent_directory(parent).map_err(|error| problem(&done, error))
}

fn rollback(directory: &Path, intent: &Intent) -> Result<(), String> {
    check_inventory(directory, intent)?;
    if intent.phase == Phase::Prepared {
        let rollback_intent = Intent {
            version: intent.version,
            source: intent.source.clone(),
            artifacts: intent.artifacts,
            phase: Phase::RollingBack,
        };
        // Publish rollback intent before restoring either name.
        write_intent(directory, &rollback_intent)?;
    }
    let parent = directory.parent().unwrap();
    let source = parent.join(&intent.source);
    // Validate both members BEFORE moving either one out of the hidden transaction.
    for (staged, original, required, directory_kind) in [
        (
            directory.join("artifacts"),
            source.with_extension(""),
            intent.artifacts,
            true,
        ),
        (directory.join("session"), source.clone(), true, false),
    ] {
        if !required {
            continue;
        }
        let present = if exists(&staged).map_err(|error| problem(&staged, error))? {
            staged
        } else {
            original
        };
        let metadata = fs::symlink_metadata(&present).map_err(|error| problem(&present, error))?;
        let valid = if directory_kind {
            metadata.is_dir() || metadata.file_type().is_symlink()
        } else {
            metadata.is_file() && !metadata.file_type().is_symlink()
        };
        if !valid {
            return Err(problem(&present, "тип восстановляемых данных изменился"));
        }
    }
    for (staged, original) in [
        (directory.join("artifacts"), source.with_extension("")),
        (directory.join("session"), source.clone()),
    ] {
        if exists(&staged).map_err(|error| problem(&staged, error))?
            && exists(&original).map_err(|error| problem(&original, error))?
        {
            return Err(problem(&original, "путь занят; обе версии сохранены"));
        }
    }
    // Restore artifacts before exposing the JSONL again. A collision retains the journal.
    for (staged, original) in [
        (directory.join("artifacts"), source.with_extension("")),
        (directory.join("session"), source),
    ] {
        if exists(&staged).map_err(|error| problem(&staged, error))? {
            move_new(&staged, &original).map_err(|error| problem(&original, error))?;
            sync_transaction(directory).map_err(|error| problem(directory, error))?;
        } else if (staged.ends_with("session") || intent.artifacts)
            && !exists(&original).map_err(|error| problem(&original, error))?
        {
            return Err(problem(
                &original,
                "исходные данные не найдены; журнал сохранён",
            ));
        }
    }
    finish_directory(directory)
}

fn remove_artifact_link(path: &Path, metadata: &fs::Metadata) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        if metadata.file_type().is_symlink_dir() {
            return fs::remove_dir(path);
        }
    }
    #[cfg(not(windows))]
    let _ = metadata;
    fs::remove_file(path)
}

fn cleanup(directory: &Path) -> Result<(), String> {
    check_inventory(directory, &read_intent(directory)?)?;
    let artifact = directory.join("artifacts");
    if exists(&artifact).map_err(|error| problem(&artifact, error))?
        && !exists(&directory.join("session")).map_err(|error| problem(directory, error))?
    {
        return Err(problem(
            directory,
            "артефакты без staged JSONL; данные сохранены",
        ));
    }
    match fs::symlink_metadata(&artifact) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir_all(&artifact).map_err(|error| problem(&artifact, error))?;
        }
        Ok(metadata) => remove_artifact_link(&artifact, &metadata)
            .map_err(|error| problem(&artifact, error))?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(problem(&artifact, error)),
    }
    let session = directory.join("session");
    if exists(&session).map_err(|error| problem(&session, error))? {
        fs::remove_file(&session).map_err(|error| problem(&session, error))?;
    }
    sync_transaction(directory).map_err(|error| problem(directory, error))?;
    finish_directory(directory)
}

/// A warning means the deletion committed, but retained transaction data needs cleanup.
pub(crate) fn delete(file: &Path) -> Result<DeleteOutcome, String> {
    delete_with(file, |_| Ok(()))
}

fn delete_with<F>(file: &Path, mut checkpoint: F) -> Result<DeleteOutcome, String>
where
    F: FnMut(&str) -> Result<(), String>,
{
    // Do not journal a lossy filename or move a replaced special object.
    open_regular(file, false).map_err(|error| problem(file, error))?;
    let source = file
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| problem(file, "имя сессии не представимо в UTF-8"))?
        .to_owned();
    let parent = file
        .parent()
        .ok_or_else(|| problem(file, "нет родительского каталога"))?;
    let artifact = file.with_extension("");
    let artifacts = match fs::symlink_metadata(&artifact) {
        Ok(metadata) if metadata.is_dir() || metadata.file_type().is_symlink() => true,
        Ok(_) => return Err(problem(&artifact, "посторонний объект на пути артефактов")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(problem(&artifact, error)),
    };
    let mut intent = Intent {
        version: 1,
        source,
        artifacts,
        phase: Phase::Prepared,
    };
    let build = parent.join(format!(
        "{PRIVATE_PREFIX}build-{:032x}",
        rand::random::<u128>()
    ));
    fs::create_dir(&build).map_err(|error| problem(&build, error))?;
    let preparation = harden_private_directory(&build)
        .map_err(|error| problem(&build, error))
        .and_then(|()| write_intent(&build, &intent));
    if let Err(error) = preparation {
        let _ = fs::remove_file(build.join("intent.json"));
        let _ = fs::remove_dir(&build);
        return Err(error);
    }
    // Only a complete intent enters the recovery namespace. Build orphans have no data.
    let directory = parent.join(format!("{PREFIX}{:032x}", rand::random::<u128>()));
    move_new(&build, &directory).map_err(|error| problem(&build, error))?;
    sync_parent_directory(parent).map_err(|error| problem(parent, error))?;
    let staged = (|| {
        checkpoint("prepared")?;
        if artifacts {
            move_new(&artifact, &directory.join("artifacts"))
                .map_err(|error| problem(&artifact, error))?;
            sync_transaction(&directory).map_err(|error| problem(&directory, error))?;
        }
        checkpoint("artifacts")?;
        move_new(file, &directory.join("session")).map_err(|error| problem(file, error))?;
        sync_transaction(&directory).map_err(|error| problem(&directory, error))?;
        checkpoint("session")?;
        check_inventory(&directory, &intent)
    })();
    if let Err(error) = staged {
        return match rollback(&directory, &intent) {
            Ok(()) => Err(error),
            Err(recovery) => Ok(DeleteOutcome::RecoveryRequired(format!(
                "{error}; {recovery}"
            ))),
        };
    }
    intent.phase = Phase::Committed;
    if let Err(error) = write_intent(&directory, &intent) {
        return match read_intent(&directory) {
            Ok(actual) if actual.phase == Phase::Committed => Ok(DeleteOutcome::Committed(Some(
                format!("Удаление зафиксировано; требуется проверка журнала: {error}"),
            ))),
            Ok(actual) => match rollback(&directory, &actual) {
                Ok(()) => Err(error),
                Err(recovery) => Ok(DeleteOutcome::RecoveryRequired(format!(
                    "{error}; {recovery}"
                ))),
            },
            Err(recovery) => Ok(DeleteOutcome::RecoveryRequired(format!(
                "Исход удаления не определён; данные и журнал сохранены: {error}; {recovery}"
            ))),
        };
    }
    if let Err(error) = checkpoint("committed").and_then(|()| cleanup(&directory)) {
        return Ok(DeleteOutcome::Committed(Some(format!(
            "Сессия удалена; очистка отложена: {error}"
        ))));
    }
    Ok(DeleteOutcome::Committed(None))
}

pub(crate) fn recover_tree(
    parent: &Path,
    depth: usize,
    warnings: &mut Vec<SessionScanWarning>,
    blocked: &mut HashSet<PathBuf>,
) {
    recover_directory(parent, warnings, blocked, None);
    if depth >= 3 {
        return;
    }
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    let entries: Vec<_> = entries.flatten().collect();
    let artifact_names: HashSet<_> = entries
        .iter()
        .filter_map(|entry| {
            let path = entry.path();
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl"))
                .then(|| path.file_stem().map(|name| name.to_os_string()))
                .flatten()
        })
        .collect();
    for entry in entries {
        let name = entry.file_name();
        let text = name.to_string_lossy();
        if is_private_directory_name(&name)
            || (text.starts_with('.') && text.contains(".artifacts-"))
            || artifact_names.contains(&name)
            || blocked.contains(&entry.path())
            || !entry.file_type().is_ok_and(|kind| kind.is_dir())
        {
            continue;
        }
        recover_tree(&entry.path(), depth + 1, warnings, blocked);
    }
}

fn source_key(source: &str) -> String {
    if cfg!(windows) {
        source.to_ascii_lowercase()
    } else {
        source.to_owned()
    }
}

fn block_directory(parent: &Path, blocked: &mut HashSet<PathBuf>) {
    // The missing destination of an unreadable intent cannot be enumerated.
    // Reserve the directory itself, including names a future import would create.
    blocked.insert(parent.to_path_buf());
    if let Ok(entries) = fs::read_dir(parent) {
        blocked.extend(entries.flatten().map(|entry| entry.path()));
    }
}

pub(crate) fn recover_directory(
    parent: &Path,
    warnings: &mut Vec<SessionScanWarning>,
    blocked: &mut HashSet<PathBuf>,
    held_lease: Option<&SessionLease>,
) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    let entries: Vec<_> = entries.flatten().collect();
    let mut counts = std::collections::HashMap::new();
    for entry in &entries {
        if !is_private_directory_name(&entry.file_name())
            || !entry.file_name().to_string_lossy().starts_with(PREFIX)
        {
            continue;
        }
        let intent = if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            read_intent(&entry.path())
        } else {
            Err(problem(&entry.path(), "журнал не является каталогом"))
        };
        match intent {
            Ok(intent) => *counts.entry(source_key(&intent.source)).or_insert(0usize) += 1,
            Err(message) => {
                // An opaque sibling could be a duplicate of any valid intent.
                // Do not recover some journals before discovering that ambiguity.
                block_directory(parent, blocked);
                warnings.push(SessionScanWarning {
                    path: entry.path().to_string_lossy().into_owned(),
                    message,
                });
                return;
            }
        }
    }
    for entry in entries {
        if !is_private_directory_name(&entry.file_name())
            || !entry.file_name().to_string_lossy().starts_with(PREFIX)
        {
            continue;
        }
        let directory = entry.path();
        let mut candidate_source = None;
        let recovery = (|| {
            if !entry
                .file_type()
                .map_err(|error| problem(&directory, error))?
                .is_dir()
            {
                block_directory(parent, blocked);
                return Err(problem(&directory, "журнал не является каталогом"));
            }
            let intent = match read_intent(&directory) {
                Ok(intent) => intent,
                Err(error) => {
                    // An unreadable journal cannot identify its session reliably.
                    // Suppress this directory's JSONLs rather than expose a partial pair.
                    block_directory(parent, blocked);
                    return Err(error);
                }
            };
            let source = parent.join(&intent.source);
            candidate_source = Some(source.clone());
            if counts.get(&source_key(&intent.source)).copied().unwrap_or(0) != 1 {
                return Err(problem(
                    &source,
                    "несколько журналов удаления; данные сохранены",
                ));
            }
            // Recovery locks the SAME existing sidecar, without creating an inode or
            // clearing/reclaiming stale ownership metadata. Original JSONL may be absent.
            let _lock = if held_lease.is_some_and(|lease| lease.owns_path(&source)) {
                None
            } else {
                let mut name = source.as_os_str().to_os_string();
                name.push(".omp-desktop.lock");
                let file = open_regular(Path::new(&name), true)
                    .map_err(|error| problem(&source, error))?;
                file.try_lock_exclusive()
                    .map_err(|error| problem(&source, error))?;
                Some(file)
            };
            let stem = source.file_stem().unwrap().to_string_lossy();
            let import_prefix = format!(".{stem}.import-txn.");
            if fs::read_dir(parent)
                .map_err(|error| problem(parent, error))?
                .any(|item| {
                    item.map_or(true, |item| {
                        let name = item.file_name();
                        source_key(&name.to_string_lossy()).starts_with(&source_key(&import_prefix))
                    })
                })
            {
                return Err(problem(&source, "конфликт журналов импорта и удаления"));
            }
            match intent.phase {
                Phase::Prepared | Phase::RollingBack => rollback(&directory, &intent)?,
                Phase::Committed => cleanup(&directory)?,
            }
            Ok(())
        })();
        if let Err(message) = recovery {
            if let Some(source) = candidate_source {
                let source_name = source.file_name().unwrap().to_string_lossy();
                let artifact_name = source.file_stem().unwrap().to_string_lossy();
                if let Ok(entries) = fs::read_dir(parent) {
                    for entry in entries.flatten() {
                        let name = entry.file_name();
                        let key = source_key(&name.to_string_lossy());
                        if key == source_key(&source_name) || key == source_key(&artifact_name) {
                            blocked.insert(entry.path());
                        }
                    }
                }
                blocked.insert(source.with_extension(""));
                blocked.insert(source.clone());
                #[cfg(windows)]
                blocked.insert(parent.join(source_name.to_ascii_lowercase()));
            }
            warnings.push(SessionScanWarning {
                path: directory.to_string_lossy().into_owned(),
                message,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_lease::SessionLeasePurpose;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    struct Fixture {
        root: PathBuf,
        session: PathBuf,
        artifact: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "omp-delete-transaction-{:032x}",
                rand::random::<u128>()
            ));
            let session = root.join("history.jsonl");
            let artifact = root.join("history").join("tool.log");
            fs::create_dir_all(artifact.parent().unwrap()).unwrap();
            fs::write(
                &session,
                b"{\"type\":\"session\",\"id\":\"test\",\"cwd\":\"/synthetic\"}\n",
            )
            .unwrap();
            fs::write(&artifact, b"original artifact").unwrap();
            drop(SessionLease::acquire(&session, SessionLeasePurpose::Delete, false).unwrap());
            Self {
                root,
                session,
                artifact,
            }
        }

        fn transactions(&self) -> Vec<PathBuf> {
            fs::read_dir(&self.root)
                .unwrap()
                .flatten()
                .filter(|entry| entry.file_name().to_string_lossy().starts_with(PREFIX))
                .map(|entry| entry.path())
                .collect()
        }

        fn preserved(&self) {
            assert_eq!(fs::read(&self.artifact).unwrap(), b"original artifact");
            assert_eq!(
                fs::read(&self.session).unwrap(),
                b"{\"type\":\"session\",\"id\":\"test\",\"cwd\":\"/synthetic\"}\n"
            );
        }

        fn recover(&self) -> (Vec<SessionScanWarning>, HashSet<PathBuf>) {
            let mut warnings = Vec::new();
            let mut blocked = HashSet::new();
            recover_directory(&self.root, &mut warnings, &mut blocked, None);
            (warnings, blocked)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn failures_before_commit_restore_both_members() {
        for failure in ["prepared", "artifacts", "session"] {
            let fixture = Fixture::new();
            let result = delete_with(&fixture.session, |stage| {
                if stage == failure {
                    Err("injected failure".into())
                } else {
                    Ok(())
                }
            });
            assert!(result.is_err(), "{failure}: {result:?}");
            fixture.preserved();
            assert!(fixture.transactions().is_empty());
        }
    }

    #[test]
    fn restart_recovers_every_precommit_checkpoint() {
        for interruption in ["prepared", "artifacts", "session"] {
            let fixture = Fixture::new();
            assert!(catch_unwind(AssertUnwindSafe(|| {
                let _ = delete_with(&fixture.session, |stage| {
                    assert_ne!(stage, interruption, "injected interruption");
                    Ok(())
                });
            }))
            .is_err());
            assert_eq!(fixture.transactions().len(), 1);
            let (warnings, blocked) = fixture.recover();
            assert!(warnings.is_empty() && blocked.is_empty());
            fixture.preserved();
            assert!(fixture.transactions().is_empty());
        }
    }

    #[test]
    fn committed_cleanup_failure_is_success_with_warning_and_is_recoverable() {
        let fixture = Fixture::new();
        let result = delete_with(&fixture.session, |stage| {
            if stage == "committed" {
                Err("cleanup unavailable".into())
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert!(matches!(result, DeleteOutcome::Committed(Some(_))));
        assert!(!fixture.session.exists() && !fixture.artifact.exists());
        let directory = fixture.transactions().pop().unwrap();
        assert!(directory.join("session").is_file());
        assert_eq!(
            fs::read(directory.join("artifacts/tool.log")).unwrap(),
            b"original artifact"
        );
        let (warnings, blocked) = fixture.recover();
        assert!(warnings.is_empty() && blocked.is_empty());
        assert!(fixture.transactions().is_empty());
        assert!(!fixture.session.exists());
    }

    #[test]
    fn rollback_never_overwrites_a_new_writer() {
        let fixture = Fixture::new();
        let result = delete_with(&fixture.session, |stage| {
            if stage == "session" {
                fs::write(&fixture.session, b"new writer").unwrap();
                return Err("injected collision".into());
            }
            Ok(())
        })
        .unwrap();
        assert!(matches!(result, DeleteOutcome::RecoveryRequired(_)));
        let (warnings, blocked) = fixture.recover();
        assert!(!warnings.is_empty() && blocked.contains(&fixture.session));
        assert_eq!(fs::read(&fixture.session).unwrap(), b"new writer");
        let directory = fixture.transactions().pop().unwrap();
        assert!(directory.join("session").is_file());
        assert_eq!(
            fs::read(directory.join("artifacts/tool.log")).unwrap(),
            b"original artifact"
        );
    }

    #[test]
    fn active_or_missing_recovery_sidecar_preserves_transaction() {
        for missing in [false, true] {
            let fixture = Fixture::new();
            let lease = SessionLease::acquire(&fixture.session, SessionLeasePurpose::Delete, false)
                .unwrap();
            let _ = catch_unwind(AssertUnwindSafe(|| {
                let _ = delete_with(&fixture.session, |stage| {
                    assert_ne!(stage, "session", "injected interruption");
                    Ok(())
                });
            }));
            if missing {
                drop(lease);
                fs::remove_file(fixture.root.join("history.jsonl.omp-desktop.lock")).unwrap();
            } else {
                let (warnings, _) = fixture.recover();
                assert!(!warnings.is_empty());
                drop(lease);
            }
            if missing {
                assert!(!fixture.recover().0.is_empty());
            }
            assert!(fixture.transactions()[0].join("session").is_file());
        }
    }

    #[test]
    fn malformed_or_oversized_intent_retains_data_and_blocks_discovery() {
        for bytes in [b"not json".to_vec(), vec![b'x'; 4097]] {
            let fixture = Fixture::new();
            let directory = fixture
                .root
                .join(format!("{PREFIX}{:032x}", rand::random::<u128>()));
            fs::create_dir(&directory).unwrap();
            fs::write(directory.join("intent.json"), bytes).unwrap();
            let (warnings, blocked) = fixture.recover();
            assert!(!warnings.is_empty() && blocked.contains(&fixture.session));
            fixture.preserved();
            assert!(directory.exists());
        }
    }

    #[test]
    fn import_marker_conflict_retains_both_journals() {
        let fixture = Fixture::new();
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _ = delete_with(&fixture.session, |stage| {
                assert_ne!(stage, "artifacts", "injected interruption");
                Ok(())
            });
        }));
        fs::write(
            fixture.root.join(".history.import-txn.synthetic"),
            b"synthetic",
        )
        .unwrap();
        assert!(!fixture.recover().0.is_empty());
        assert!(fixture.transactions()[0]
            .join("artifacts/tool.log")
            .is_file());
    }

    #[test]
    fn no_replace_preserves_both_existing_files() {
        let fixture = Fixture::new();
        let destination = fixture.root.join("occupied");
        fs::write(&destination, b"other").unwrap();
        assert!(move_new(&fixture.session, &destination).is_err());
        assert_eq!(fs::read(destination).unwrap(), b"other");
        fixture.preserved();
    }

    #[test]
    fn intent_write_failures_preserve_bytes_and_classify_commit_readback() {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                WRITE_FAULT.with(|fault| fault.set(None));
                WRITE_COUNT.with(|count| count.set(0));
            }
        }
        for (at, after) in [(1, false), (1, true), (2, false), (2, true)] {
            let fixture = Fixture::new();
            let reset = Reset;
            WRITE_COUNT.with(|count| count.set(0));
            WRITE_FAULT.with(|fault| fault.set(Some((at, after))));
            let result = delete(&fixture.session);
            drop(reset);
            if at == 2 && after {
                assert!(matches!(result, Ok(DeleteOutcome::Committed(Some(_)))));
                assert!(!fixture.session.exists());
                assert!(fixture.transactions()[0].join("session").is_file());
            } else {
                assert!(result.is_err(), "{at}/{after}: {result:?}");
                fixture.preserved();
            }
            assert!(fixture.recover().0.is_empty());
        }
    }

    #[test]
    fn incomplete_preparation_and_finished_metadata_do_not_block_history() {
        let fixture = Fixture::new();
        for suffix in ["build", "done"] {
            let directory = fixture.root.join(format!(
                "{PRIVATE_PREFIX}{suffix}-{:032x}",
                rand::random::<u128>()
            ));
            fs::create_dir(directory).unwrap();
        }
        let (warnings, blocked) = fixture.recover();
        assert!(warnings.is_empty() && blocked.is_empty());
        fixture.preserved();
    }

    #[test]
    fn duplicate_journals_never_clear_each_others_block() {
        let fixture = Fixture::new();
        for _ in 0..2 {
            let directory = fixture
                .root
                .join(format!("{PREFIX}{:032x}", rand::random::<u128>()));
            fs::create_dir(&directory).unwrap();
            write_intent(
                &directory,
                &Intent {
                    version: 1,
                    source: "history.jsonl".into(),
                    artifacts: true,
                    phase: Phase::Prepared,
                },
            )
            .unwrap();
        }
        let (warnings, blocked) = fixture.recover();
        assert_eq!(warnings.len(), 2);
        assert!(blocked.contains(&fixture.session));
        assert_eq!(fixture.transactions().len(), 2);
        fixture.preserved();
    }

    #[test]
    fn settlement_writes_settings_only_for_committed_deletions() {
        for outcome in [
            Err("unchanged".into()),
            Ok(DeleteOutcome::RecoveryRequired("journal retained".into())),
        ] {
            assert!(settle(outcome, || panic!("uncommitted deletion must retain pins")).is_err());
        }
        let warning = settle(
            Ok(DeleteOutcome::Committed(Some("cleanup pending".into()))),
            || Ok(()),
        )
        .unwrap();
        assert_eq!(warning.as_deref(), Some("cleanup pending"));
        let warning = settle(Ok(DeleteOutcome::Committed(None)), || {
            Err("settings failed".into())
        })
        .unwrap()
        .unwrap();
        assert!(warning.contains("settings failed"));
    }

    #[cfg(unix)]
    #[test]
    fn marker_symlinks_and_fifos_are_rejected_without_following_or_waiting() {
        use std::os::unix::{ffi::OsStrExt, fs::symlink};
        for fifo in [false, true] {
            let fixture = Fixture::new();
            let directory = fixture
                .root
                .join(format!("{PREFIX}{:032x}", rand::random::<u128>()));
            fs::create_dir(&directory).unwrap();
            let marker = directory.join("intent.json");
            if fifo {
                let name = std::ffi::CString::new(marker.as_os_str().as_bytes()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            } else {
                symlink(&fixture.session, &marker).unwrap();
            }
            let (warnings, blocked) = fixture.recover();
            assert!(!warnings.is_empty() && blocked.contains(&fixture.session));
            fixture.preserved();
        }
    }

    #[test]
    fn unknown_staged_entries_prevent_cleanup() {
        let fixture = Fixture::new();
        delete_with(&fixture.session, |stage| {
            if stage == "committed" {
                Err("pause".into())
            } else {
                Ok(())
            }
        })
        .unwrap();
        let directory = fixture.transactions().pop().unwrap();
        fs::write(directory.join("unexpected"), b"retain").unwrap();
        assert!(!fixture.recover().0.is_empty());
        assert!(directory.join("session").is_file());
        assert!(directory.join("artifacts/tool.log").is_file());
    }

    #[test]
    fn scanner_never_exposes_staged_history_or_artifact_jsonls() {
        let fixture = Fixture::new();
        fs::write(
            fixture.artifact.parent().unwrap().join("nested.jsonl"),
            b"{\"type\":\"session\",\"id\":\"artifact\",\"cwd\":\"/synthetic\"}\n",
        )
        .unwrap();
        let lease =
            SessionLease::acquire(&fixture.session, SessionLeasePurpose::Delete, false).unwrap();
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _ = delete_with(&fixture.session, |stage| {
                assert_ne!(stage, "session", "injected interruption");
                Ok(())
            });
        }));
        let (sessions, warnings) = crate::sessions::scan_deletion_fixture(&fixture.root).unwrap();
        assert!(sessions.is_empty());
        assert!(!warnings.is_empty());
        drop(lease);
        let (sessions, warnings) = crate::sessions::scan_deletion_fixture(&fixture.root).unwrap();
        assert_eq!(sessions.len(), 1);
        assert!(warnings.is_empty());
        assert_eq!(sessions[0].id, "test");
        fixture.preserved();
    }

    #[test]
    fn recovery_reaches_nested_discoverable_directories() {
        let fixture = Fixture::new();
        let nested = fixture.root.join("one/two/three");
        fs::create_dir_all(&nested).unwrap();
        let session = nested.join("history.jsonl");
        fs::copy(&fixture.session, &session).unwrap();
        drop(SessionLease::acquire(&session, SessionLeasePurpose::Delete, false).unwrap());
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _ = delete_with(&session, |stage| {
                assert_ne!(stage, "session", "injected interruption");
                Ok(())
            });
        }));
        let mut warnings = Vec::new();
        let mut blocked = HashSet::new();
        recover_tree(&fixture.root, 0, &mut warnings, &mut blocked);
        assert!(warnings.is_empty() && blocked.is_empty());
        assert_eq!(
            fs::read(&session).unwrap(),
            fs::read(&fixture.session).unwrap()
        );
    }

    #[test]
    fn interrupted_atomic_metadata_write_does_not_block_rollback() {
        let fixture = Fixture::new();
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _ = delete_with(&fixture.session, |stage| {
                assert_ne!(stage, "session", "injected interruption");
                Ok(())
            });
        }));
        fs::write(
            fixture.transactions()[0].join(".atomic-123-456.tmp"),
            b"partial metadata",
        )
        .unwrap();
        assert!(fixture.recover().0.is_empty());
        fixture.preserved();
        assert!(fixture.transactions().is_empty());
    }

    #[test]
    fn ordinary_jsonl_with_internal_prefix_remains_discoverable() {
        let fixture = Fixture::new();
        fs::rename(
            &fixture.session,
            fixture.root.join(".omp-delete-notes.jsonl"),
        )
        .unwrap();
        let (sessions, _) = crate::sessions::scan_deletion_fixture(&fixture.root).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "test");
        let ordinary = fixture.root.join(".omp-delete-notes");
        fs::create_dir(&ordinary).unwrap();
        fs::copy(
            fixture.root.join(".omp-delete-notes.jsonl"),
            ordinary.join("inside.jsonl"),
        )
        .unwrap();
        // The sibling JSONL above makes this an artifact directory; use another name
        // to check an ordinary, unrelated prefix-matching directory.
        let unrelated = fixture.root.join(".omp-delete-ordinary");
        fs::rename(&ordinary, &unrelated).unwrap();
        let (sessions, _) = crate::sessions::scan_deletion_fixture(&fixture.root).unwrap();
        assert!(sessions
            .iter()
            .any(|session| session.file_path.ends_with("inside.jsonl")));
    }

    #[test]
    fn missing_history_keeps_artifacts_hidden_in_both_recovery_phases() {
        for committed in [false, true] {
            let fixture = Fixture::new();
            let nested = fixture.artifact.parent().unwrap().join("nested.jsonl");
            fs::copy(&fixture.session, nested).unwrap();
            let _ = catch_unwind(AssertUnwindSafe(|| {
                let _ = delete_with(&fixture.session, |stage| {
                    assert_ne!(stage, "session", "injected interruption");
                    Ok(())
                });
            }));
            let directory = fixture.transactions().pop().unwrap();
            fs::remove_file(directory.join("session")).unwrap();
            if committed {
                let mut intent = read_intent(&directory).unwrap();
                intent.phase = Phase::Committed;
                write_intent(&directory, &intent).unwrap();
            }
            let (warnings, blocked) = fixture.recover();
            assert!(!warnings.is_empty() && blocked.contains(&fixture.session));
            assert!(!fixture.artifact.exists());
            assert_eq!(
                fs::read(directory.join("artifacts/tool.log")).unwrap(),
                b"original artifact"
            );
            let (sessions, warnings) =
                crate::sessions::scan_deletion_fixture(&fixture.root).unwrap();
            assert!(sessions.is_empty() && !warnings.is_empty());
            assert!(directory.join("artifacts/nested.jsonl").is_file());
        }
    }

    #[test]
    fn interrupted_rollback_reserves_artifact_directory_while_lease_is_active() {
        let fixture = Fixture::new();
        fs::copy(
            &fixture.session,
            fixture.artifact.parent().unwrap().join("nested.jsonl"),
        )
        .unwrap();
        let lease =
            SessionLease::acquire(&fixture.session, SessionLeasePurpose::Delete, false).unwrap();
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _ = delete_with(&fixture.session, |stage| {
                assert_ne!(stage, "session", "injected interruption");
                Ok(())
            });
        }));
        let directory = fixture.transactions().pop().unwrap();
        let mut intent = read_intent(&directory).unwrap();
        intent.phase = Phase::RollingBack;
        write_intent(&directory, &intent).unwrap();
        move_new(
            &directory.join("artifacts"),
            &fixture.session.with_extension(""),
        )
        .unwrap();
        let (sessions, warnings) = crate::sessions::scan_deletion_fixture(&fixture.root).unwrap();
        assert!(sessions.is_empty() && !warnings.is_empty());
        assert!(fixture
            .artifact
            .parent()
            .unwrap()
            .join("nested.jsonl")
            .is_file());
        drop(lease);
        let (sessions, warnings) = crate::sessions::scan_deletion_fixture(&fixture.root).unwrap();
        assert_eq!(sessions.len(), 1);
        assert!(warnings.is_empty());
        fixture.preserved();
    }

    include!("session_deletion_boundary_tests.rs");
}
