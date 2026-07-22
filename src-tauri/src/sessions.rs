use crate::{
    models::{
        AppSettings, BootstrapPayload, CodexSessionSummary, SessionSummary, SessionTranscript,
        TranscriptEntry, WorkspaceSummary,
    },
    settings::runtime_info,
};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

const TITLE_SLOT_BYTES: usize = 256;

pub fn build_bootstrap(
    app: &AppHandle,
    settings: &AppSettings,
) -> Result<BootstrapPayload, String> {
    let runtime = runtime_info(app, settings)?;
    let mut sessions = scan_sessions(Path::new(&runtime.session_root))?;
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    let workspaces = build_workspaces(&sessions, &settings.recent_workspaces);

    Ok(BootstrapPayload {
        settings: settings.clone(),
        runtime,
        workspaces,
        sessions,
    })
}

pub fn path_key(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized.to_owned()
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

pub fn rename_session(path: &str, title: &str) -> Result<(), String> {
    let title = clean_title(title)?;
    let file_path = Path::new(path);
    if !file_path.is_file() {
        return Err(format!("Файл сессии не найден: {path}"));
    }

    let metadata = fs::metadata(file_path).map_err(|error| {
        format!(
            "Не удалось прочитать метаданные {}: {error}",
            file_path.display()
        )
    })?;
    let previous = read_session_title(file_path).ok().flatten();
    let now = now_iso();
    let slot = serialize_title_slot(&title, Some("user"), &now)?;

    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(file_path)
        .map_err(|error| format!("Не удалось открыть {}: {error}", file_path.display()))?;

    let mut prefix = vec![0u8; TITLE_SLOT_BYTES.min(metadata.len() as usize)];
    file.read_exact(&mut prefix)
        .map_err(|error| format!("Не удалось прочитать title slot: {error}"))?;
    let has_slot = prefix.starts_with(b"{\"type\":\"title\"");

    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("Не удалось перемотать файл: {error}"))?;

    if has_slot && metadata.len() as usize >= TITLE_SLOT_BYTES {
        file.write_all(slot.as_bytes())
            .map_err(|error| format!("Не удалось записать title slot: {error}"))?;
    } else {
        let rest = fs::read(file_path)
            .map_err(|error| format!("Не удалось прочитать {}: {error}", file_path.display()))?;
        let mut body = slot.into_bytes();
        body.extend_from_slice(&rest);
        fs::write(file_path, body)
            .map_err(|error| format!("Не удалось перезаписать {}: {error}", file_path.display()))?;
        file = fs::OpenOptions::new()
            .append(true)
            .open(file_path)
            .map_err(|error| format!("Не удалось открыть {}: {error}", file_path.display()))?;
    }

    let change = serde_json::json!({
        "type": "title_change",
        "id": format!("{:08x}", rand::random::<u32>()),
        "parentId": Value::Null,
        "timestamp": now,
        "title": title,
        "source": "user",
        "previousTitle": previous,
    });
    let line = format!("{}\n", serde_json::to_string(&change).unwrap_or_default());
    file.seek(SeekFrom::End(0))
        .map_err(|error| format!("Не удалось перейти в конец файла: {error}"))?;
    file.write_all(line.as_bytes())
        .map_err(|error| format!("Не удалось дописать title_change: {error}"))?;
    file.flush()
        .map_err(|error| format!("Не удалось сохранить изменения: {error}"))?;

    let _ = filetime::set_file_mtime(
        file_path,
        filetime::FileTime::from_last_modification_time(&metadata),
    );
    Ok(())
}

pub fn delete_session(path: &str, session_root: &Path) -> Result<(), String> {
    let root = session_root.canonicalize().map_err(|error| {
        format!(
            "Не удалось открыть папку сессий {}: {error}",
            session_root.display()
        )
    })?;
    let file = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("Файл сессии не найден: {path}: {error}"))?;
    if !file.starts_with(&root)
        || file.extension().and_then(|value| value.to_str()) != Some("jsonl")
    {
        return Err("Можно удалять только JSONL-файлы из папки сессий OMP".to_owned());
    }

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

