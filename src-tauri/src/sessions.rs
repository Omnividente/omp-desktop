use crate::{
    diagnostics,
    models::{
        AppSettings, BootstrapPayload, CodexSessionSummary, ImportItemResult, ImportItemStatus,
        ImportMode, ImportSessionRequest, SessionSummary, SessionTranscript, TranscriptEntry,
        TranscriptEntryCategory, WorkspaceSummary,
    },
    settings::runtime_info,
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env, fs,
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

const TITLE_SLOT_BYTES: usize = 256;
const CODEX_DISCOVERY_MAX_LINES: usize = 80;
const CODEX_DISCOVERY_MAX_BYTES: usize = 256 * 1024;
const SESSION_SUMMARY_REGION_BYTES: usize = 2 * 1024 * 1024;
const TRANSCRIPT_PREFIX_BYTES: usize = 4 * 1024 * 1024;
const TRANSCRIPT_TAIL_BYTES: usize = 12 * 1024 * 1024;
const MAX_IMPORT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_IMPORT_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_IMPORT_ARTIFACT_ENTRIES: usize = 10_000;
const MAX_IMPORT_ARTIFACT_DEPTH: usize = 16;
const SESSION_TITLE_MAX_CHARS: usize = 80;

#[derive(Clone, Copy, PartialEq, Eq)]
struct SessionFileStamp {
    modified: SystemTime,
    size: u64,
}

#[derive(Clone)]
struct CachedSessionSummary {
    stamp: SessionFileStamp,
    summary: SessionSummary,
    thread_names_stamp: u64,
}

static SESSION_SUMMARY_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedSessionSummary>>> =
    OnceLock::new();

fn session_summary_cache() -> &'static Mutex<HashMap<PathBuf, CachedSessionSummary>> {
    SESSION_SUMMARY_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn session_file_stamp(path: &Path) -> Result<SessionFileStamp, String> {
    let metadata = fs::metadata(path).map_err(|error| {
        format!(
            "Не удалось прочитать метаданные {}: {error}",
            path.display()
        )
    })?;
    let modified = metadata
        .modified()
        .map_err(|error| format!("Не удалось прочитать время {}: {error}", path.display()))?;
    Ok(SessionFileStamp {
        modified,
        size: metadata.len(),
    })
}

fn thread_names_stamp(thread_names: &HashMap<String, String>) -> u64 {
    let mut entries = thread_names.iter().collect::<Vec<_>>();
    entries.sort_unstable_by(|left, right| left.0.cmp(right.0));
    let mut hash = 0xcbf29ce484222325_u64;
    for (id, title) in entries {
        for byte in id.bytes().chain(std::iter::once(0)).chain(title.bytes()) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    hash
}

fn parse_session_cached(
    path: &Path,
    thread_names: &HashMap<String, String>,
    names_stamp: u64,
) -> Result<Option<SessionSummary>, String> {
    let stamp = session_file_stamp(path)?;
    if let Some(summary) = session_summary_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(path)
        .filter(|cached| cached.stamp == stamp && cached.thread_names_stamp == names_stamp)
        .map(|cached| cached.summary.clone())
    {
        return Ok(Some(summary));
    }

    let summary = parse_session_with_names(path, thread_names)?;
    let mut cache = session_summary_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(summary) = summary.as_ref() {
        cache.insert(
            path.to_path_buf(),
            CachedSessionSummary {
                stamp,
                summary: summary.clone(),
                thread_names_stamp: names_stamp,
            },
        );
    } else {
        cache.remove(path);
    }
    Ok(summary)
}

pub fn build_bootstrap(
    app: &AppHandle,
    settings: &AppSettings,
) -> Result<BootstrapPayload, String> {
    let runtime = runtime_info(app, settings)?;
    let mut sessions = scan_sessions(Path::new(&runtime.session_root))?;
    for session in &mut sessions {
        apply_session_title_pin(session, &settings.session_title_pins);
    }
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    let workspaces = build_workspaces(&sessions, settings);

    Ok(BootstrapPayload {
        settings: settings.clone(),
        runtime,
        workspaces,
        sessions,
    })
}

pub fn path_key(path: &str) -> String {
    let resolved = Path::new(path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path));
    let normalized = normalize_windows_verbatim_path(resolved);
    lexical_path_key(&normalized.to_string_lossy())
}

fn lexical_path_key(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized.to_owned()
    }
}

pub fn canonical_project_path(path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path);
    if !candidate.is_dir() {
        return Err(format!("Папка проекта не найдена: {}", candidate.display()));
    }
    candidate
        .canonicalize()
        .map(normalize_windows_verbatim_path)
        .map_err(|error| {
            format!(
                "Не удалось определить физический путь {}: {error}",
                candidate.display()
            )
        })
}

pub(crate) fn apply_session_title_pin(
    session: &mut SessionSummary,
    pins: &BTreeMap<String, String>,
) {
    session.pinned_title = pins
        .get(&path_key(&session.file_path))
        .or_else(|| pins.get(&lexical_path_key(&session.file_path)))
        .cloned();
    if let Some(title) = session.pinned_title.as_ref() {
        session.title.clone_from(title);
    }
}

fn normalize_windows_verbatim_path(path: PathBuf) -> PathBuf {
    if !cfg!(windows) {
        return path;
    }
    let normalized = {
        let text = path.to_string_lossy();
        text.strip_prefix(r"\\?\UNC\")
            .map(|stripped| PathBuf::from(format!(r"\\{stripped}")))
            .or_else(|| text.strip_prefix(r"\\?\").map(PathBuf::from))
    };
    normalized.unwrap_or(path)
}

/// Source contract: keep the `-`, `-tmp`, and `--…--` encodings, including case and separator handling, because existing session directories depend on them.
pub fn encode_session_dir_name(cwd: &str) -> String {
    let resolved = PathBuf::from(cwd);
    let resolved = normalize_windows_verbatim_path(
        resolved
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(cwd)),
    );
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .map(normalize_windows_verbatim_path);
    let temp = normalize_windows_verbatim_path(env::temp_dir());

    if let Some(home) = home.as_ref() {
        if let Ok(rel) = resolved.strip_prefix(home) {
            return encode_relative_session_dir_name("-", &rel.to_string_lossy());
        }
    }
    if let Ok(rel) = resolved.strip_prefix(&temp) {
        return encode_relative_session_dir_name("-tmp", &rel.to_string_lossy());
    }

    let text = resolved.to_string_lossy();
    let stripped = text.trim_start_matches(['/', '\\']);
    format!(
        "--{}--",
        stripped.replace(['/', '\\', ':'], "-").trim_matches('-')
    )
}

fn encode_relative_session_dir_name(prefix: &str, relative: &str) -> String {
    let encoded = relative.replace(['/', '\\', ':'], "-");
    if encoded.is_empty() {
        prefix.trim_end_matches('-').to_owned()
    } else if prefix.ends_with('-') {
        format!("{prefix}{encoded}")
    } else {
        format!("{prefix}-{encoded}")
    }
}
pub(crate) fn atomic_write_file(destination: &Path, contents: &[u8]) -> Result<(), String> {
    atomic_write_file_with(destination, contents, replace_file_atomically)
}

fn atomic_write_file_with<F>(destination: &Path, contents: &[u8], replace: F) -> Result<(), String>
where
    F: FnOnce(&Path, &Path) -> io::Result<()>,
{
    let parent = destination.parent().ok_or_else(|| {
        format!(
            "Не удалось определить каталог для {}",
            destination.display()
        )
    })?;
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("session.jsonl");
    let permissions = fs::metadata(destination)
        .ok()
        .map(|metadata| metadata.permissions());

    let mut temporary = None;
    for _ in 0..16 {
        let candidate = parent.join(format!(
            ".{file_name}.{}.{}.tmp",
            std::process::id(),
            rand::random::<u64>()
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => {
                temporary = Some((candidate, file));
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Не удалось создать временный файл рядом с {}: {error}",
                    destination.display()
                ))
            }
        }
    }
    let (temporary_path, mut temporary_file) = temporary.ok_or_else(|| {
        format!(
            "Не удалось создать уникальный временный файл рядом с {}",
            destination.display()
        )
    })?;

    let result = (|| -> io::Result<()> {
        temporary_file.write_all(contents)?;
        temporary_file.flush()?;
        if let Some(permissions) = permissions {
            temporary_file.set_permissions(permissions)?;
        } else {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                temporary_file.set_permissions(fs::Permissions::from_mode(0o600))?;
            }
        }
        temporary_file.sync_all()?;
        drop(temporary_file);
        replace(&temporary_path, destination)
    })();

    if let Err(error) = result {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!(
            "Не удалось атомарно записать {}: {error}",
            destination.display()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file_atomically(temporary: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(temporary, destination)
}

#[cfg(windows)]
fn replace_file_atomically(temporary: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    let temporary = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            temporary.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub fn validated_session_file(path: &str, session_root: &Path) -> Result<PathBuf, String> {
    let root = session_root
        .canonicalize()
        .map(normalize_windows_verbatim_path)
        .map_err(|error| {
            format!(
                "Не удалось открыть папку сессий {}: {error}",
                session_root.display()
            )
        })?;
    let file = Path::new(path)
        .canonicalize()
        .map(normalize_windows_verbatim_path)
        .map_err(|error| format!("Файл сессии не найден: {path}: {error}"))?;
    if !file.starts_with(&root)
        || file
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("jsonl"))
        || !file.is_file()
    {
        return Err("Разрешены только JSONL-файлы из папки сессий OMP".to_owned());
    }
    Ok(file)
}

pub fn delete_session(path: &str, session_root: &Path) -> Result<(), String> {
    let file = validated_session_file(path, session_root)?;

    let artifact_dir = file.with_extension("");
    if let Ok(metadata) = fs::symlink_metadata(&artifact_dir) {
        if metadata.file_type().is_symlink() {
            fs::remove_file(&artifact_dir).map_err(|error| {
                format!(
                    "Не удалось удалить ссылку на артефакты {}: {error}",
                    artifact_dir.display()
                )
            })?;
        } else if metadata.is_dir() {
            fs::remove_dir_all(&artifact_dir).map_err(|error| {
                format!(
                    "Не удалось удалить артефакты {}: {error}",
                    artifact_dir.display()
                )
            })?;
        }
    }
    fs::remove_file(&file)
        .map_err(|error| format!("Не удалось удалить сессию {}: {error}", file.display()))
}

pub fn import_sessions(
    requests: &[ImportSessionRequest],
    session_root: &Path,
) -> Vec<ImportItemResult> {
    requests
        .iter()
        .map(|request| match import_session(request, session_root) {
            Ok(result) => result,
            Err(message) => ImportItemResult {
                source_path: request.path.clone(),
                destination_path: None,
                status: ImportItemStatus::Failed,
                message: Some(message),
            },
        })
        .collect()
}

fn import_session(
    request: &ImportSessionRequest,
    session_root: &Path,
) -> Result<ImportItemResult, String> {
    let source = validated_external_import_source(&request.path)?;
    let target = canonical_project_path(request.target_cwd.trim())?;
    let target_cwd = target.to_string_lossy().into_owned();
    let bytes = read_bounded_import_source(&source)?;
    let text = String::from_utf8_lossy(&bytes);
    let imported = if looks_like_codex_session(&text) {
        import_codex_session(
            &source,
            &text,
            &bytes,
            &target_cwd,
            session_root,
            request.mode,
        )?
    } else {
        import_omp_session(&source, &bytes, &target_cwd, session_root, request.mode)?
    };
    Ok(ImportItemResult {
        source_path: request.path.clone(),
        destination_path: Some(imported.path.to_string_lossy().into_owned()),
        status: imported.status,
        message: None,
    })
}

fn import_size_error() -> String {
    format!(
        "Файл импорта больше поддерживаемого лимита {} MiB",
        MAX_IMPORT_BYTES / (1024 * 1024)
    )
}

fn read_bounded_import_source(source: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(source)
        .map_err(|error| format!("Не удалось открыть {}: {error}", source.display()))?;
    let metadata = file.metadata().map_err(|error| {
        format!(
            "Не удалось прочитать метаданные {}: {error}",
            source.display()
        )
    })?;
    if !metadata.is_file() {
        return Err("Импортировать можно только обычный JSONL-файл, не ссылку".to_owned());
    }
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err(import_size_error());
    }

    let (bytes, overflow) = read_import_bytes(file, MAX_IMPORT_BYTES)
        .map_err(|error| format!("Не удалось прочитать {}: {error}", source.display()))?;
    if overflow {
        return Err(import_size_error());
    }
    Ok(bytes)
}

fn read_import_bytes<R: Read>(reader: R, max_bytes: u64) -> io::Result<(Vec<u8>, bool)> {
    let mut bytes = Vec::new();
    reader.take(max_bytes + 1).read_to_end(&mut bytes)?;
    let overflow = bytes.len() as u64 > max_bytes;
    if overflow {
        bytes.truncate(max_bytes as usize);
    }
    Ok((bytes, overflow))
}

fn validated_external_import_source(path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path);
    let metadata = fs::symlink_metadata(candidate)
        .map_err(|error| format!("Файл сессии не найден: {path}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Импортировать можно только обычный JSONL-файл, не ссылку".to_owned());
    }
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err(import_size_error());
    }
    if candidate
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("jsonl"))
    {
        return Err("Импортировать можно только JSONL-файл".to_owned());
    }
    candidate
        .canonicalize()
        .map(normalize_windows_verbatim_path)
        .map_err(|error| format!("Не удалось определить путь {path}: {error}"))
}

struct TranscriptRegions {
    prefix: Vec<u8>,
    tail: Vec<u8>,
    truncated: bool,
}

pub fn read_session_transcript(
    path: &str,
    session_root: &Path,
) -> Result<SessionTranscript, String> {
    read_session_transcript_with_limits(
        path,
        session_root,
        TRANSCRIPT_PREFIX_BYTES,
        TRANSCRIPT_TAIL_BYTES,
    )
}

fn read_session_transcript_with_limits(
    path: &str,
    session_root: &Path,
    prefix_limit: usize,
    tail_limit: usize,
) -> Result<SessionTranscript, String> {
    let path = validated_session_file(path, session_root)?;
    let session = parse_session(&path)?
        .ok_or_else(|| format!("Не удалось найти session header в {}", path.display()))?;
    let regions = read_transcript_regions(&path, prefix_limit, tail_limit)?;
    let mut entries = Vec::new();
    let mut line_index = 0_usize;
    parse_transcript_region(&regions.prefix, &mut line_index, &mut entries);
    parse_transcript_region(&regions.tail, &mut line_index, &mut entries);

    Ok(SessionTranscript {
        session,
        entries,
        updated_at: modified_millis(&path),
        truncated: regions.truncated,
    })
}