pub fn import_session(path: &str, target_cwd: &str, session_root: &Path) -> Result<String, String> {
    let source = Path::new(path);
    if !source.is_file() {
        return Err(format!("Файл сессии не найден: {path}"));
    }
    let target_cwd = target_cwd.trim();
    if target_cwd.is_empty() || !Path::new(target_cwd).is_dir() {
        return Err(format!("Целевая папка проекта не найдена: {target_cwd}"));
    }

    let bytes = fs::read(source)
        .map_err(|error| format!("Не удалось прочитать {}: {error}", source.display()))?;
    let text = String::from_utf8_lossy(&bytes);
    if looks_like_codex_session(&text) {
        import_codex_session(source, &text, target_cwd, session_root)
    } else {
        import_omp_session(source, &bytes, target_cwd, session_root)
    }
}

pub fn read_session_transcript(path: &str, session_root: &Path) -> Result<SessionTranscript, String> {
    let root = session_root.canonicalize().map_err(|error| {
        format!(
            "Не удалось открыть папку сессий {}: {error}",
            session_root.display()
        )
    })?;
    let path = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("Файл сессии не найден: {path}: {error}"))?;
    if !path.starts_with(&root)
        || path.extension().and_then(|extension| extension.to_str()) != Some("jsonl")
    {
        return Err("Можно читать только JSONL-файлы из папки сессий OMP".to_owned());
    }

    let session = parse_session(&path)?
        .ok_or_else(|| format!("Не удалось найти session header в {}", path.display()))?;
    let file = fs::File::open(&path)
        .map_err(|error| format!("Не удалось открыть {}: {error}", path.display()))?;
    let reader = std::io::BufReader::new(file);
    let mut entries = Vec::new();

    for (line_index, line) in std::io::BufRead::lines(reader).enumerate() {
        let line = line
            .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display()))?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(entry) = transcript_entry_from_value(&value, line_index) {
            entries.push(entry);
        }
    }

    Ok(SessionTranscript {
        session,
        entries,
        updated_at: modified_millis(&path),
    })
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
            let mut text = transcript_content_text(message.get("content"));
            if text.trim().is_empty() {
                if let Some(error) = message.get("errorMessage").and_then(Value::as_str) {
                    text = format!("Ошибка: {error}");
                }
            }
            if text.trim().is_empty() {
                return None;
            }
            Some(TranscriptEntry {
                id,
                timestamp,
                role,
                text,
                kind: Some(event_type.to_owned()),
                model: message
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| value.get("model").and_then(Value::as_str).map(str::to_owned)),
            })
        }
        "model_change" => {
            let model = value.get("model").and_then(Value::as_str)?.to_owned();
            Some(TranscriptEntry {
                id,
                timestamp,
                role: "system".to_owned(),
                text: format!("Модель: {model}"),
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
                kind: Some(custom_type.to_owned()),
                model: None,
            })
        }
        _ => None,
    }
}

fn transcript_content_text(content: Option<&Value>) -> String {
    let Some(content) = content else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_owned();
    }
    let Some(items) = content.as_array() else {
        return String::new();
    };
    let mut parts = Vec::new();
    for item in items {
        let Some(item_type) = item.get("type").and_then(Value::as_str) else {
            if let Some(text) = item.as_str() {
                parts.push(text.to_owned());
            }
            continue;
        };
        match item_type {
            "text" | "input_text" | "output_text" => {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    parts.push(text.to_owned());
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
                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
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
    parts.join("\n\n")
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

fn import_omp_session(
    source: &Path,
    bytes: &[u8],
    target_cwd: &str,
    session_root: &Path,
) -> Result<String, String> {
    let text = String::from_utf8_lossy(bytes);
    let mut lines = text.lines();
    let first = lines
        .next()
        .ok_or_else(|| "Пустой файл сессии".to_owned())?;
    let second = lines
        .next()
        .ok_or_else(|| "В файле нет session header".to_owned())?;

    let mut header: Value = serde_json::from_str(second)
        .map_err(|error| format!("Некорректный session header: {error}"))?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        // maybe first line is header for legacy files
        if let Ok(legacy) = serde_json::from_str::<Value>(first) {
            if legacy.get("type").and_then(Value::as_str) == Some("session") {
                header = legacy;
            } else {
                return Err("Это не OMP session JSONL".to_owned());
            }
        } else {
            return Err("Это не OMP session JSONL".to_owned());
        }
    }

    header["cwd"] = Value::String(target_cwd.to_owned());
    if header.get("id").and_then(Value::as_str).is_none() {
        header["id"] = Value::String(format!("{:08x}", rand::random::<u32>()));
    }
    let now = now_iso();
    let title = header
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            serde_json::from_str::<Value>(first).ok().and_then(|value| {
                value
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
        })
        .unwrap_or_else(|| "Imported session".to_owned());

    let mut body = serialize_title_slot(&title, Some("user"), &now)?;
    body.push_str(&serde_json::to_string(&header).unwrap_or_default());
    body.push('\n');
    for line in text.lines().skip(2) {
        if line.trim().is_empty() {
            continue;
        }
        // skip old title/session headers if present
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            match value.get("type").and_then(Value::as_str) {
                Some("title") | Some("session") => continue,
                _ => {}
            }
        }
        body.push_str(line);
        body.push('\n');
    }

    let dest_dir = session_root.join(encode_session_dir_name(target_cwd));
    fs::create_dir_all(&dest_dir)
        .map_err(|error| format!("Не удалось создать {}: {error}", dest_dir.display()))?;
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("imported-session.jsonl");
    let mut dest = dest_dir.join(file_name);
    if dest.exists() {
        dest = dest_dir.join(format!("imported-{}-{}", now.replace(':', "-"), file_name));
    }
    fs::write(&dest, body)
        .map_err(|error| format!("Не удалось записать {}: {error}", dest.display()))?;

    let artifact_dir = source.with_extension("");
    if artifact_dir.is_dir() {
        let target_artifact = dest_dir.join(
            dest.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .as_ref(),
        );
        let mut options = fs_extra::dir::CopyOptions::new();
        options.copy_inside = true;
        options.overwrite = true;
        let _ = fs_extra::dir::copy(&artifact_dir, &target_artifact, &options);
    }

    Ok(dest.to_string_lossy().into_owned())
}

fn import_codex_session(
    source: &Path,
    text: &str,
    target_cwd: &str,
    session_root: &Path,
) -> Result<String, String> {
    let summary = parse_codex_session(source)?
        .ok_or_else(|| "Не удалось разобрать Codex session".to_owned())?;
    let now = now_iso();
    let session_id = format!("{:08x}{:08x}", rand::random::<u32>(), rand::random::<u32>());
    let mut body = serialize_title_slot(&summary.title, Some("user"), &now)?;
    let header = serde_json::json!({
        "type": "session",
        "version": 3,
        "id": session_id,
        "timestamp": summary.created_at.clone().if_empty(&now),
        "cwd": target_cwd,
        "title": summary.title,
        "titleSource": "user",
        "parentSession": format!("codex:{}", summary.id),
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
        "customType": "imported-from-codex",
        "data": {
            "sourcePath": source.to_string_lossy(),
            "sourceId": summary.id,
            "sourceCwd": summary.cwd,
        }
    });
    body.push_str(&serde_json::to_string(&note).unwrap_or_default());
    body.push('\n');

    let dest_dir = session_root.join(encode_session_dir_name(target_cwd));
    fs::create_dir_all(&dest_dir)
        .map_err(|error| format!("Не удалось создать {}: {error}", dest_dir.display()))?;
    let dest = dest_dir.join(format!(
        "{}-codex-{}.jsonl",
        now.replace(':', "-"),
        &session_id[..8.min(session_id.len())]
    ));
    fs::write(&dest, body)
        .map_err(|error| format!("Не удалось записать {}: {error}", dest.display()))?;
    Ok(dest.to_string_lossy().into_owned())
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
    let thread_names = load_codex_thread_names();
    let mut sessions = files
        .into_iter()
        .filter_map(|path| {
            parse_session_with_names(&path, &thread_names)
                .ok()
                .flatten()
        })
        .collect::<Vec<_>>();

    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    let mut seen_empty_cwd = HashSet::new();
    sessions.retain(|session| {
        let is_empty = !session.has_messages && (session.title == "Новая сессия" || session.title.trim().is_empty());
        if !is_empty {
            true
        } else {
            seen_empty_cwd.insert(session.cwd.clone())
        }
    });
    Ok(sessions)
}

fn collect_jsonl_files(
    directory: &Path,
    depth: usize,
    max_depth: usize,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("Не удалось прочитать {}: {error}", directory.display()))?;

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if file_type.is_dir() && depth < max_depth {
            collect_jsonl_files(&path, depth + 1, max_depth, files)?;
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
    parse_session_with_names(path, &thread_names)
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

fn parse_session_with_names(
    path: &Path,
    thread_names: &HashMap<String, String>,
) -> Result<Option<SessionSummary>, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("Не удалось открыть {}: {error}", path.display()))?;
    let mut reader = std::io::BufReader::new(file);
    let mut line = String::with_capacity(1024);
    let mut line_index = 0_usize;
    let mut id = None;
    let mut cwd = None;
    let mut title = None;
    let mut session_title = None;
    let mut codex_parent_id = None;
    let mut created_at = None;
    let mut models = HashMap::new();
    let mut last_model_role = None;
    let mut thinking_level = None;
    let mut configured_thinking_level = None;
    let mut has_messages = false;

    loop {
        line.clear();
        let bytes = std::io::BufRead::read_line(&mut reader, &mut line)
            .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display()))?;
        if bytes == 0 {
            break;
        }

        let parse_prefix = line_index < 12;
        line_index += 1;
        if !parse_prefix
            && !line.contains("\"model_change\"")
            && !line.contains("\"thinking_level_change\"")
            && !line.contains("\"title_change\"")
            && !line.contains("\"message\"")
        {
            continue;
        }

        let Ok(value) = serde_json::from_str::<Value>(&line) else {
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
                codex_parent_id = value
                    .get("parentSession")
                    .and_then(Value::as_str)
                    .and_then(|parent| parent.strip_prefix("codex:"))
                    .map(str::to_owned);
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
        cwd,
        file_path: path.to_string_lossy().into_owned(),
        created_at: created_at.unwrap_or_default(),
        updated_at,
        model,
        thinking_level,
        configured_thinking_level,
        source: "omp".to_owned(),
        has_messages,
    }))
}