fn read_transcript_regions(
    path: &Path,
    prefix_limit: usize,
    tail_limit: usize,
) -> Result<TranscriptRegions, String> {
    if prefix_limit == 0 || tail_limit == 0 {
        return Err("Лимиты чтения транскрипта должны быть больше нуля".to_owned());
    }
    let total_limit = prefix_limit
        .checked_add(tail_limit)
        .ok_or_else(|| "Лимит чтения транскрипта слишком велик".to_owned())?;
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Не удалось открыть {}: {error}", path.display()))?;
    let declared_size = file
        .metadata()
        .map_err(|error| {
            format!(
                "Не удалось прочитать метаданные {}: {error}",
                path.display()
            )
        })?
        .len();

    if declared_size <= total_limit as u64 {
        let mut full = Vec::new();
        Read::by_ref(&mut file)
            .take(total_limit as u64 + 1)
            .read_to_end(&mut full)
            .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display()))?;
        if full.len() <= total_limit {
            return Ok(TranscriptRegions {
                prefix: full,
                tail: Vec::new(),
                truncated: false,
            });
        }
    }

    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("Не удалось перейти к началу {}: {error}", path.display()))?;
    let mut prefix = Vec::with_capacity(prefix_limit);
    Read::by_ref(&mut file)
        .take(prefix_limit as u64)
        .read_to_end(&mut prefix)
        .map_err(|error| format!("Не удалось прочитать начало {}: {error}", path.display()))?;
    trim_trailing_partial_line(&mut prefix);

    let current_size = file
        .metadata()
        .map_err(|error| format!("Не удалось обновить метаданные {}: {error}", path.display()))?
        .len()
        .max(declared_size);
    file.seek(SeekFrom::Start(
        current_size.saturating_sub(tail_limit as u64),
    ))
    .map_err(|error| format!("Не удалось перейти к концу {}: {error}", path.display()))?;
    let mut tail = Vec::with_capacity(tail_limit);
    Read::by_ref(&mut file)
        .take(tail_limit as u64)
        .read_to_end(&mut tail)
        .map_err(|error| format!("Не удалось прочитать конец {}: {error}", path.display()))?;
    if let Some(first_newline) = tail.iter().position(|byte| *byte == b'\n') {
        tail.drain(..=first_newline);
    } else {
        tail.clear();
    }

    Ok(TranscriptRegions {
        prefix,
        tail,
        truncated: true,
    })
}

fn trim_trailing_partial_line(bytes: &mut Vec<u8>) {
    if bytes.last() == Some(&b'\n') {
        return;
    }
    if let Some(last_newline) = bytes.iter().rposition(|byte| *byte == b'\n') {
        bytes.truncate(last_newline + 1);
    } else {
        bytes.clear();
    }
}

fn parse_transcript_region(
    region: &[u8],
    line_index: &mut usize,
    entries: &mut Vec<TranscriptEntry>,
) {
    for line in region.split(|byte| *byte == b'\n') {
        let current_index = *line_index;
        *line_index = line_index.saturating_add(1);
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if let Some(entry) = transcript_entry_from_value(&value, current_index) {
            entries.push(entry);
        }
    }
}

fn transcript_entry_from_value(value: &Value, line_index: usize) -> Option<TranscriptEntry> {
    let event_type = value.get("type").and_then(Value::as_str)?;
    let id = value
        .get("id")
        .and_then(value_to_string)
        .unwrap_or_else(|| format!("transcript-{line_index}"));
    let timestamp = value
        .get("timestamp")
        .and_then(value_to_string)
        .or_else(|| {
            value
                .get("message")
                .and_then(|message| message.get("timestamp"))
                .and_then(value_to_string)
        })
        .unwrap_or_default();

    match event_type {
        "message" => {
            let message = value.get("message").unwrap_or(value);
            let role = message.get("role").and_then(Value::as_str)?.to_owned();
            let (mut text, mut dialogue_text) = transcript_content_texts(message.get("content"));
            if !matches!(
                role.trim().to_ascii_lowercase().as_str(),
                "user" | "assistant"
            ) {
                dialogue_text.clear();
            }
            if text.trim().is_empty() {
                if let Some(error) = message.get("errorMessage").and_then(Value::as_str) {
                    text = format!("Ошибка: {error}");
                }
            }
            if text.trim().is_empty() {
                return None;
            }
            let dialogue_text = (!dialogue_text.trim().is_empty()).then_some(dialogue_text);
            let category = if dialogue_text.is_some() {
                TranscriptEntryCategory::Dialogue
            } else {
                TranscriptEntryCategory::Service
            };
            Some(TranscriptEntry {
                id,
                timestamp,
                role,
                text,
                dialogue_text,
                category,
                kind: Some(event_type.to_owned()),
                model: message
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| {
                        value
                            .get("model")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    }),
            })
        }
        "model_change" => {
            let model = value.get("model").and_then(Value::as_str)?.to_owned();
            Some(TranscriptEntry {
                id,
                timestamp,
                role: "system".to_owned(),
                text: format!("Модель: {model}"),
                dialogue_text: None,
                category: TranscriptEntryCategory::Service,
                kind: Some(event_type.to_owned()),
                model: Some(model),
            })
        }
        "thinking_level_change" => {
            let level = value
                .get("thinkingLevel")
                .and_then(Value::as_str)
                .or_else(|| value.get("configured").and_then(Value::as_str))?;
            Some(TranscriptEntry {
                id,
                timestamp,
                role: "system".to_owned(),
                text: format!("Уровень рассуждений: {level}"),
                dialogue_text: None,
                category: TranscriptEntryCategory::Service,
                kind: Some(event_type.to_owned()),
                model: None,
            })
        }
        "custom" | "custom_message" => {
            let custom_type = value
                .get("customType")
                .and_then(Value::as_str)
                .unwrap_or(event_type);
            let text = value
                .get("content")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| value.get("data").map(render_json_value))
                .filter(|text| !text.trim().is_empty())?;
            Some(TranscriptEntry {
                id,
                timestamp,
                role: "event".to_owned(),
                text,
                dialogue_text: None,
                category: TranscriptEntryCategory::Service,
                kind: Some(custom_type.to_owned()),
                model: None,
            })
        }
        _ => None,
    }
}

fn transcript_content_texts(content: Option<&Value>) -> (String, String) {
    let Some(content) = content else {
        return (String::new(), String::new());
    };
    if let Some(text) = content.as_str() {
        return (text.to_owned(), text.to_owned());
    }
    let Some(items) = content.as_array() else {
        return (String::new(), String::new());
    };
    let mut parts = Vec::new();
    let mut dialogue_parts = Vec::new();
    for item in items {
        let Some(item_type) = item.get("type").and_then(Value::as_str) else {
            if let Some(text) = item.as_str() {
                parts.push(text.to_owned());
                dialogue_parts.push(text.to_owned());
            }
            continue;
        };
        match item_type {
            "text" | "input_text" | "output_text" => {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    parts.push(text.to_owned());
                    dialogue_parts.push(text.to_owned());
                }
            }
            "thinking" => {
                if let Some(text) = item
                    .get("thinking")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("text").and_then(Value::as_str))
                {
                    parts.push(text.to_owned());
                }
            }
            "toolCall" | "tool_use" | "function_call" => {
                let name = item.get("name").and_then(Value::as_str).unwrap_or("tool");
                let arguments = item
                    .get("arguments")
                    .or_else(|| item.get("input"))
                    .map(render_json_value)
                    .unwrap_or_default();
                if arguments.is_empty() {
                    parts.push(format!("Инструмент: {name}"));
                } else {
                    parts.push(format!("Инструмент: {name}\n{arguments}"));
                }
            }
            _ => {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    parts.push(text.to_owned());
                }
            }
        }
    }
    (parts.join("\n\n"), dialogue_parts.join("\n\n"))
}

fn value_to_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_number().map(ToString::to_string))
}

fn render_json_value(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

pub fn list_codex_sessions() -> Result<Vec<CodexSessionSummary>, String> {
    let root = codex_sessions_root();
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    collect_jsonl_files(&root, 0, 8, &mut files)?;
    let thread_names = load_codex_thread_names();
    let sessions = files
        .into_iter()
        .filter_map(|path| {
            parse_codex_session_with_names(&path, &thread_names)
                .ok()
                .flatten()
        })
        .collect::<Vec<_>>();
    Ok(deduplicate_codex_sessions(sessions))
}

fn deduplicate_codex_sessions(mut sessions: Vec<CodexSessionSummary>) -> Vec<CodexSessionSummary> {
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    let mut seen = HashSet::with_capacity(sessions.len());
    sessions.retain(|session| seen.insert(session.id.clone()));
    sessions
}

#[derive(Debug)]
struct ImportedSession {
    path: PathBuf,
    status: ImportItemStatus,
}

struct ImportDestination {
    path: PathBuf,
    session_id: String,
    status: ImportItemStatus,
    should_write: bool,
}

fn stable_import_hash(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn import_destination(
    session_root: &Path,
    target_cwd: &str,
    source_kind: &str,
    source_id: &str,
    mode: ImportMode,
) -> Result<ImportDestination, String> {
    let destination_directory = session_root.join(encode_session_dir_name(target_cwd));
    fs::create_dir_all(&destination_directory).map_err(|error| {
        format!(
            "Не удалось создать {}: {error}",
            destination_directory.display()
        )
    })?;
    let import_key = stable_import_hash(format!("{source_kind}\0{source_id}").as_bytes());
    let stem = format!("imported-{source_kind}-{import_key:016x}");
    let primary = destination_directory.join(format!("{stem}.jsonl"));
    let primary_exists = match fs::symlink_metadata(&primary) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(format!(
                    "Путь назначения импорта занят посторонним объектом: {}",
                    primary.display()
                ));
            }
            true
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(format!(
                "Не удалось проверить назначение импорта {}: {error}",
                primary.display()
            ))
        }
    };
    if primary_exists
        && mode != ImportMode::Copy
        && !existing_import_matches_source(&primary, source_kind, source_id)?
    {
        return Err(format!(
            "Конфликт идентификатора импорта: {} принадлежит другому источнику",
            primary.display()
        ));
    }

    match mode {
        ImportMode::Skip if primary_exists => Ok(ImportDestination {
            path: primary,
            session_id: stem,
            status: ImportItemStatus::Skipped,
            should_write: false,
        }),
        ImportMode::Update => Ok(ImportDestination {
            status: if primary_exists {
                ImportItemStatus::Updated
            } else {
                ImportItemStatus::Imported
            },
            path: primary,
            session_id: stem,
            should_write: true,
        }),
        ImportMode::Copy => {
            let mut copy_index = 1_u64;
            loop {
                let copy_stem = format!("{stem}-copy-{copy_index}");
                let path = destination_directory.join(format!("{copy_stem}.jsonl"));
                if !path.exists() {
                    break Ok(ImportDestination {
                        path,
                        session_id: copy_stem,
                        status: ImportItemStatus::Copied,
                        should_write: true,
                    });
                }
                copy_index = copy_index
                    .checked_add(1)
                    .ok_or_else(|| "Исчерпан диапазон имён копий импорта".to_owned())?;
            }
        }
        ImportMode::Skip => Ok(ImportDestination {
            path: primary,
            session_id: stem,
            status: ImportItemStatus::Imported,
            should_write: true,
        }),
    }
}

fn existing_import_matches_source(
    path: &Path,
    source_kind: &str,
    source_id: &str,
) -> Result<bool, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("Не удалось открыть {}: {error}", path.display()))?;
    let mut prefix = Vec::new();
    file.take(64 * 1024)
        .read_to_end(&mut prefix)
        .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display()))?;
    for line in prefix.split(|byte| *byte == b'\n').take(16) {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("session") {
            continue;
        }
        let direct_match = value.get("importSource").is_some_and(|source| {
            source.get("type").and_then(Value::as_str) == Some(source_kind)
                && source.get("id").and_then(Value::as_str) == Some(source_id)
        });
        let codex_match = source_kind == "codex"
            && value.get("parentSession").and_then(Value::as_str)
                == Some(format!("codex:{source_id}").as_str());
        return Ok(direct_match || codex_match);
    }
    Ok(false)
}

#[derive(Clone, Copy)]
struct ArtifactLimits {
    max_bytes: u64,
    max_entries: usize,
    max_depth: usize,
}

struct ArtifactBudget {
    bytes: u64,
    entries: usize,
}

fn stage_import_artifacts(source: &Path, destination: &Path) -> Result<Option<PathBuf>, String> {
    stage_import_artifacts_with_limits(
        source,
        destination,
        ArtifactLimits {
            max_bytes: MAX_IMPORT_ARTIFACT_BYTES,
            max_entries: MAX_IMPORT_ARTIFACT_ENTRIES,
            max_depth: MAX_IMPORT_ARTIFACT_DEPTH,
        },
    )
}

fn stage_import_artifacts_with_limits(
    source: &Path,
    destination: &Path,
    limits: ArtifactLimits,
) -> Result<Option<PathBuf>, String> {
    let source_artifacts = source.with_extension("");
    let metadata = match fs::symlink_metadata(&source_artifacts) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Не удалось проверить артефакты {}: {error}",
                source_artifacts.display()
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "Артефакты импорта должны быть обычным каталогом: {}",
            source_artifacts.display()
        ));
    }

    let staging = create_import_sidecar_directory(destination, "artifacts-stage")?;
    let mut budget = ArtifactBudget {
        bytes: 0,
        entries: 0,
    };
    if let Err(error) =
        copy_import_artifact_directory(&source_artifacts, &staging, 0, &limits, &mut budget)
    {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    Ok(Some(staging))
}

fn create_import_sidecar_directory(destination: &Path, label: &str) -> Result<PathBuf, String> {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let stem = destination
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("import");
    for _ in 0..16 {
        let candidate = parent.join(format!(
            ".{stem}.{label}.{}.{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Не удалось создать временный каталог рядом с {}: {error}",
                    destination.display()
                ))
            }
        }
    }
    Err(format!(
        "Не удалось создать уникальный временный каталог рядом с {}",
        destination.display()
    ))
}