fn parse_codex_session(path: &Path) -> Result<Option<CodexSessionSummary>, String> {
    let thread_names = load_codex_thread_names();
    parse_codex_session_with_names(path, &thread_names)
}

fn parse_codex_session_with_names(
    path: &Path,
    thread_names: &HashMap<String, String>,
) -> Result<Option<CodexSessionSummary>, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display()))?;
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

    for line in text.lines().take(80) {
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
    text.contains("\"type\":\"session_meta\"")
        || text.contains("\"originator\":\"codex")
        || text.contains("\"type\":\"turn_context\"")
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

fn build_workspaces(
    sessions: &[SessionSummary],
    recent_workspaces: &[String],
) -> Vec<WorkspaceSummary> {
    let recent_rank: HashMap<String, usize> = recent_workspaces
        .iter()
        .enumerate()
        .map(|(index, path)| (path_key(path), index))
        .collect();
    let mut workspaces = HashMap::<String, WorkspaceSummary>::new();

    for path in recent_workspaces {
        let key = path_key(path);
        workspaces.entry(key).or_insert_with(|| WorkspaceSummary {
            path: path.clone(),
            name: workspace_name(path),
            session_count: 0,
            last_active: 0,
            pinned: true,
        });
    }

    for session in sessions {
        let key = path_key(&session.cwd);
        let workspace = workspaces.entry(key).or_insert_with(|| WorkspaceSummary {
            path: session.cwd.clone(),
            name: workspace_name(&session.cwd),
            session_count: 0,
            last_active: 0,
            pinned: false,
        });
        workspace.session_count += 1;
        workspace.last_active = workspace.last_active.max(session.updated_at);
        workspace.pinned |= recent_rank.contains_key(&path_key(&workspace.path));
    }

    let mut result: Vec<_> = workspaces.into_values().collect();
    result.sort_by(|left, right| {
        let left_rank = recent_rank.get(&path_key(&left.path)).copied();
        let right_rank = recent_rank.get(&path_key(&right.path)).copied();
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

fn truncate_title(value: &str) -> String {
    let one_line = value.lines().next().unwrap_or(value).trim();
    one_line.chars().take(80).collect()
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

fn read_session_title(path: &Path) -> Result<Option<String>, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Не удалось открыть {}: {error}", path.display()))?;
    let mut buf = String::new();
    let mut chunk = [0u8; 512];
    let read = file
        .read(&mut chunk)
        .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display()))?;
    buf.push_str(&String::from_utf8_lossy(&chunk[..read]));
    let first = buf.lines().next().unwrap_or_default();
    if let Ok(value) = serde_json::from_str::<Value>(first) {
        if value.get("type").and_then(Value::as_str) == Some("title") {
            return Ok(value
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_owned));
        }
    }
    Ok(None)
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
        deduplicate_codex_sessions, delete_session, encode_session_dir_name, import_session,
        parse_codex_session_with_names, parse_session, parse_session_with_names, path_key,
        read_session_transcript, restorable_session_model, scan_sessions, serialize_title_slot,
        CodexSessionSummary,
    };
    use std::{
        collections::HashMap,
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn path_key_normalizes_separators_and_trailing_slash() {
        let key = path_key(r"D:\Projects\OMP\");
        assert!(!key.ends_with('/'));
        assert!(key.contains("/Projects/") || key.contains("/projects/"));
    }

    #[test]
    fn title_slot_is_fixed_width() {
        let line = serialize_title_slot("Hello", Some("user"), "2026-07-19T00:00:00Z").unwrap();
        assert_eq!(line.len(), 256);
        assert!(line.ends_with('\n'));
    }

    #[test]
    fn encode_absolute_windows_path() {
        let name = encode_session_dir_name(r"D:\Projects\OMP");
        assert!(name.starts_with("--") || name.starts_with('-'));
        assert!(!name.contains('?'));
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
        assert!(session.updated_at > 0);
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
            "\n"
        );
        fs::write(&path, contents).expect("fixture should be writable");

        let transcript = read_session_transcript(path.to_string_lossy().as_ref(), &root)
            .expect("transcript should be readable");
        assert_eq!(transcript.session.id, "session-id");
        assert_eq!(transcript.entries.len(), 2);
        assert_eq!(transcript.entries[0].text, "First line\nSecond line");
        assert!(transcript.entries[1].text.contains("Инструмент: read"));
        assert!(transcript.entries[1].text.contains("Complete answer"));
        assert_eq!(transcript.entries[1].model.as_deref(), Some("model-a"));

        let external = root.with_extension("external.jsonl");
        fs::write(&external, contents).expect("external fixture should be writable");
        assert!(read_session_transcript(external.to_string_lossy().as_ref(), &root).is_err());
        fs::remove_file(external).expect("external fixture should be removable");
        fs::remove_dir_all(root).expect("fixture root should be removable");
    }
    #[test]
    fn scan_sessions_retains_titled_and_deduplicates_empty_untitled_sessions() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("omp-desktop-dedupe-{}-{nonce}", std::process::id()));
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
        fs::write(&untitled_msg, untitled_msg_content).expect("untitled_msg fixture should be writable");
        fs::write(&titled, titled_content).expect("titled fixture should be writable");

        let sessions = scan_sessions(&root).expect("sessions should be scannable");
        assert_eq!(sessions.len(), 3);
        assert!(sessions.iter().any(|s| s.title == "Real work session"));
        assert!(sessions.iter().any(|s| s.id == "s-untitled-msg" && s.has_messages));
        assert_eq!(sessions.iter().filter(|s| !s.has_messages && s.title == "Новая сессия").count(), 1);

        fs::remove_dir_all(root).expect("test root should be removable");
    }
    #[test]
    fn scan_sessions_ignores_system_only_and_roleless_custom_messages_and_deduplicates_them() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("omp-desktop-system-{}-{nonce}", std::process::id()));
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
        fs::write(&roleless_custom, roleless_content).expect("roleless_custom fixture should be writable");

        let parsed_sys = parse_session_with_names(&system_only, &HashMap::new())
            .expect("parse should succeed")
            .expect("session summary should be returned");
        assert!(!parsed_sys.has_messages, "System-only message must not set has_messages to true");

        let parsed_roleless = parse_session_with_names(&roleless_custom, &HashMap::new())
            .expect("parse should succeed")
            .expect("session summary should be returned");
        assert!(!parsed_roleless.has_messages, "Roleless custom message must not set has_messages to true");

        let sessions = scan_sessions(&root).expect("sessions should be scannable");
        assert_eq!(sessions.len(), 1, "Multiple empty/system-only sessions must deduplicate to 1");

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

        let imported_path = import_session(
            source.to_string_lossy().as_ref(),
            &project_path,
            &session_root,
        )
        .expect("Codex fixture should import");
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
}