fn unique_import_sidecar_path(destination: &Path, label: &str) -> Result<PathBuf, String> {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let stem = destination
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("import");
    for _ in 0..16 {
        let candidate = parent.join(format!(
            ".{stem}.{label}.{}.{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        match fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(candidate),
            Ok(_) => continue,
            Err(error) => {
                return Err(format!(
                    "Не удалось проверить временный путь {}: {error}",
                    candidate.display()
                ))
            }
        }
    }
    Err(format!(
        "Не удалось подобрать уникальный временный путь рядом с {}",
        destination.display()
    ))
}

fn copy_import_artifact_directory(
    source: &Path,
    destination: &Path,
    depth: usize,
    limits: &ArtifactLimits,
    budget: &mut ArtifactBudget,
) -> Result<(), String> {
    if depth > limits.max_depth {
        return Err(format!(
            "Артефакты импорта глубже поддерживаемого лимита {}",
            limits.max_depth
        ));
    }
    let source_metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("Не удалось проверить {}: {error}", source.display()))?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
        return Err(format!(
            "Артефакты импорта содержат ссылку или не-каталог: {}",
            source.display()
        ));
    }
    let entries = fs::read_dir(source)
        .map_err(|error| format!("Не удалось прочитать {}: {error}", source.display()))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Не удалось прочитать {}: {error}", source.display()))?;
        budget.entries = budget
            .entries
            .checked_add(1)
            .ok_or_else(|| "Слишком много артефактов импорта".to_owned())?;
        if budget.entries > limits.max_entries {
            return Err(format!(
                "Артефактов импорта больше поддерживаемого лимита {}",
                limits.max_entries
            ));
        }

        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| format!("Не удалось проверить {}: {error}", source_path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Артефакты импорта не могут содержать ссылки: {}",
                source_path.display()
            ));
        }
        if metadata.is_dir() {
            fs::create_dir(&destination_path).map_err(|error| {
                format!("Не удалось создать {}: {error}", destination_path.display())
            })?;
            copy_import_artifact_directory(
                &source_path,
                &destination_path,
                depth + 1,
                limits,
                budget,
            )?;
            continue;
        }
        if !metadata.is_file() {
            return Err(format!(
                "Артефакты импорта могут содержать только обычные файлы и каталоги: {}",
                source_path.display()
            ));
        }

        let input = fs::File::open(&source_path)
            .map_err(|error| format!("Не удалось открыть {}: {error}", source_path.display()))?;
        let opened_metadata = fs::symlink_metadata(&source_path).map_err(|error| {
            format!(
                "Не удалось повторно проверить {}: {error}",
                source_path.display()
            )
        })?;
        if opened_metadata.file_type().is_symlink()
            || !input
                .metadata()
                .map_err(|error| {
                    format!(
                        "Не удалось прочитать метаданные {}: {error}",
                        source_path.display()
                    )
                })?
                .is_file()
        {
            return Err(format!(
                "Артефакты импорта не могут содержать ссылки: {}",
                source_path.display()
            ));
        }
        let remaining = limits.max_bytes.saturating_sub(budget.bytes);
        if metadata.len() > remaining {
            return Err(format!(
                "Артефакты импорта больше поддерживаемого лимита {} MiB",
                limits.max_bytes / (1024 * 1024)
            ));
        }
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination_path)
            .map_err(|error| {
                format!("Не удалось создать {}: {error}", destination_path.display())
            })?;
        let copied = io::copy(&mut input.take(remaining + 1), &mut output).map_err(|error| {
            format!("Не удалось скопировать {}: {error}", source_path.display())
        })?;
        if copied > remaining {
            return Err(format!(
                "Артефакты импорта больше поддерживаемого лимита {} MiB",
                limits.max_bytes / (1024 * 1024)
            ));
        }
        output.sync_all().map_err(|error| {
            format!(
                "Не удалось сохранить {}: {error}",
                destination_path.display()
            )
        })?;
        budget.bytes += copied;
    }
    Ok(())
}

fn remove_import_artifacts(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Не удалось проверить {}: {error}", path.display())),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "Отказ удаления постороннего объекта на пути артефактов {}",
            path.display()
        ));
    }
    fs::remove_dir_all(path)
        .map_err(|error| format!("Не удалось удалить артефакты {}: {error}", path.display()))
}

fn commit_import(
    destination: &Path,
    body: &[u8],
    staged_artifacts: Option<PathBuf>,
) -> Result<(), String> {
    commit_import_with(
        destination,
        body,
        staged_artifacts,
        atomic_write_file,
        |source, target| {
            fs::rename(source, target).map_err(|error| {
                format!(
                    "Не удалось переместить {} в {}: {error}",
                    source.display(),
                    target.display()
                )
            })
        },
    )
}

fn commit_import_with<W, R>(
    destination: &Path,
    body: &[u8],
    staged_artifacts: Option<PathBuf>,
    mut write_session: W,
    mut rename: R,
) -> Result<(), String>
where
    W: FnMut(&Path, &[u8]) -> Result<(), String>,
    R: FnMut(&Path, &Path) -> Result<(), String>,
{
    // A JSONL-only update must not erase artifacts that are absent from the selected source.
    let Some(staging) = staged_artifacts else {
        return write_session(destination, body);
    };
    // Swap artifacts under reversible sibling names, then commit the JSONL last. Every failure
    // before the JSONL write restores the prior artifact directory or reports the rollback path.
    let target_artifacts = destination.with_extension("");
    let existing_metadata = match fs::symlink_metadata(&target_artifacts) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!(
                "Не удалось проверить артефакты {}: {error}",
                target_artifacts.display()
            ));
        }
    };
    if existing_metadata
        .as_ref()
        .is_some_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_dir())
    {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "Нельзя заменить посторонний объект на пути артефактов {}",
            target_artifacts.display()
        ));
    }

    let backup = if existing_metadata.is_some() {
        let backup = match unique_import_sidecar_path(destination, "artifacts-backup") {
            Ok(backup) => backup,
            Err(error) => {
                let _ = fs::remove_dir_all(&staging);
                return Err(error);
            }
        };
        if let Err(error) = rename(&target_artifacts, &backup) {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        Some(backup)
    } else {
        None
    };

    if let Err(error) = rename(&staging, &target_artifacts) {
        let mut rollback_errors = Vec::new();
        if let Some(backup) = backup.as_ref() {
            if let Err(rollback_error) = rename(backup, &target_artifacts) {
                rollback_errors.push(rollback_error);
            }
        }
        if let Err(cleanup_error) = fs::remove_dir_all(&staging) {
            if cleanup_error.kind() != io::ErrorKind::NotFound {
                rollback_errors.push(format!(
                    "Не удалось очистить {}: {cleanup_error}",
                    staging.display()
                ));
            }
        }
        return Err(import_transaction_error(error, rollback_errors));
    }

    if let Err(error) = write_session(destination, body) {
        let mut rollback_errors = Vec::new();
        let moved_new_aside = match rename(&target_artifacts, &staging) {
            Ok(()) => true,
            Err(rollback_error) => {
                rollback_errors.push(rollback_error);
                false
            }
        };
        if moved_new_aside {
            if let Some(backup) = backup.as_ref() {
                if let Err(rollback_error) = rename(backup, &target_artifacts) {
                    rollback_errors.push(rollback_error);
                }
            }
            if let Err(cleanup_error) = fs::remove_dir_all(&staging) {
                if cleanup_error.kind() != io::ErrorKind::NotFound {
                    rollback_errors.push(format!(
                        "Не удалось очистить {}: {cleanup_error}",
                        staging.display()
                    ));
                }
            }
        }
        return Err(import_transaction_error(error, rollback_errors));
    }

    if let Some(backup) = backup {
        if let Err(error) = remove_import_artifacts(&backup) {
            diagnostics::warn("session.import.cleanup", &error);
        }
    }
    Ok(())
}

fn import_transaction_error(primary: String, rollback_errors: Vec<String>) -> String {
    if rollback_errors.is_empty() {
        primary
    } else {
        format!(
            "{primary}; откат не завершён: {}",
            rollback_errors.join("; ")
        )
    }
}

fn import_omp_session(
    source: &Path,
    bytes: &[u8],
    target_cwd: &str,
    session_root: &Path,
    mode: ImportMode,
) -> Result<ImportedSession, String> {
    let text = String::from_utf8_lossy(bytes);
    if text.trim().is_empty() {
        return Err("Пустой файл сессии".to_owned());
    }
    let mut header = None;
    let mut title_slot = None;
    for line in text.lines().take(12) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("session") if header.is_none() => header = Some(value),
            Some("title") => {
                title_slot = value
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            }
            _ => {}
        }
    }
    let mut header = header.ok_or_else(|| "В файле нет session header".to_owned())?;
    let source_id = header
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("content-{:016x}", stable_import_hash(bytes)));
    let destination = import_destination(session_root, target_cwd, "omp", &source_id, mode)?;
    if !destination.should_write {
        return Ok(ImportedSession {
            path: destination.path,
            status: destination.status,
        });
    }

    let now = now_iso();
    let title = header
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or(title_slot)
        .unwrap_or_else(|| "Imported session".to_owned());
    header["id"] = Value::String(destination.session_id.clone());
    header["cwd"] = Value::String(target_cwd.to_owned());
    header["importSource"] = serde_json::json!({
        "type": "omp",
        "id": source_id.clone(),
        "fingerprint": format!("{:016x}", stable_import_hash(bytes)),
        "path": source.to_string_lossy(),
    });

    let mut body = serialize_title_slot(&title, Some("user"), &now)?;
    body.push_str(&serde_json::to_string(&header).unwrap_or_default());
    body.push('\n');
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if matches!(
                value.get("type").and_then(Value::as_str),
                Some("title" | "session")
            ) {
                continue;
            }
        }
        body.push_str(line);
        body.push('\n');
    }
    let marker = serde_json::json!({
        "type": "custom",
        "id": format!("{:08x}", rand::random::<u32>()),
        "timestamp": now,
        "customType": "omp-desktop-import",
        "data": {
            "sourceType": "omp",
            "sourceId": source_id,
            "sourcePath": source.to_string_lossy(),
            "sourceFingerprint": format!("{:016x}", stable_import_hash(bytes)),
        }
    });
    body.push_str(&serde_json::to_string(&marker).unwrap_or_default());
    body.push('\n');

    let staged_artifacts = stage_import_artifacts(source, &destination.path)?;
    commit_import(&destination.path, body.as_bytes(), staged_artifacts)?;
    Ok(ImportedSession {
        path: destination.path,
        status: destination.status,
    })
}

fn import_codex_session(
    source: &Path,
    text: &str,
    bytes: &[u8],
    target_cwd: &str,
    session_root: &Path,
    mode: ImportMode,
) -> Result<ImportedSession, String> {
    let summary = parse_codex_session(source)?
        .ok_or_else(|| "Не удалось разобрать Codex session".to_owned())?;
    let destination = import_destination(session_root, target_cwd, "codex", &summary.id, mode)?;
    if !destination.should_write {
        return Ok(ImportedSession {
            path: destination.path,
            status: destination.status,
        });
    }
    let now = now_iso();
    let mut body = serialize_title_slot(&summary.title, Some("user"), &now)?;
    let header = serde_json::json!({
        "type": "session",
        "version": 3,
        "id": destination.session_id.clone(),
        "timestamp": summary.created_at.clone().if_empty(&now),
        "cwd": target_cwd,
        "title": summary.title,
        "titleSource": "user",
        "parentSession": format!("codex:{}", summary.id),
        "importSource": {
            "type": "codex",
            "id": summary.id,
            "fingerprint": format!("{:016x}", stable_import_hash(bytes)),
            "path": source.to_string_lossy(),
        },
    });
    body.push_str(&serde_json::to_string(&header).unwrap_or_default());
    body.push('\n');
    if let Some(model) = summary.model.as_ref() {
        let model_change = serde_json::json!({
            "type": "model_change",
            "id": format!("{:08x}", rand::random::<u32>()),
            "parentId": Value::Null,
            "timestamp": now,
            "model": model,
        });
        body.push_str(&serde_json::to_string(&model_change).unwrap_or_default());
        body.push('\n');
    }

    let model_selector = summary.model.as_deref().unwrap_or("openai/codex");
    let (assistant_provider, assistant_model) = model_selector
        .split_once('/')
        .unwrap_or(("openai", model_selector));

    let mut parent = Value::Null;
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        let timestamp = value
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or(&now)
            .to_owned();
        match event_type {
            "response_item" => {
                let payload = value.get("payload").cloned().unwrap_or(Value::Null);
                let role = payload.get("role").and_then(Value::as_str).unwrap_or("");
                let content = extract_text_content(payload.get("content"));
                if content.trim().is_empty() {
                    continue;
                }
                if role != "user" && role != "assistant" && role != "developer" {
                    continue;
                }
                let id = format!("{:08x}", rand::random::<u32>());
                let message_timestamp = codex_message_timestamp(&timestamp);
                let message = if role == "assistant" {
                    serde_json::json!({
                        "role": "assistant",
                        "content": [{"type": "text", "text": content}],
                        "api": "openai-codex-responses",
                        "provider": assistant_provider,
                        "model": assistant_model,
                        "usage": {
                            "input": 0,
                            "output": 0,
                            "cacheRead": 0,
                            "cacheWrite": 0,
                            "totalTokens": 0,
                            "cost": {
                                "input": 0,
                                "output": 0,
                                "cacheRead": 0,
                                "cacheWrite": 0,
                                "total": 0
                            }
                        },
                        "stopReason": "stop",
                        "timestamp": message_timestamp
                    })
                } else {
                    serde_json::json!({
                        "role": if role == "developer" { "user" } else { role },
                        "content": [{"type": "text", "text": content}],
                        "timestamp": message_timestamp
                    })
                };
                let entry = serde_json::json!({
                    "type": "message",
                    "id": id,
                    "parentId": parent,
                    "timestamp": timestamp,
                    "message": message
                });
                body.push_str(&serde_json::to_string(&entry).unwrap_or_default());
                body.push('\n');
                parent = Value::String(id);
            }
            "event_msg" => {
                let payload = value.get("payload").cloned().unwrap_or(Value::Null);
                if payload.get("type").and_then(Value::as_str) == Some("user_message") {
                    let message = payload
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    if message.trim().is_empty() {
                        continue;
                    }
                    let id = format!("{:08x}", rand::random::<u32>());
                    let entry = serde_json::json!({
                        "type": "message",
                        "id": id,
                        "parentId": parent,
                        "timestamp": timestamp,
                        "message": {
                            "role": "user",
                            "content": [{"type": "text", "text": message}],
                            "timestamp": codex_message_timestamp(&timestamp)
                        }
                    });
                    body.push_str(&serde_json::to_string(&entry).unwrap_or_default());
                    body.push('\n');
                    parent = Value::String(id);
                }
            }
            _ => {}
        }
    }

    let note = serde_json::json!({
        "type": "custom",
        "id": format!("{:08x}", rand::random::<u32>()),
        "parentId": parent,
        "timestamp": now,
        "customType": "omp-desktop-import",
        "data": {
            "sourceType": "codex",
            "sourcePath": source.to_string_lossy(),
            "sourceId": summary.id,
            "sourceCwd": summary.cwd,
            "sourceFingerprint": format!("{:016x}", stable_import_hash(bytes)),
        }
    });
    body.push_str(&serde_json::to_string(&note).unwrap_or_default());
    body.push('\n');

    commit_import(&destination.path, body.as_bytes(), None)?;
    Ok(ImportedSession {
        path: destination.path,
        status: destination.status,
    })
}

fn scan_sessions(root: &Path) -> Result<Vec<SessionSummary>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    if !root.is_dir() {
        return Err(format!(
            "Папка сессий не является каталогом: {}",
            root.display()
        ));
    }

    let mut files = Vec::new();
    collect_jsonl_files(root, 0, 3, &mut files)?;
    let current_files = files.iter().cloned().collect::<HashSet<_>>();
    let thread_names = load_codex_thread_names();
    let names_stamp = thread_names_stamp(&thread_names);
    let mut sessions = files
        .into_iter()
        .filter_map(|path| {
            parse_session_cached(&path, &thread_names, names_stamp)
                .ok()
                .flatten()
        })
        .collect::<Vec<_>>();
    session_summary_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .retain(|path, _| current_files.contains(path));

    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    Ok(sessions)
}

fn collect_jsonl_files(
    directory: &Path,
    depth: usize,
    max_depth: usize,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries.flatten().collect::<Vec<_>>(),
        Err(_) if depth > 0 => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Не удалось прочитать {}: {error}",
                directory.display()
            ))
        }
    };
    // Task and subagent JSONLs live inside the parent session's same-stem artifact directory.
    // Keep that execution lineage on disk, but expose only the parent discussion in the sidebar.
    let artifact_directory_names = entries
        .iter()
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            let path = entry.path();
            if !file_type.is_file()
                || !path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl"))
            {
                return None;
            }
            path.file_stem().map(|name| name.to_os_string())
        })
        .collect::<HashSet<_>>();

    for entry in entries {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let is_import_sidecar = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with('.') && name.contains(".artifacts-"));

        if file_type.is_dir() && depth < max_depth {
            if !is_import_sidecar && !artifact_directory_names.contains(&entry.file_name()) {
                collect_jsonl_files(&path, depth + 1, max_depth, files)?;
            }
            continue;
        }

        if !file_type.is_file()
            || !path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl"))
        {
            continue;
        }

        let is_auxiliary = path
            .file_stem()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("__"));
        if !is_auxiliary {
            files.push(path);
        }
    }

    Ok(())
}

pub(crate) fn parse_session(path: &Path) -> Result<Option<SessionSummary>, String> {
    let thread_names = load_codex_thread_names();
    let names_stamp = thread_names_stamp(&thread_names);
    parse_session_cached(path, &thread_names, names_stamp)
}

fn restorable_session_model(
    models: &HashMap<String, String>,
    last_role: Option<&str>,
) -> Option<String> {
    let default_model = models.get("default");
    match last_role {
        None | Some("default" | "fallback") => default_model.cloned(),
        Some(role) => models.get(role).or(default_model).cloned(),
    }
}

struct SessionSummaryRegions {
    prefix: Vec<u8>,
    tail: Vec<u8>,
    truncated: bool,
}

fn read_session_summary_regions(path: &Path) -> Result<SessionSummaryRegions, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Не удалось открыть {}: {error}", path.display()))?;
    let size = file
        .metadata()
        .map_err(|error| {
            format!(
                "Не удалось прочитать метаданные {}: {error}",
                path.display()
            )
        })?
        .len();
    let full_read_limit = (SESSION_SUMMARY_REGION_BYTES * 2) as u64;
    if size <= full_read_limit {
        let mut prefix = Vec::with_capacity(size as usize);
        file.read_to_end(&mut prefix)
            .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display()))?;
        return Ok(SessionSummaryRegions {
            prefix,
            tail: Vec::new(),
            truncated: false,
        });
    }

    let mut prefix = Vec::with_capacity(SESSION_SUMMARY_REGION_BYTES);
    Read::by_ref(&mut file)
        .take(SESSION_SUMMARY_REGION_BYTES as u64)
        .read_to_end(&mut prefix)
        .map_err(|error| format!("Не удалось прочитать начало {}: {error}", path.display()))?;
    file.seek(SeekFrom::Start(
        size.saturating_sub(SESSION_SUMMARY_REGION_BYTES as u64),
    ))
    .map_err(|error| format!("Не удалось перейти к концу {}: {error}", path.display()))?;
    let mut tail = Vec::with_capacity(SESSION_SUMMARY_REGION_BYTES);
    file.read_to_end(&mut tail)
        .map_err(|error| format!("Не удалось прочитать конец {}: {error}", path.display()))?;
    if let Some(first_newline) = tail.iter().position(|byte| *byte == b'\n') {
        tail.drain(..=first_newline);
    } else {
        tail.clear();
    }
    Ok(SessionSummaryRegions {
        prefix,
        tail,
        truncated: true,
    })
}

fn bytes_contain(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|candidate| candidate == needle)
}

fn parse_session_with_names(
    path: &Path,
    thread_names: &HashMap<String, String>,
) -> Result<Option<SessionSummary>, String> {
    let regions = read_session_summary_regions(path)?;
    let mut line_index = 0_usize;
    let mut id = None;
    let mut cwd = None;
    let mut title = None;
    let mut session_title = None;
    let mut codex_parent_id = None;
    let mut parent_session_path = None;
    let mut created_at = None;
    let mut models = HashMap::new();
    let mut last_model_role = None;
    let mut thinking_level = None;
    let mut configured_thinking_level = None;
    let mut has_messages = false;
    let mut primary_provider_pinned = false;

    for line in regions
        .prefix
        .split(|byte| *byte == b'\n')
        .chain(regions.tail.split(|byte| *byte == b'\n'))
    {
        if line.is_empty() {
            continue;
        }
        let parse_prefix = line_index < 12;
        line_index += 1;
        if !parse_prefix
            && !bytes_contain(line, b"\"model_change\"")
            && !bytes_contain(line, b"\"thinking_level_change\"")
            && !bytes_contain(line, b"\"title_change\"")
            && !bytes_contain(line, b"\"message\"")
            && !bytes_contain(line, b"\"primary_provider_pin\"")
        {
            continue;
        }

        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("title" | "title_change") => {
                let candidate = value
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if candidate.as_ref().is_some_and(|t| !t.trim().is_empty()) {
                    title = candidate;
                }
            }
            Some("session") => {
                id = value.get("id").and_then(Value::as_str).map(str::to_owned);
                cwd = value.get("cwd").and_then(Value::as_str).map(str::to_owned);
                created_at = value
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                session_title = value
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if let Some(parent) = value.get("parentSession").and_then(Value::as_str) {
                    if let Some(codex_id) = parent.strip_prefix("codex:") {
                        codex_parent_id = Some(codex_id.to_owned());
                    } else if !parent.trim().is_empty() {
                        parent_session_path = Some(parent.to_owned());
                    }
                }
            }
            Some("model_change") => {
                if let Some(model) = value.get("model").and_then(Value::as_str) {
                    let role = value
                        .get("role")
                        .and_then(Value::as_str)
                        .unwrap_or("default")
                        .to_owned();
                    models.insert(role.clone(), model.to_owned());
                    last_model_role = Some(role);
                }
            }
            Some("thinking_level_change") => {
                let effective = value
                    .get("thinkingLevel")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                configured_thinking_level = value
                    .get("configured")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| effective.clone());
                thinking_level = effective;
            }
            Some("custom")
                if value.get("customType").and_then(Value::as_str)
                    == Some("primary_provider_pin") =>
            {
                if let Some(pinned) = value.pointer("/data/pinned").and_then(Value::as_bool) {
                    primary_provider_pinned = pinned;
                }
            }
            Some("message" | "custom_message") => {
                let role = value
                    .get("message")
                    .and_then(|m| m.get("role"))
                    .and_then(Value::as_str)
                    .or_else(|| value.get("role").and_then(Value::as_str));
                if role == Some("user") || role == Some("assistant") {
                    has_messages = true;
                }
            }
            _ => {}
        }
    }
    if regions.truncated && !has_messages {
        // A multi-megabyte session is never hidden merely because all dialogue fell in the
        // skipped middle region. The sidebar may over-report a service-only file, but not lose it.
        has_messages = true;
    }
    let model = restorable_session_model(&models, last_model_role.as_deref());

    let (Some(id), Some(cwd)) = (id, cwd) else {
        return Ok(None);
    };
    let updated_at = modified_millis(path);
    let local_title = title
        .or(session_title)
        .filter(|value| !value.trim().is_empty())
        .filter(|value| !is_synthetic_codex_text(value));
    let indexed_title = codex_parent_id.and_then(|id| thread_names.get(&id).cloned());

    Ok(Some(SessionSummary {
        id,
        title: local_title
            .or(indexed_title)
            .unwrap_or_else(|| "Новая сессия".to_owned()),
        pinned_title: None,
        project_key: path_key(&cwd),
        cwd,
        file_path: path.to_string_lossy().into_owned(),
        parent_session_path,
        created_at: created_at.unwrap_or_default(),
        updated_at,
        model,
        thinking_level,
        configured_thinking_level,
        source: "omp".to_owned(),
        has_messages,
        primary_provider_pinned,
    }))
}

fn read_codex_discovery_prefix(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("Не удалось открыть {}: {error}", path.display()))?;
    let mut reader = std::io::BufReader::new(file).take(CODEX_DISCOVERY_MAX_BYTES as u64);
    let mut bytes = Vec::with_capacity(CODEX_DISCOVERY_MAX_BYTES.min(16 * 1024));
    let mut line = Vec::with_capacity(1024);
    for _ in 0..CODEX_DISCOVERY_MAX_LINES {
        line.clear();
        let read = std::io::BufRead::read_until(&mut reader, b'\n', &mut line)
            .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&line);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn parse_codex_session(path: &Path) -> Result<Option<CodexSessionSummary>, String> {
    let thread_names = load_codex_thread_names();
    parse_codex_session_with_names(path, &thread_names)
}

fn parse_codex_session_with_names(
    path: &Path,
    thread_names: &HashMap<String, String>,
) -> Result<Option<CodexSessionSummary>, String> {
    let text = read_codex_discovery_prefix(path)?;
    if !looks_like_codex_session(&text) {
        return Ok(None);
    }

    let mut id = None;
    let mut cwd = None;
    let mut created_at = None;
    let mut model = None;
    let mut model_provider = None;
    let mut title = None;
    let mut preview = String::new();

    for line in text.lines().take(CODEX_DISCOVERY_MAX_LINES) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                let payload = value.get("payload").cloned().unwrap_or(Value::Null);
                id = payload
                    .get("session_id")
                    .or_else(|| payload.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or(id);
                cwd = payload
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or(cwd);
                created_at = value
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or(created_at);
                model_provider = payload
                    .get("model_provider")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or(model_provider);
            }
            Some("turn_context") => {
                let payload = value.get("payload").cloned().unwrap_or(Value::Null);
                cwd = payload
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or(cwd);
                if let Some(m) = payload.get("model").and_then(Value::as_str) {
                    let provider = model_provider.as_deref().unwrap_or_default();
                    model = Some(if provider.is_empty() || m.contains('/') {
                        m.to_owned()
                    } else {
                        format!("{provider}/{m}")
                    });
                }
            }
            Some("event_msg") => {
                let payload = value.get("payload").cloned().unwrap_or(Value::Null);
                if payload.get("type").and_then(Value::as_str) == Some("user_message") {
                    if let Some(message) = payload.get("message").and_then(Value::as_str) {
                        if !is_synthetic_codex_text(message) {
                            if title.is_none() {
                                title = Some(truncate_title(message));
                            }
                            if preview.is_empty() {
                                preview = truncate_preview(message);
                            }
                        }
                    }
                }
            }
            Some("response_item") => {
                let payload = value.get("payload").cloned().unwrap_or(Value::Null);
                if payload.get("role").and_then(Value::as_str) == Some("user") {
                    let content = extract_text_content(payload.get("content"));
                    if !content.trim().is_empty() && !is_synthetic_codex_text(&content) {
                        if title.is_none() {
                            title = Some(truncate_title(&content));
                        }
                        if preview.is_empty() {
                            preview = truncate_preview(&content);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let id = id.unwrap_or_else(|| {
        path.file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("codex-session")
            .to_owned()
    });
    let cwd = cwd.unwrap_or_else(|| "?".to_owned());
    let indexed_title = thread_names.get(&id).cloned();
    Ok(Some(CodexSessionSummary {
        id,
        title: indexed_title
            .or(title)
            .unwrap_or_else(|| "Codex session".to_owned()),
        cwd,
        file_path: path.to_string_lossy().into_owned(),
        created_at: created_at.unwrap_or_default(),
        updated_at: modified_millis(path),
        model: model.or(model_provider),
        preview,
    }))
}

fn is_synthetic_codex_text(value: &str) -> bool {
    let normalized = value.trim_start().to_ascii_lowercase();
    [
        "# agents.md",
        "agents.md instructions",
        "<instructions>",
        "<permissions instructions>",
        "<collaboration_mode>",
        "<multi_agent_mode>",
        "<system-reminder>",
        "<environment_context>",
        "<developer>",
    ]
    .iter()
    .any(|prefix| normalized.starts_with(prefix))
}

fn truncate_preview(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(160)
        .collect()
}
fn looks_like_codex_session(text: &str) -> bool {
    let bytes = text.as_bytes();
    let prefix = &bytes[..bytes.len().min(CODEX_DISCOVERY_MAX_BYTES)];
    prefix
        .split(|byte| *byte == b'\n')
        .take(CODEX_DISCOVERY_MAX_LINES)
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .any(|value| {
            matches!(
                value.get("type").and_then(Value::as_str),
                Some("session_meta" | "turn_context")
            ) || value
                .get("originator")
                .and_then(Value::as_str)
                .is_some_and(|originator| originator.starts_with("codex"))
        })
}

fn extract_text_content(content: Option<&Value>) -> String {
    let Some(content) = content else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_owned();
    }
    let Some(items) = content.as_array() else {
        return String::new();
    };
    items
        .iter()
        .filter_map(|item| {
            item.get("text")
                .and_then(Value::as_str)
                .or_else(|| item.get("input_text").and_then(Value::as_str))
                .or_else(|| item.get("output_text").and_then(Value::as_str))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_workspaces(sessions: &[SessionSummary], settings: &AppSettings) -> Vec<WorkspaceSummary> {
    let mut recent_rank = HashMap::<String, usize>::new();
    for (index, path) in settings.recent_workspaces.iter().enumerate() {
        recent_rank.entry(path_key(path)).or_insert(index);
    }
    let hidden = settings
        .hidden_workspaces
        .iter()
        .map(|path| path_key(path))
        .collect::<HashSet<_>>();
    let mut workspaces = HashMap::<String, WorkspaceSummary>::new();

    for path in &settings.recent_workspaces {
        let key = path_key(path);
        if hidden.contains(&key) {
            continue;
        }
        workspaces
            .entry(key.clone())
            .or_insert_with(|| WorkspaceSummary {
                name: settings
                    .workspace_names
                    .get(&key)
                    .cloned()
                    .unwrap_or_else(|| workspace_name(path)),
                key,
                path: path.clone(),
                session_count: 0,
                last_active: 0,
                pinned: true,
            });
    }

    for session in sessions {
        let key = session.project_key.clone();
        if hidden.contains(&key) {
            continue;
        }
        let workspace = workspaces
            .entry(key.clone())
            .or_insert_with(|| WorkspaceSummary {
                name: settings
                    .workspace_names
                    .get(&key)
                    .cloned()
                    .unwrap_or_else(|| workspace_name(&session.cwd)),
                key,
                path: session.cwd.clone(),
                session_count: 0,
                last_active: 0,
                pinned: false,
            });
        workspace.session_count += 1;
        workspace.last_active = workspace.last_active.max(session.updated_at);
        workspace.pinned |= recent_rank.contains_key(&session.project_key);
    }

    let mut result: Vec<_> = workspaces.into_values().collect();
    result.sort_by(|left, right| {
        let left_rank = recent_rank.get(&left.key).copied();
        let right_rank = recent_rank.get(&right.key).copied();
        match (left_rank, right_rank) {
            (Some(left), Some(right)) => left.cmp(&right),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => right.last_active.cmp(&left.last_active),
        }
    });
    result
}

fn workspace_name(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(path)
        .to_owned()
}

fn clean_title(title: &str) -> Result<String, String> {
    let cleaned = title
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>()
        .trim()
        .to_owned();
    if cleaned.is_empty() {
        return Err("Название сессии не может быть пустым".to_owned());
    }
    Ok(cleaned)
}

pub(crate) fn normalize_pinned_title(title: &str) -> Result<String, String> {
    Ok(truncate_title(&clean_title(title)?))
}

fn truncate_title(value: &str) -> String {
    let one_line = value.lines().next().unwrap_or(value).trim();
    one_line.chars().take(SESSION_TITLE_MAX_CHARS).collect()
}

fn strip_generated_handoff_suffix(title: &str) -> &str {
    let title = title.trim();
    for marker in [" · handoff", " · archive", " · архив"] {
        let Some((base, suffix)) = title.rsplit_once(marker) else {
            continue;
        };
        let numbered = suffix.strip_prefix(' ').is_some_and(|number| {
            !number.is_empty() && number.chars().all(|ch| ch.is_ascii_digit())
        });
        if suffix.is_empty() || numbered {
            return base.trim_end();
        }
    }
    title
}

fn title_with_suffix(base: &str, suffix: &str) -> String {
    let max_base_chars = SESSION_TITLE_MAX_CHARS.saturating_sub(suffix.chars().count());
    let base = base
        .chars()
        .take(max_base_chars.max(1))
        .collect::<String>()
        .trim_end()
        .to_owned();
    format!("{base}{suffix}")
}

pub(crate) fn handoff_session_titles(
    current_title: &str,
    title_pins: &BTreeMap<String, String>,
    archive_label: &str,
) -> Result<(String, String), String> {
    let active_title = normalize_pinned_title(strip_generated_handoff_suffix(current_title))?;
    let archive_label = clean_title(archive_label)?;
    let occupied = title_pins
        .values()
        .map(|title| title.trim().to_lowercase())
        .collect::<HashSet<_>>();

    for index in 1_u64.. {
        let suffix = if index == 1 {
            format!(" · {archive_label}")
        } else {
            format!(" · {archive_label} {index}")
        };
        let archive_title = title_with_suffix(&active_title, &suffix);
        if !occupied.contains(&archive_title.to_lowercase()) {
            return Ok((active_title, archive_title));
        }
    }
    unreachable!("archive title suffix space is unbounded")
}

pub(crate) fn apply_handoff_title_pins(
    previous_path: &str,
    active_path: &str,
    current_title: &str,
    title_pins: &mut BTreeMap<String, String>,
    archive_label: &str,
) -> Result<(String, String), String> {
    let (active_title, archive_title) =
        handoff_session_titles(current_title, title_pins, archive_label)?;
    title_pins.insert(path_key(previous_path), archive_title.clone());
    title_pins.insert(path_key(active_path), active_title.clone());
    Ok((active_title, archive_title))
}

fn serialize_title_slot(
    title: &str,
    source: Option<&str>,
    updated_at: &str,
) -> Result<String, String> {
    let mut low = 0usize;
    let chars = title.chars().collect::<Vec<_>>();
    let mut high = chars.len();
    let mut best = String::new();
    while low <= high {
        let mid = (low + high) / 2;
        let candidate: String = chars.iter().take(mid).collect();
        let line = title_slot_line(&candidate, source, updated_at, "");
        if line.len() <= TITLE_SLOT_BYTES {
            best = candidate;
            low = mid + 1;
        } else if mid == 0 {
            break;
        } else {
            high = mid - 1;
        }
    }
    let unpadded = title_slot_line(&best, source, updated_at, "");
    if unpadded.len() > TITLE_SLOT_BYTES {
        return Err("Название слишком длинное для title slot".to_owned());
    }
    let pad = " ".repeat(TITLE_SLOT_BYTES - unpadded.len());
    let line = title_slot_line(&best, source, updated_at, &pad);
    if line.len() != TITLE_SLOT_BYTES {
        return Err("Не удалось сериализовать title slot".to_owned());
    }
    Ok(line)
}

fn title_slot_line(title: &str, source: Option<&str>, updated_at: &str, pad: &str) -> String {
    let mut slot = serde_json::json!({
        "type": "title",
        "v": 1,
        "title": title,
        "updatedAt": updated_at,
        "pad": pad,
    });
    if let Some(source) = source {
        slot["source"] = Value::String(source.to_owned());
    }
    format!("{}\n", serde_json::to_string(&slot).unwrap_or_default())
}

fn modified_millis(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn codex_message_timestamp(timestamp: &str) -> u64 {
    OffsetDateTime::parse(timestamp, &Rfc3339)
        .ok()
        .and_then(|parsed| u64::try_from(parsed.unix_timestamp_nanos() / 1_000_000).ok())
        .or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()
                .map(|duration| duration.as_millis() as u64)
        })
        .unwrap_or_default()
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs().to_string())
                .unwrap_or_default()
        })
}

fn load_codex_thread_names() -> HashMap<String, String> {
    let Some(index_path) = codex_sessions_root()
        .parent()
        .map(|directory| directory.join("session_index.jsonl"))
    else {
        return HashMap::new();
    };
    let Ok(text) = fs::read_to_string(index_path) else {
        return HashMap::new();
    };

    text.lines()
        .filter_map(|line| {
            let value = serde_json::from_str::<Value>(line).ok()?;
            let id = value.get("id").and_then(Value::as_str)?.trim();
            let thread_name = value.get("thread_name").and_then(Value::as_str)?.trim();
            if id.is_empty() || thread_name.is_empty() {
                return None;
            }
            Some((id.to_owned(), thread_name.to_owned()))
        })
        .collect()
}

fn codex_sessions_root() -> PathBuf {
    if let Some(home) = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")) {
        return PathBuf::from(home).join(".codex").join("sessions");
    }
    PathBuf::from(".codex").join("sessions")
}

trait IfEmpty {
    fn if_empty(self, fallback: &str) -> String;
}

impl IfEmpty for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.trim().is_empty() {
            fallback.to_owned()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_handoff_title_pins, apply_session_title_pin, atomic_write_file,
        atomic_write_file_with, build_workspaces, collect_jsonl_files, commit_import_with,
        deduplicate_codex_sessions, delete_session, encode_relative_session_dir_name,
        encode_session_dir_name, handoff_session_titles, import_destination, import_session,
        parse_codex_session_with_names, parse_session, parse_session_with_names, path_key,
        read_codex_discovery_prefix, read_import_bytes, read_session_transcript,
        read_session_transcript_with_limits, restorable_session_model, scan_sessions,
        serialize_title_slot, stage_import_artifacts_with_limits, validated_external_import_source,
        AppSettings, ArtifactLimits, CodexSessionSummary, ImportItemStatus, ImportMode,
        ImportSessionRequest, SessionSummary, TranscriptEntryCategory, CODEX_DISCOVERY_MAX_BYTES,
        CODEX_DISCOVERY_MAX_LINES, MAX_IMPORT_BYTES,
    };
    use std::{
        collections::{BTreeMap, HashMap},
        fs, io,
        io::{Seek, SeekFrom, Write},
        path::Path,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn path_key_normalizes_separators_and_trailing_slash() {
        let key = path_key(r"D:\Projects\OMP\");
        assert!(!key.ends_with('/'));
        assert!(key.contains("/Projects/") || key.contains("/projects/"));
    }

    #[cfg(unix)]
    #[test]
    fn path_key_resolves_symlink_aliases() {
        use std::os::unix::fs::symlink;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-path-key-{}-{nonce}",
            std::process::id()
        ));
        let project = root.join("project");
        let alias = root.join("project-alias");
        fs::create_dir_all(&project).expect("project fixture should be creatable");
        symlink(&project, &alias).expect("symlink fixture should be creatable");

        assert_eq!(
            path_key(project.to_string_lossy().as_ref()),
            path_key(alias.to_string_lossy().as_ref())
        );

        fs::remove_dir_all(root).expect("fixture should be removable");
    }

    #[cfg(windows)]
    #[test]
    fn path_key_normalizes_case_verbatim_and_unc_forms() {
        assert_eq!(path_key(r"\\?\C:\Work\OMP"), path_key(r"c:\work\omp\"));
        assert_eq!(
            path_key(r"\\?\UNC\Server\Share\Project"),
            path_key(r"\\server\share\project\")
        );
    }

    #[test]
    fn pinned_title_overrides_dynamic_title_by_normalized_path() {
        let mut session = SessionSummary {
            id: "session-1".to_owned(),
            title: "Dynamic activity title".to_owned(),
            pinned_title: None,
            cwd: "D:/Projects/OMP".to_owned(),
            project_key: path_key("D:/Projects/OMP"),
            file_path: r"D:\Sessions\session.jsonl".to_owned(),
            parent_session_path: None,
            created_at: String::new(),
            updated_at: 1,
            model: None,
            thinking_level: None,
            configured_thinking_level: None,
            source: "omp".to_owned(),
            primary_provider_pinned: false,
            has_messages: true,
        };
        let pins = BTreeMap::from([(
            path_key("D:/Sessions/session.jsonl"),
            "Fixed project name".to_owned(),
        )]);

        apply_session_title_pin(&mut session, &pins);

        assert_eq!(session.title, "Fixed project name");
        assert_eq!(session.pinned_title.as_deref(), Some("Fixed project name"));
    }

    #[test]
    fn session_parser_exposes_handoff_parent_path() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "omp-desktop-session-parent-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("fixture directory should be writable");
        let parent = directory.join("parent.jsonl");
        let child = directory.join("child.jsonl");
        fs::write(
            &parent,
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "session",
                    "id": "parent",
                    "timestamp": "2026-08-17T00:00:00Z",
                    "cwd": directory.to_string_lossy(),
                })
            ),
        )
        .expect("parent session should be writable");
        fs::write(
            &child,
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "session",
                    "id": "child",
                    "timestamp": "2026-08-17T00:01:00Z",
                    "cwd": directory.to_string_lossy(),
                    "parentSession": parent.to_string_lossy(),
                })
            ),
        )
        .expect("child session should be writable");

        let summary = parse_session_with_names(&child, &HashMap::new())
            .expect("child session should parse")
            .expect("child session summary should exist");
        fs::remove_dir_all(&directory).expect("fixture directory should be removable");

        assert_eq!(
            summary.parent_session_path.as_deref(),
            Some(parent.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn handoff_titles_keep_active_name_and_number_archives() {
        let mut pins = BTreeMap::new();
        let (active, archive) =
            handoff_session_titles("Release investigation", &pins, "архив").unwrap();
        assert_eq!(active, "Release investigation");
        assert_eq!(archive, "Release investigation · архив");

        pins.insert("first".to_owned(), archive);
        let (active, archive) =
            handoff_session_titles("Release investigation · handoff", &pins, "архив").unwrap();
        assert_eq!(active, "Release investigation");
        assert_eq!(archive, "Release investigation · архив 2");

        pins.insert("second".to_owned(), archive);
        let (active, archive) =
            handoff_session_titles("Release investigation · архив 2", &pins, "архив").unwrap();
        assert_eq!(active, "Release investigation");
        assert_eq!(archive, "Release investigation · архив 3");
    }

    #[test]
    fn handoff_title_pins_archive_previous_and_keep_active_name() {
        let first = "D:/Sessions/first.jsonl";
        let second = "D:/Sessions/second.jsonl";
        let third = "D:/Sessions/third.jsonl";
        let mut pins = BTreeMap::from([(path_key(first), "Release investigation".to_owned())]);

        apply_handoff_title_pins(first, second, "Release investigation", &mut pins, "архив")
            .unwrap();
        assert_eq!(
            pins.get(&path_key(first)).map(String::as_str),
            Some("Release investigation · архив")
        );
        assert_eq!(
            pins.get(&path_key(second)).map(String::as_str),
            Some("Release investigation")
        );

        let active_title = pins.get(&path_key(second)).cloned().unwrap();
        apply_handoff_title_pins(second, third, &active_title, &mut pins, "архив").unwrap();
        assert_eq!(
            pins.get(&path_key(first)).map(String::as_str),
            Some("Release investigation · архив")
        );
        assert_eq!(
            pins.get(&path_key(second)).map(String::as_str),
            Some("Release investigation · архив 2")
        );
        assert_eq!(
            pins.get(&path_key(third)).map(String::as_str),
            Some("Release investigation")
        );
    }

    #[test]
    fn handoff_archive_title_preserves_suffix_within_limit() {
        let long_title = "Очень длинное название ".repeat(10);
        let (active, archive) =
            handoff_session_titles(&long_title, &BTreeMap::new(), "архив").unwrap();

        assert!(active.chars().count() <= super::SESSION_TITLE_MAX_CHARS);
        assert!(archive.chars().count() <= super::SESSION_TITLE_MAX_CHARS);
        assert!(archive.ends_with(" · архив"));
    }

    #[test]
    fn nested_directory_read_errors_do_not_abort_scan() {
        let missing = std::env::temp_dir().join(format!(
            "omp-desktop-missing-subdirectory-{}",
            std::process::id()
        ));
        let mut files = Vec::new();
        assert!(collect_jsonl_files(&missing, 1, 3, &mut files).is_ok());
        assert!(collect_jsonl_files(&missing, 0, 3, &mut files).is_err());
    }

    #[test]
    fn scan_sessions_collapses_nested_task_lineage_into_parent() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-session-lineage-{}-{nonce}",
            std::process::id()
        ));
        let project_dir = root.join("project");
        let parent = project_dir.join("discussion.with-dot.jsonl");
        let artifact_dir = parent.with_extension("");
        let child = artifact_dir.join("TaskWorker.jsonl");
        let legacy_dir = project_dir.join("legacy-layout");
        let legacy = legacy_dir.join("independent.jsonl");
        fs::create_dir_all(&artifact_dir).expect("artifact dir should be writable");
        fs::create_dir_all(&legacy_dir).expect("legacy dir should be writable");

        let session = |id: &str, message: &str| {
            format!(
                "{{\"type\":\"session\",\"id\":\"{id}\",\"timestamp\":\"2026-07-26T00:00:00Z\",\"cwd\":\"/tmp/project\"}}\n{{\"type\":\"message\",\"id\":\"m-{id}\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"{message}\"}}]}}}}\n"
            )
        };
        fs::write(&parent, session("parent", "Main discussion"))
            .expect("parent fixture should be writable");
        fs::write(&child, session("child", "Delegated task"))
            .expect("child fixture should be writable");
        fs::write(&legacy, session("legacy", "Independent nested discussion"))
            .expect("legacy fixture should be writable");

        let sessions = scan_sessions(&root).expect("sessions should be scannable");
        assert_eq!(sessions.len(), 2);
        assert!(sessions.iter().any(|session| session.id == "parent"));
        assert!(sessions.iter().any(|session| session.id == "legacy"));
        assert!(!sessions.iter().any(|session| session.id == "child"));

        fs::remove_dir_all(root).expect("fixture root should be removable");
    }

    #[test]
    fn title_slot_is_fixed_width() {
        let line = serialize_title_slot("Hello", Some("user"), "2026-07-19T00:00:00Z").unwrap();
        assert_eq!(line.len(), 256);
        assert!(line.ends_with('\n'));
    }

    #[test]
    fn atomic_session_write_replaces_or_preserves_destination() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-atomic-session-{}-{nonce}",
            std::process::id()
        ));
        let destination = root.join("session.jsonl");
        fs::create_dir_all(&root).expect("fixture directory should be writable");
        fs::write(&destination, b"old\n").expect("fixture should be writable");

        let failed = atomic_write_file_with(&destination, b"broken\n", |_temporary, _target| {
            Err(io::Error::other("injected replace failure"))
        });
        assert!(failed.is_err());
        assert_eq!(
            fs::read(&destination).expect("old file should remain"),
            b"old\n"
        );
        assert_eq!(
            fs::read_dir(&root)
                .expect("fixture directory should be readable")
                .count(),
            1
        );

        atomic_write_file(&destination, b"new\n").expect("atomic replacement should succeed");
        assert_eq!(
            fs::read(&destination).expect("new file should be readable"),
            b"new\n"
        );
        fs::remove_dir_all(&root).expect("fixture directory should be removable");
    }

    #[test]
    fn codex_discovery_reads_only_bounded_prefix() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "omp-desktop-codex-prefix-{}-{nonce}.jsonl",
            std::process::id()
        ));
        let mut contents = String::new();
        for index in 0..(CODEX_DISCOVERY_MAX_LINES + 20) {
            contents.push_str(&format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"session-{index}\"}}}}\n"
            ));
        }
        contents.push_str(&"x".repeat(CODEX_DISCOVERY_MAX_BYTES));
        fs::write(&path, contents).expect("fixture should be writable");

        let prefix = read_codex_discovery_prefix(&path).expect("prefix should be readable");
        fs::remove_file(&path).expect("fixture should be removable");

        assert_eq!(prefix.lines().count(), CODEX_DISCOVERY_MAX_LINES);
        assert!(prefix.len() <= CODEX_DISCOVERY_MAX_BYTES);
    }

    #[test]
    fn encode_absolute_windows_path() {
        let name = encode_session_dir_name(r"D:\Projects\OMP");
        assert!(name.starts_with("--") || name.starts_with('-'));
        assert!(!name.contains('?'));
    }

    #[test]
    fn encode_relative_session_dir_name_home_prefix() {
        // Unix-style relative path
        assert_eq!(
            encode_relative_session_dir_name("-", "Projects/omp"),
            "-Projects-omp"
        );
        // Windows-style relative path
        assert_eq!(
            encode_relative_session_dir_name("-", "Projects\\omp"),
            "-Projects-omp"
        );
        // Relative path that is empty (home itself) → prefix stripped of trailing dash
        assert_eq!(encode_relative_session_dir_name("-", ""), "");
    }

    #[test]
    fn encode_relative_session_dir_name_tmp_prefix() {
        assert_eq!(
            encode_relative_session_dir_name("-tmp", "subdir"),
            "-tmp-subdir"
        );
        // Prefix without trailing dash gets a dash inserted
        assert_eq!(encode_relative_session_dir_name("-tmp", "a/b"), "-tmp-a-b");
    }

    #[test]
    fn encode_absolute_path_uses_double_dash_wrapper() {
        // Exercise the fallback (non-home, non-temp) path deterministically.
        // The function strips leading slashes/backslashes and replaces separators with `-`.
        let name = encode_session_dir_name("/absolute/unix/path");
        assert_eq!(name, "--absolute-unix-path--");
    }

    #[test]
    fn session_parser_reads_latest_runtime_state() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "omp-desktop-session-{}-{nonce}.jsonl",
            std::process::id()
        ));
        let mut contents = concat!(
            r#"{"type":"title","v":1,"title":"Resume this work","updatedAt":"2026-07-18T10:00:00Z","pad":""}"#,
            "\n",
            r#"{"type":"session","version":3,"id":"session-id","timestamp":"2026-07-18T10:00:00Z","cwd":"/tmp/project"}"#,
            "\n",
            r#"{"type":"model_change","model":"provider/initial"}"#,
            "\n"
        )
        .to_owned();
        for index in 0..16 {
            contents.push_str(&format!(
                "{{\"type\":\"custom_message\",\"content\":\"filler-{index}\"}}\n"
            ));
        }
        contents.push_str(concat!(
            r#"{"type":"model_change","model":"provider/latest"}"#,
            "\n",
            r#"{"type":"thinking_level_change","thinkingLevel":"xhigh","configured":"auto"}"#,
            "\n",
            r#"{"type":"model_change","model":"provider/fallback","role":"fallback"}"#,
            "\n",
            r#"{"type":"custom","customType":"primary_provider_pin","data":{"pinned":true}}"#,
            "\n"
        ));
        fs::write(&path, contents).expect("fixture should be writable");

        let session = parse_session(&path)
            .expect("fixture should be readable")
            .expect("fixture should contain a session header");
        fs::remove_file(&path).expect("fixture should be removable");

        assert_eq!(session.id, "session-id");
        assert_eq!(session.title, "Resume this work");
        assert_eq!(session.cwd, "/tmp/project");
        assert_eq!(session.created_at, "2026-07-18T10:00:00Z");
        assert_eq!(session.model.as_deref(), Some("provider/latest"));
        assert_eq!(session.thinking_level.as_deref(), Some("xhigh"));
        assert_eq!(session.configured_thinking_level.as_deref(), Some("auto"));
        assert!(session.primary_provider_pinned);
        assert!(session.updated_at > 0);
    }

    #[test]
    fn session_summary_cache_invalidates_after_file_change() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "omp-desktop-session-cache-{}-{nonce}.jsonl",
            std::process::id()
        ));
        let session_line = r#"{"type":"session","id":"cached-session","timestamp":"2026-07-18T10:00:00Z","cwd":"/tmp/project"}"#;
        fs::write(
            &path,
            format!("{{\"type\":\"title\",\"title\":\"First\"}}\n{session_line}\n"),
        )
        .expect("fixture should be writable");
        let first = parse_session(&path)
            .expect("fixture should be readable")
            .expect("fixture should contain a session header");

        fs::write(
            &path,
            format!("{{\"type\":\"title\",\"title\":\"Updated cache title\"}}\n{session_line}\n"),
        )
        .expect("fixture should be rewritable");
        let updated = parse_session(&path)
            .expect("updated fixture should be readable")
            .expect("updated fixture should contain a session header");
        fs::remove_file(&path).expect("fixture should be removable");

        assert_eq!(first.title, "First");
        assert_eq!(updated.title, "Updated cache title");
    }

    #[test]
    fn transcript_reader_returns_complete_messages_and_rejects_external_files() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-transcript-{}-{nonce}",
            std::process::id()
        ));
        let path = root.join("project").join("session.jsonl");
        fs::create_dir_all(path.parent().expect("fixture parent should exist"))
            .expect("fixture directory should be writable");
        let contents = concat!(
            r#"{"type":"title","title":"Full transcript"}"#,
            "\n",
            r#"{"type":"session","id":"session-id","timestamp":"2026-07-22T00:00:00Z","cwd":"/tmp/project"}"#,
            "\n",
            r#"{"type":"message","id":"user-1","timestamp":"2026-07-22T00:00:01Z","message":{"role":"user","content":[{"type":"text","text":"First line\nSecond line"}]}}"#,
            "\n",
            r#"{"type":"message","id":"assistant-1","timestamp":"2026-07-22T00:00:02Z","message":{"role":"assistant","model":"model-a","content":[{"type":"toolCall","name":"read","arguments":{"path":"history.jsonl"}},{"type":"text","text":"Complete answer"}]}}"#,
            "\n",
            r#"{"type":"message","id":"tool-1","timestamp":"2026-07-22T00:00:03Z","message":{"role":"tool","content":[{"type":"output_text","text":"tool output"}]}}"#,
            "\n"
        );
        fs::write(&path, contents).expect("fixture should be writable");

        let transcript = read_session_transcript(path.to_string_lossy().as_ref(), &root)
            .expect("transcript should be readable");
        assert!(!transcript.truncated);
        assert_eq!(transcript.session.id, "session-id");
        assert_eq!(transcript.entries.len(), 3);
        assert_eq!(transcript.entries[0].text, "First line\nSecond line");
        assert_eq!(
            transcript.entries[0].dialogue_text.as_deref(),
            Some("First line\nSecond line")
        );
        assert_eq!(
            transcript.entries[0].category,
            TranscriptEntryCategory::Dialogue
        );
        assert!(transcript.entries[1].text.contains("Инструмент: read"));
        assert!(transcript.entries[1].text.contains("Complete answer"));
        assert_eq!(
            transcript.entries[1].dialogue_text.as_deref(),
            Some("Complete answer")
        );
        assert_eq!(
            transcript.entries[1].category,
            TranscriptEntryCategory::Dialogue
        );
        assert_eq!(transcript.entries[1].model.as_deref(), Some("model-a"));
        assert_eq!(transcript.entries[2].text, "tool output");
        assert_eq!(transcript.entries[2].dialogue_text, None);
        assert_eq!(
            transcript.entries[2].category,
            TranscriptEntryCategory::Service
        );

        let external = root.with_extension("external.jsonl");
        fs::write(&external, contents).expect("external fixture should be writable");
        assert!(read_session_transcript(external.to_string_lossy().as_ref(), &root).is_err());
        fs::remove_file(external).expect("external fixture should be removable");
        fs::remove_dir_all(root).expect("fixture root should be removable");
    }

    #[test]
    fn transcript_reader_bounds_work_and_marks_the_omitted_middle() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-bounded-transcript-{}-{nonce}",
            std::process::id()
        ));
        let path = root.join("project").join("large.jsonl");
        fs::create_dir_all(path.parent().expect("fixture parent should exist"))
            .expect("fixture directory should be writable");
        let mut file = fs::File::create(&path).expect("fixture should be creatable");
        writeln!(
            file,
            r#"{{"type":"session","id":"bounded-session","cwd":"/tmp/project"}}"#
        )
        .expect("session header should be writable");
        writeln!(
            file,
            r#"{{"type":"message","id":"first","message":{{"role":"user","content":"first"}}}}"#
        )
        .expect("first message should be writable");
        file.write_all(&vec![b'x'; 1_200])
            .expect("omitted middle should be writable");
        file.write_all(b"\n")
            .expect("middle delimiter should be writable");
        file.write_all(&[0xff, 0xfe, b'\n'])
            .expect("invalid UTF-8 fixture should be writable");
        writeln!(
            file,
            r#"{{"type":"message","id":"latest","message":{{"role":"assistant","content":"latest"}}}}"#
        )
        .expect("latest message should be writable");
        drop(file);

        let transcript =
            read_session_transcript_with_limits(path.to_string_lossy().as_ref(), &root, 512, 512)
                .expect("bounded transcript should be readable");
        let ids = transcript
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>();
        assert!(transcript.truncated);
        assert_eq!(ids, ["first", "latest"]);

        fs::remove_dir_all(root).expect("fixture root should be removable");
    }
    #[test]
    fn scan_sessions_retains_every_empty_session() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("omp-desktop-dedupe-{}-{nonce}", std::process::id()));
        let project_dir = root.join("project");
        fs::create_dir_all(&project_dir).expect("project dir should be writable");

        let empty1 = project_dir.join("empty1.jsonl");
        let empty2 = project_dir.join("empty2.jsonl");
        let untitled_msg = project_dir.join("untitled_msg.jsonl");
        let titled = project_dir.join("titled.jsonl");

        let empty_content = concat!(
            r#"{"type":"session","id":"s-empty-1","timestamp":"2026-07-22T00:00:00Z","cwd":"/tmp/project"}"#,
            "\n"
        );
        let empty_content2 = concat!(
            r#"{"type":"session","id":"s-empty-2","timestamp":"2026-07-22T00:00:10Z","cwd":"/tmp/project"}"#,
            "\n"
        );
        let untitled_msg_content = concat!(
            r#"{"type":"session","id":"s-untitled-msg","timestamp":"2026-07-22T00:00:08Z","cwd":"/tmp/project"}"#,
            "\n",
            r#"{"type":"message","id":"m1","message":{"role":"user","content":[{"type":"text","text":"Untitled chat in progress"}]}}"#,
            "\n"
        );
        let titled_content = concat!(
            r#"{"type":"title","title":"Real work session"}"#,
            "\n",
            r#"{"type":"session","id":"s-titled","timestamp":"2026-07-22T00:00:05Z","cwd":"/tmp/project"}"#,
            "\n"
        );

        fs::write(&empty1, empty_content).expect("empty1 fixture should be writable");
        fs::write(&empty2, empty_content2).expect("empty2 fixture should be writable");
        fs::write(&untitled_msg, untitled_msg_content)
            .expect("untitled_msg fixture should be writable");
        fs::write(&titled, titled_content).expect("titled fixture should be writable");

        let sessions = scan_sessions(&root).expect("sessions should be scannable");
        assert_eq!(sessions.len(), 4);
        assert!(sessions.iter().any(|s| s.title == "Real work session"));
        assert!(sessions
            .iter()
            .any(|s| s.id == "s-untitled-msg" && s.has_messages));
        assert_eq!(
            sessions
                .iter()
                .filter(|s| !s.has_messages && s.title == "Новая сессия")
                .count(),
            2
        );

        fs::remove_dir_all(root).expect("test root should be removable");
    }
    #[test]
    fn scan_sessions_retains_system_only_and_roleless_custom_sessions() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("omp-desktop-system-{}-{nonce}", std::process::id()));
        let project_dir = root.join("project");
        fs::create_dir_all(&project_dir).expect("project dir should be writable");

        let system_only = project_dir.join("system_only.jsonl");
        let system_content = concat!(
            r#"{"type":"session","id":"s-system-only","timestamp":"2026-07-22T00:00:00Z","cwd":"/tmp/project"}"#,
            "\n",
            r#"{"type":"message","id":"m-sys","message":{"role":"system","content":[{"type":"text","text":"System prompt only"}]}}"#,
            "\n"
        );
        fs::write(&system_only, system_content).expect("system_only fixture should be writable");

        let roleless_custom = project_dir.join("roleless_custom.jsonl");
        let roleless_content = concat!(
            r#"{"type":"session","id":"s-roleless","timestamp":"2026-07-22T00:00:05Z","cwd":"/tmp/project"}"#,
            "\n",
            r#"{"type":"custom_message","id":"cm-1","content":"Internal system hook without role"}"#,
            "\n"
        );
        fs::write(&roleless_custom, roleless_content)
            .expect("roleless_custom fixture should be writable");

        let parsed_sys = parse_session_with_names(&system_only, &HashMap::new())
            .expect("parse should succeed")
            .expect("session summary should be returned");
        assert!(
            !parsed_sys.has_messages,
            "System-only message must not set has_messages to true"
        );

        let parsed_roleless = parse_session_with_names(&roleless_custom, &HashMap::new())
            .expect("parse should succeed")
            .expect("session summary should be returned");
        assert!(
            !parsed_roleless.has_messages,
            "Roleless custom message must not set has_messages to true"
        );

        let sessions = scan_sessions(&root).expect("sessions should be scannable");
        assert_eq!(
            sessions.len(),
            2,
            "Session inventory must not silently hide empty entries"
        );

        fs::remove_dir_all(root).expect("test root should be removable");
    }

    #[test]
    fn restorable_model_preserves_temporary_but_not_fallback() {
        let models = HashMap::from([
            ("default".to_owned(), "provider/default".to_owned()),
            ("fallback".to_owned(), "provider/fallback".to_owned()),
            ("temporary".to_owned(), "provider/temporary".to_owned()),
        ]);

        assert_eq!(
            restorable_session_model(&models, Some("fallback")).as_deref(),
            Some("provider/default")
        );
        assert_eq!(
            restorable_session_model(&models, Some("temporary")).as_deref(),
            Some("provider/temporary")
        );
    }
    #[test]
    fn delete_session_removes_jsonl_and_artifacts_but_rejects_external_files() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-delete-session-{}-{nonce}",
            std::process::id()
        ));
        let session = root.join("project").join("session.jsonl");
        let artifacts = session.with_extension("");
        fs::create_dir_all(&artifacts).expect("artifact fixture should be creatable");
        fs::write(&session, "{}\n").expect("session fixture should be writable");
        fs::write(artifacts.join("tool.log"), "artifact").expect("artifact should be writable");

        delete_session(session.to_string_lossy().as_ref(), &root)
            .expect("session should be deletable");
        assert!(!session.exists());
        assert!(!artifacts.exists());

        let external = root.with_extension("external.jsonl");
        fs::write(&external, "{}\n").expect("external fixture should be writable");
        assert!(delete_session(external.to_string_lossy().as_ref(), &root).is_err());
        assert!(external.exists());
        fs::remove_file(external).expect("external fixture should be removable");
        fs::remove_dir_all(root).expect("fixture root should be removable");
    }

    #[test]
    fn codex_sessions_keep_only_newest_file_for_each_id() {
        let summary = |id: &str, file_path: &str, updated_at: u64| CodexSessionSummary {
            id: id.to_owned(),
            title: id.to_owned(),
            cwd: "/tmp/project".to_owned(),
            file_path: file_path.to_owned(),
            created_at: String::new(),
            updated_at,
            model: None,
            preview: String::new(),
        };
        let sessions = deduplicate_codex_sessions(vec![
            summary("same", "older.jsonl", 10),
            summary("other", "other.jsonl", 20),
            summary("same", "newer.jsonl", 30),
        ]);

        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].file_path, "newer.jsonl");
        assert_eq!(sessions[1].file_path, "other.jsonl");
    }

    #[test]
    fn codex_title_prefers_index_and_skips_instruction_turns() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "omp-desktop-codex-session-{}-{nonce}.jsonl",
            std::process::id()
        ));
        let lines = [
            serde_json::json!({
                "timestamp": "2026-07-19T13:51:32.094Z",
                "type": "session_meta",
                "payload": {
                    "session_id": "codex-test-session",
                    "cwd": "/tmp/project",
                    "model_provider": "codex-lb"
                }
            }),
            serde_json::json!({
                "type": "turn_context",
                "payload": { "model": "gpt-5.6-sol" }
            }),
            serde_json::json!({
                "type": "turn_context",
                "payload": { "model": "gpt-5.6-sol" }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "role": "user",
                    "content": [{"input_text": "# AGENTS.md instructions\n<INSTRUCTIONS>"}]
                }
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "message": "Настоящая задача пользователя"
                }
            }),
        ];
        let contents = lines
            .iter()
            .map(|line| format!("{line}\n"))
            .collect::<String>();
        fs::write(&path, contents).expect("fixture should be writable");

        let mut thread_names = HashMap::new();
        thread_names.insert("codex-test-session".to_owned(), "Имя из Codex".to_owned());
        let indexed = parse_codex_session_with_names(&path, &thread_names)
            .expect("fixture should be readable")
            .expect("fixture should contain a Codex session");
        let fallback = parse_codex_session_with_names(&path, &HashMap::new())
            .expect("fixture should be readable")
            .expect("fixture should contain a Codex session");
        fs::remove_file(&path).expect("fixture should be removable");

        assert_eq!(indexed.title, "Имя из Codex");
        assert_eq!(indexed.preview, "Настоящая задача пользователя");
        assert_eq!(fallback.title, "Настоящая задача пользователя");
        assert_eq!(indexed.model.as_deref(), Some("codex-lb/gpt-5.6-sol"));
    }
    #[test]
    fn imported_session_keeps_local_title_over_codex_index() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "omp-desktop-imported-session-{}-{nonce}.jsonl",
            std::process::id()
        ));
        let contents = concat!(
            r##"{"type":"title","v":1,"title":"Переименовано вручную","source":"user","updatedAt":"2026-07-20T10:00:00Z","pad":""}"##,
            "\n",
            r##"{"type":"session","version":3,"id":"imported-session","timestamp":"2026-07-20T10:00:00Z","cwd":"/tmp/project","title":"# AGENTS.md instructions","parentSession":"codex:codex-test-session"}"##,
            "\n"
        );
        fs::write(&path, contents).expect("fixture should be writable");

        let mut thread_names = HashMap::new();
        thread_names.insert("codex-test-session".to_owned(), "Имя из Codex".to_owned());
        let renamed = parse_session_with_names(&path, &thread_names)
            .expect("fixture should be readable")
            .expect("fixture should contain a session header");

        let synthetic_path = std::env::temp_dir().join(format!(
            "omp-desktop-imported-synthetic-{}-{nonce}.jsonl",
            std::process::id()
        ));
        let synthetic_contents = concat!(
            r##"{"type":"title","v":1,"title":"# AGENTS.md instructions","updatedAt":"2026-07-20T10:00:00Z","pad":""}"##,
            "\n",
            r##"{"type":"session","version":3,"id":"imported-synthetic","timestamp":"2026-07-20T10:00:00Z","cwd":"/tmp/project","title":"# AGENTS.md instructions","parentSession":"codex:codex-test-session"}"##,
            "\n"
        );
        fs::write(&synthetic_path, synthetic_contents).expect("fixture should be writable");
        let recovered = parse_session_with_names(&synthetic_path, &thread_names)
            .expect("fixture should be readable")
            .expect("fixture should contain a session header");

        fs::remove_file(&path).expect("fixture should be removable");
        fs::remove_file(&synthetic_path).expect("fixture should be removable");

        assert_eq!(renamed.title, "Переименовано вручную");
        assert_eq!(recovered.title, "Имя из Codex");
    }
    #[test]
    fn codex_import_writes_complete_assistant_messages() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-codex-import-{}-{nonce}",
            std::process::id()
        ));
        let project = root.join("project");
        let session_root = root.join("sessions");
        let source = root.join("codex.jsonl");
        fs::create_dir_all(&project).expect("project fixture should be creatable");
        let lines = [
            serde_json::json!({
                "timestamp": "2026-07-20T11:10:00.000Z",
                "type": "session_meta",
                "payload": {
                    "session_id": "codex-import-test",
                    "cwd": "/tmp/source",
                    "model_provider": "codex-lb"
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-20T11:10:00.100Z",
                "type": "turn_context",
                "payload": { "model": "gpt-5.6-sol" }
            }),
            serde_json::json!({
                "timestamp": "2026-07-20T11:10:01.000Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "Imported answer"}]
                }
            }),
        ];
        let contents = lines
            .iter()
            .map(|line| format!("{line}\n"))
            .collect::<String>();
        fs::write(&source, contents).expect("Codex fixture should be writable");
        let project_path = project
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_owned();

        let imported = import_session(
            &ImportSessionRequest {
                path: source.to_string_lossy().into_owned(),
                target_cwd: project_path,
                mode: ImportMode::Skip,
            },
            &session_root,
        )
        .expect("Codex fixture should import");
        assert_eq!(imported.status, ImportItemStatus::Imported);
        let imported_path = imported
            .destination_path
            .expect("successful import should have a destination");
        let imported = fs::read_to_string(imported_path).expect("import should be readable");
        let assistant = imported
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .find(|entry| {
                entry
                    .pointer("/message/role")
                    .and_then(serde_json::Value::as_str)
                    == Some("assistant")
            })
            .expect("import should contain an assistant message");
        fs::remove_dir_all(&root).expect("fixture should be removable");

        assert_eq!(
            assistant
                .pointer("/message/usage/cacheRead")
                .and_then(serde_json::Value::as_u64),
            Some(0)
        );
        assert_eq!(
            assistant
                .pointer("/message/usage/cost/total")
                .and_then(serde_json::Value::as_u64),
            Some(0)
        );
        assert_eq!(
            assistant
                .pointer("/message/provider")
                .and_then(serde_json::Value::as_str),
            Some("codex-lb")
        );
        assert_eq!(
            assistant
                .pointer("/message/model")
                .and_then(serde_json::Value::as_str),
            Some("gpt-5.6-sol")
        );
        assert_eq!(
            assistant
                .pointer("/message/stopReason")
                .and_then(serde_json::Value::as_str),
            Some("stop")
        );
        assert!(assistant
            .pointer("/message/timestamp")
            .and_then(serde_json::Value::as_u64)
            .is_some());
    }
    #[test]
    fn omp_import_supports_one_line_sessions_and_explicit_repeat_modes() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-omp-import-{}-{nonce}",
            std::process::id()
        ));
        let project = root.join("project");
        let session_root = root.join("sessions");
        let source = root.join("source.jsonl");
        fs::create_dir_all(&project).expect("project fixture should be creatable");
        let source_artifacts = source.with_extension("");
        fs::create_dir_all(&source_artifacts).expect("source artifacts should be creatable");
        fs::write(source_artifacts.join("kept.log"), "original artifact")
            .expect("source artifact should be writable");
        fs::write(
            &source,
            concat!(
                r#"{"type":"session","id":"source-one","timestamp":"2026-07-20T11:10:00Z","cwd":"/tmp/source"}"#,
                "\n"
            ),
        )
        .expect("source fixture should be writable");
        let request = ImportSessionRequest {
            path: source.to_string_lossy().into_owned(),
            target_cwd: project.to_string_lossy().into_owned(),
            mode: ImportMode::Skip,
        };

        let first =
            import_session(&request, &session_root).expect("one-line session should import");
        assert_eq!(first.status, ImportItemStatus::Imported);
        let first_path = first
            .destination_path
            .as_deref()
            .expect("successful import should have a destination");
        let first_body = fs::read_to_string(first_path).expect("import should be readable");
        assert!(first_body.contains(r#""customType":"omp-desktop-import""#));
        let imported_artifacts = Path::new(first_path).with_extension("");
        assert_eq!(
            fs::read_to_string(imported_artifacts.join("kept.log"))
                .expect("imported artifact should be readable"),
            "original artifact"
        );

        let repeated = import_session(&request, &session_root).expect("repeat should be handled");
        assert_eq!(repeated.status, ImportItemStatus::Skipped);
        assert_eq!(repeated.destination_path.as_deref(), Some(first_path));

        let moved_source = root.join("moved-source.jsonl");
        fs::copy(&source, &moved_source).expect("moved source fixture should be writable");
        let moved = import_session(
            &ImportSessionRequest {
                path: moved_source.to_string_lossy().into_owned(),
                ..request.clone()
            },
            &session_root,
        )
        .expect("source lineage should survive a path change");
        assert_eq!(moved.status, ImportItemStatus::Skipped);
        assert_eq!(moved.destination_path.as_deref(), Some(first_path));
        fs::remove_dir_all(&source_artifacts)
            .expect("source artifacts should be removable before update");

        fs::write(
            &source,
            concat!(
                r#"{"type":"session","id":"source-one","timestamp":"2026-07-20T11:10:00Z","cwd":"/tmp/source"}"#,
                "\n",
                r#"{"type":"message","id":"m1","message":{"role":"user","content":[{"type":"text","text":"updated source"}]}}"#,
                "\n"
            ),
        )
        .expect("updated source should be writable");
        let updated = import_session(
            &ImportSessionRequest {
                mode: ImportMode::Update,
                ..request.clone()
            },
            &session_root,
        )
        .expect("update mode should replace the import");
        assert_eq!(updated.status, ImportItemStatus::Updated);
        let updated_path = updated
            .destination_path
            .as_deref()
            .expect("updated import should have a destination");
        assert!(fs::read_to_string(updated_path)
            .expect("updated import should be readable")
            .contains("updated source"));
        assert_eq!(
            fs::read_to_string(imported_artifacts.join("kept.log"))
                .expect("update without source artifacts must preserve destination artifacts"),
            "original artifact"
        );

        let copied = import_session(
            &ImportSessionRequest {
                mode: ImportMode::Copy,
                ..request
            },
            &session_root,
        )
        .expect("copy mode should create another import");
        assert_eq!(copied.status, ImportItemStatus::Copied);
        assert_ne!(copied.destination_path.as_deref(), Some(updated_path));

        fs::remove_dir_all(root).expect("fixture should be removable");
    }

    #[test]
    fn import_destination_rejects_a_mismatched_existing_source_identity() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-import-collision-{}-{nonce}",
            std::process::id()
        ));
        let destination = import_destination(
            &root,
            "/tmp/project",
            "omp",
            "expected-source",
            ImportMode::Update,
        )
        .expect("empty destination should be selectable");
        fs::write(
            &destination.path,
            concat!(
                r#"{"type":"session","id":"occupied","cwd":"/tmp/project","importSource":{"type":"omp","id":"different-source"}}"#,
                "\n"
            ),
        )
        .expect("colliding fixture should be writable");

        let error = match import_destination(
            &root,
            "/tmp/project",
            "omp",
            "expected-source",
            ImportMode::Update,
        ) {
            Ok(_) => panic!("mismatched source identity must not be overwritten"),
            Err(error) => error,
        };
        assert!(error.contains("Конфликт идентификатора импорта"));
        assert!(fs::read_to_string(&destination.path)
            .expect("colliding fixture should remain readable")
            .contains("different-source"));

        fs::remove_dir_all(root).expect("fixture root should be removable");
    }

    #[test]
    fn artifact_commit_failure_restores_the_previous_session_and_artifacts() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-artifact-rollback-{}-{nonce}",
            std::process::id()
        ));
        let destination = root.join("session.jsonl");
        let target_artifacts = destination.with_extension("");
        let staging = root.join("staging");
        fs::create_dir_all(&target_artifacts).expect("old artifacts should be creatable");
        fs::create_dir_all(&staging).expect("staging should be creatable");
        fs::write(&destination, b"old session").expect("old session should be writable");
        fs::write(target_artifacts.join("old.log"), b"old artifact")
            .expect("old artifact should be writable");
        fs::write(staging.join("new.log"), b"new artifact")
            .expect("new artifact should be writable");

        let mut rename_calls = 0_usize;
        let error = commit_import_with(
            &destination,
            b"new session",
            Some(staging.clone()),
            atomic_write_file,
            |source, target| {
                rename_calls += 1;
                if rename_calls == 2 {
                    Err("injected artifact commit failure".to_owned())
                } else {
                    fs::rename(source, target).map_err(|error| error.to_string())
                }
            },
        )
        .expect_err("artifact commit failure must fail the import");

        assert!(error.contains("injected artifact commit failure"));
        assert_eq!(
            fs::read(&destination).expect("session should remain readable"),
            b"old session"
        );
        assert_eq!(
            fs::read(target_artifacts.join("old.log"))
                .expect("old artifact should remain readable"),
            b"old artifact"
        );
        assert!(!target_artifacts.join("new.log").exists());
        assert!(!staging.exists());

        fs::remove_dir_all(root).expect("fixture root should be removable");
    }

    #[test]
    fn session_commit_failure_rolls_back_the_artifact_swap() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-session-rollback-{}-{nonce}",
            std::process::id()
        ));
        let destination = root.join("session.jsonl");
        let target_artifacts = destination.with_extension("");
        let staging = root.join("staging");
        fs::create_dir_all(&target_artifacts).expect("old artifacts should be creatable");
        fs::create_dir_all(&staging).expect("staging should be creatable");
        fs::write(&destination, b"old session").expect("old session should be writable");
        fs::write(target_artifacts.join("old.log"), b"old artifact")
            .expect("old artifact should be writable");
        fs::write(staging.join("new.log"), b"new artifact")
            .expect("new artifact should be writable");

        let error = commit_import_with(
            &destination,
            b"new session",
            Some(staging.clone()),
            |_path, _body| Err("injected session commit failure".to_owned()),
            |source, target| fs::rename(source, target).map_err(|error| error.to_string()),
        )
        .expect_err("session commit failure must fail the import");

        assert!(error.contains("injected session commit failure"));
        assert_eq!(
            fs::read(&destination).expect("session should remain readable"),
            b"old session"
        );
        assert_eq!(
            fs::read(target_artifacts.join("old.log"))
                .expect("old artifact should remain readable"),
            b"old artifact"
        );
        assert!(!target_artifacts.join("new.log").exists());
        assert!(!staging.exists());

        fs::remove_dir_all(root).expect("fixture root should be removable");
    }

    #[test]
    fn artifact_staging_enforces_the_production_budget_shape() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-artifact-budget-{}-{nonce}",
            std::process::id()
        ));
        let source = root.join("source.jsonl");
        let source_artifacts = source.with_extension("");
        let destination = root.join("destination").join("session.jsonl");
        fs::create_dir_all(&source_artifacts).expect("source artifacts should be creatable");
        fs::create_dir_all(
            destination
                .parent()
                .expect("destination parent should exist"),
        )
        .expect("destination parent should be creatable");
        fs::write(&source, b"{}\n").expect("source should be writable");
        fs::write(source_artifacts.join("large.bin"), vec![0_u8; 65])
            .expect("oversized artifact should be writable");

        let error = stage_import_artifacts_with_limits(
            &source,
            &destination,
            ArtifactLimits {
                max_bytes: 64,
                max_entries: 10,
                max_depth: 4,
            },
        )
        .expect_err("artifact byte budget must be enforced");
        assert!(error.contains("лимита"));

        fs::remove_dir_all(&source_artifacts).expect("byte fixture should be removable");
        fs::create_dir_all(&source_artifacts).expect("entry fixture should be creatable");
        fs::write(source_artifacts.join("one"), b"1").expect("first entry should be writable");
        fs::write(source_artifacts.join("two"), b"2").expect("second entry should be writable");
        let entry_error = stage_import_artifacts_with_limits(
            &source,
            &destination,
            ArtifactLimits {
                max_bytes: 64,
                max_entries: 1,
                max_depth: 4,
            },
        )
        .expect_err("artifact entry budget must be enforced");
        assert!(entry_error.contains("Артефактов импорта больше"));

        fs::remove_dir_all(&source_artifacts).expect("entry fixture should be removable");
        fs::create_dir_all(source_artifacts.join("one").join("two"))
            .expect("depth fixture should be creatable");
        let depth_error = stage_import_artifacts_with_limits(
            &source,
            &destination,
            ArtifactLimits {
                max_bytes: 64,
                max_entries: 10,
                max_depth: 1,
            },
        )
        .expect_err("artifact depth budget must be enforced");
        assert!(depth_error.contains("глубже поддерживаемого лимита"));
        assert!(
            fs::read_dir(
                destination
                    .parent()
                    .expect("destination parent should exist")
            )
            .expect("destination parent should be readable")
            .all(|entry| !entry
                .expect("directory entry should be readable")
                .file_name()
                .to_string_lossy()
                .contains("artifacts-stage")),
            "failed staging must not leave transaction directories"
        );

        fs::remove_dir_all(root).expect("fixture root should be removable");
    }

    #[cfg(unix)]
    #[test]
    fn artifact_staging_rejects_nested_symlinks() {
        use std::os::unix::fs::symlink;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-artifact-symlink-{}-{nonce}",
            std::process::id()
        ));
        let source = root.join("source.jsonl");
        let source_artifacts = source.with_extension("");
        let outside = root.join("outside.txt");
        let destination = root.join("destination").join("session.jsonl");
        fs::create_dir_all(&source_artifacts).expect("source artifacts should be creatable");
        fs::create_dir_all(
            destination
                .parent()
                .expect("destination parent should exist"),
        )
        .expect("destination parent should be creatable");
        fs::write(&source, b"{}\n").expect("source should be writable");
        fs::write(&outside, b"must not be copied").expect("outside fixture should be writable");
        symlink(&outside, source_artifacts.join("leak.txt"))
            .expect("artifact symlink should be creatable");

        let error = stage_import_artifacts_with_limits(
            &source,
            &destination,
            ArtifactLimits {
                max_bytes: 1_024,
                max_entries: 10,
                max_depth: 4,
            },
        )
        .expect_err("nested symlinks must be rejected");
        assert!(error.contains("ссыл"));

        fs::remove_dir_all(root).expect("fixture root should be removable");
    }

    #[test]
    fn omp_import_reports_artifact_failure_before_committing_session() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-artifact-import-{}-{nonce}",
            std::process::id()
        ));
        let project = root.join("project");
        let session_root = root.join("sessions");
        let source = root.join("source.jsonl");
        fs::create_dir_all(&project).expect("project fixture should be creatable");
        fs::write(
            &source,
            r#"{"type":"session","id":"artifact-source","cwd":"/tmp/source"}"#,
        )
        .expect("source fixture should be writable");
        fs::write(source.with_extension(""), "not a directory")
            .expect("invalid artifact fixture should be writable");

        let error = import_session(
            &ImportSessionRequest {
                path: source.to_string_lossy().into_owned(),
                target_cwd: project.to_string_lossy().into_owned(),
                mode: ImportMode::Skip,
            },
            &session_root,
        )
        .expect_err("invalid artifacts must fail the import");
        assert!(error.contains("Артефакты"));
        let mut imported_files = Vec::new();
        collect_jsonl_files(&session_root, 0, 3, &mut imported_files)
            .expect("empty import destination should remain scannable");
        assert!(imported_files.is_empty());

        fs::remove_dir_all(root).expect("fixture should be removable");
    }

    #[test]
    fn workspace_counts_use_physical_project_identity() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-workspace-key-{}-{nonce}",
            std::process::id()
        ));
        let project = root.join("project");
        fs::create_dir_all(&project).expect("project fixture should be creatable");
        let alias = project.join("..").join("project");
        let project_path = project.to_string_lossy().into_owned();
        let alias_path = alias.to_string_lossy().into_owned();
        assert_eq!(path_key(&project_path), path_key(&alias_path));

        let session = |id: &str, cwd: String, updated_at| SessionSummary {
            id: id.to_owned(),
            title: id.to_owned(),
            pinned_title: None,
            project_key: path_key(&cwd),
            cwd,
            file_path: format!("{id}.jsonl"),
            parent_session_path: None,
            created_at: String::new(),
            updated_at,
            model: None,
            thinking_level: None,
            configured_thinking_level: None,
            source: "omp".to_owned(),
            primary_provider_pinned: false,
            has_messages: false,
        };
        let key = path_key(&project_path);
        let mut settings = AppSettings {
            recent_workspaces: vec![project_path, alias_path],
            workspace_names: BTreeMap::from([(key.clone(), "Renamed project".to_owned())]),
            ..AppSettings::default()
        };
        let sessions = [
            session("one", project.to_string_lossy().into_owned(), 1),
            session("two", alias.to_string_lossy().into_owned(), 2),
        ];
        let workspaces = build_workspaces(&sessions, &settings);
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].session_count, 2);
        assert_eq!(workspaces[0].name, "Renamed project");

        settings.hidden_workspaces.push(key);
        assert!(build_workspaces(&sessions, &settings).is_empty());

        fs::remove_dir_all(root).expect("fixture should be removable");
    }

    #[test]
    fn five_hundred_megabyte_summary_stays_within_two_second_budget() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-large-summary-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("fixture root should be creatable");
        let project = root.join("project");
        fs::create_dir_all(&project).expect("project should be creatable");
        let path = root.join("large.jsonl");
        let mut file = fs::File::create(&path).expect("large fixture should be creatable");
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "session",
                "id": "large-session",
                "cwd": project.to_string_lossy(),
            })
        )
        .expect("session header should be writable");
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "message",
                "id": "m1",
                "message": { "role": "user", "content": "hello" },
            })
        )
        .expect("message should be writable");
        let logical_size = 500_u64 * 1024 * 1024;
        file.set_len(logical_size)
            .expect("large fixture should be extendable");
        let tail = serde_json::json!({
            "type": "model_change",
            "model": "provider/latest",
            "role": "default",
        })
        .to_string();
        file.seek(SeekFrom::Start(logical_size - tail.len() as u64 - 2))
            .expect("large fixture tail should be seekable");
        write!(file, "\n{tail}\n").expect("tail should be writable");
        drop(file);

        let started = Instant::now();
        let summary = parse_session_with_names(&path, &HashMap::new())
            .expect("large summary should parse")
            .expect("large summary should be recognized");
        let elapsed = started.elapsed();
        assert_eq!(summary.id, "large-session");
        assert_eq!(summary.model.as_deref(), Some("provider/latest"));
        assert!(summary.has_messages);
        assert!(
            elapsed < Duration::from_secs(2),
            "500 MB summary exceeded 2 s budget: {elapsed:?}"
        );

        fs::remove_dir_all(root).expect("fixture should be removable");
    }

    #[test]
    fn import_rejects_files_above_the_explicit_memory_budget() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "omp-desktop-import-cap-{}-{nonce}.jsonl",
            std::process::id()
        ));
        let file = fs::File::create(&path).expect("fixture should be creatable");
        file.set_len(MAX_IMPORT_BYTES + 1)
            .expect("fixture should be extendable");
        drop(file);

        let error = validated_external_import_source(path.to_string_lossy().as_ref())
            .expect_err("oversized import should fail before reading its contents");
        assert!(error.contains("256 MiB"));

        let (bounded, overflow) = read_import_bytes(io::Cursor::new(vec![0_u8; 65]), 64)
            .expect("bounded reader should consume its fixture");
        assert!(overflow);
        assert_eq!(bounded.len(), 64);

        fs::remove_file(path).expect("fixture should be removable");
    }

    #[test]
    #[ignore = "manual 10k-session cold/warm discovery benchmark"]
    fn ten_thousand_session_discovery_meets_cold_and_warm_budgets() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-10k-scan-{}-{nonce}",
            std::process::id()
        ));
        let project = root.join("project");
        let sessions = root.join("sessions");
        fs::create_dir_all(&project).expect("project should be creatable");
        fs::create_dir_all(&sessions).expect("session root should be creatable");
        for index in 0..10_000 {
            let body = serde_json::json!({
                "type": "session",
                "id": format!("session-{index}"),
                "cwd": project.to_string_lossy(),
            });
            fs::write(
                sessions.join(format!("session-{index}.jsonl")),
                format!("{body}\n"),
            )
            .expect("session fixture should be writable");
        }

        let cold_started = Instant::now();
        assert_eq!(
            scan_sessions(&sessions)
                .expect("cold scan should succeed")
                .len(),
            10_000
        );
        let cold = cold_started.elapsed();
        let warm_started = Instant::now();
        assert_eq!(
            scan_sessions(&sessions)
                .expect("warm scan should succeed")
                .len(),
            10_000
        );
        let warm = warm_started.elapsed();
        eprintln!("10k session scan: cold={cold:?}, warm={warm:?}");
        assert!(
            cold < Duration::from_secs(10),
            "cold scan exceeded 10 s: {cold:?}"
        );
        assert!(
            warm < Duration::from_secs(3),
            "warm scan exceeded 3 s: {warm:?}"
        );

        fs::remove_dir_all(root).expect("fixture should be removable");
    }
}
