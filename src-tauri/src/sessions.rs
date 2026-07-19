use crate::{
    models::{
        AppSettings, BootstrapPayload, CodexSessionSummary, SessionSummary, WorkspaceSummary,
    },
    settings::runtime_info,
};
use serde_json::Value;
use std::{
    collections::HashMap,
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

pub fn encode_session_dir_name(cwd: &str) -> String {
    let resolved = PathBuf::from(cwd);
    let resolved = resolved
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(cwd));
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from);
    let temp = env::temp_dir();

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
        stripped
            .replace(['/', '\\', ':'], "-")
            .trim_matches('-')
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

    let metadata = fs::metadata(file_path)
        .map_err(|error| format!("Не удалось прочитать метаданные {}: {error}", file_path.display()))?;
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

pub fn import_session(
    path: &str,
    target_cwd: &str,
    session_root: &Path,
) -> Result<String, String> {
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

pub fn list_codex_sessions() -> Result<Vec<CodexSessionSummary>, String> {
    let root = codex_sessions_root();
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    collect_jsonl_files(&root, 0, 8, &mut files)?;
    let mut sessions = files
        .into_iter()
        .filter_map(|path| parse_codex_session(&path).ok().flatten())
        .collect::<Vec<_>>();
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    Ok(sessions)
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
            serde_json::from_str::<Value>(first)
                .ok()
                .and_then(|value| {
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
        dest = dest_dir.join(format!(
            "imported-{}-{}",
            now.replace(':', "-"),
            file_name
        ));
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
                let role = payload
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let content = extract_text_content(payload.get("content"));
                if content.trim().is_empty() {
                    continue;
                }
                if role != "user" && role != "assistant" && role != "developer" {
                    continue;
                }
                let id = format!("{:08x}", rand::random::<u32>());
                let entry = serde_json::json!({
                    "type": "message",
                    "id": id,
                    "parentId": parent,
                    "timestamp": timestamp,
                    "message": {
                        "role": if role == "developer" { "user" } else { role },
                        "content": [{"type": "text", "text": content}],
                        "timestamp": timestamp
                    }
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
                            "timestamp": timestamp
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
    Ok(files
        .into_iter()
        .filter_map(|path| parse_session(&path).ok().flatten())
        .collect())
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

fn parse_session(path: &Path) -> Result<Option<SessionSummary>, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("Не удалось открыть {}: {error}", path.display()))?;
    let mut reader = std::io::BufReader::new(file);
    let mut line = String::with_capacity(1024);
    let mut id = None;
    let mut cwd = None;
    let mut title = None;
    let mut session_title = None;
    let mut created_at = None;
    let mut model = None;

    for _ in 0..12 {
        line.clear();
        let bytes = std::io::BufRead::read_line(&mut reader, &mut line)
            .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display()))?;
        if bytes == 0 {
            break;
        }

        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("title") => {
                title = value
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
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
            }
            Some("model_change") => {
                model = value
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            _ => {}
        }

        if id.is_some() && cwd.is_some() && title.is_some() && model.is_some() {
            break;
        }
    }

    let (Some(id), Some(cwd)) = (id, cwd) else {
        return Ok(None);
    };
    let updated_at = modified_millis(path);

    Ok(Some(SessionSummary {
        id,
        title: title
            .or(session_title)
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| "Новая сессия".to_owned()),
        cwd,
        file_path: path.to_string_lossy().into_owned(),
        created_at: created_at.unwrap_or_default(),
        updated_at,
        model,
        source: "omp".to_owned(),
    }))
}

fn parse_codex_session(path: &Path) -> Result<Option<CodexSessionSummary>, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display()))?;
    if !looks_like_codex_session(&text) {
        return Ok(None);
    }

    let mut id = None;
    let mut cwd = None;
    let mut created_at = None;
    let mut model = None;
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
                model = payload
                    .get("model_provider")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or(model);
            }
            Some("turn_context") => {
                let payload = value.get("payload").cloned().unwrap_or(Value::Null);
                cwd = payload
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or(cwd);
                if let Some(m) = payload.get("model").and_then(Value::as_str) {
                    let provider = model.clone().unwrap_or_default();
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
                        if title.is_none() {
                            title = Some(truncate_title(message));
                        }
                        if preview.is_empty() {
                            preview = message.chars().take(160).collect();
                        }
                    }
                }
            }
            Some("response_item") => {
                let payload = value.get("payload").cloned().unwrap_or(Value::Null);
                if payload.get("role").and_then(Value::as_str) == Some("user") {
                    let content = extract_text_content(payload.get("content"));
                    if !content.trim().is_empty() {
                        if title.is_none() {
                            title = Some(truncate_title(&content));
                        }
                        if preview.is_empty() {
                            preview = content.chars().take(160).collect();
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
    Ok(Some(CodexSessionSummary {
        id,
        title: title
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "Codex session".to_owned()),
        cwd,
        file_path: path.to_string_lossy().into_owned(),
        created_at: created_at.unwrap_or_default(),
        updated_at: modified_millis(path),
        model,
        preview,
    }))
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
    use super::{encode_session_dir_name, parse_session, path_key, serialize_title_slot};
    use std::{fs, time::{SystemTime, UNIX_EPOCH}};

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
    }

    #[test]
    fn session_header_exposes_resume_metadata() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "omp-desktop-session-{}-{nonce}.jsonl",
            std::process::id()
        ));
        let contents = concat!(
            r#"{"type":"title","v":1,"title":"Resume this work","updatedAt":"2026-07-18T10:00:00Z","pad":""}"#,
            "\n",
            r#"{"type":"session","version":3,"id":"session-id","timestamp":"2026-07-18T10:00:00Z","cwd":"/tmp/project"}"#,
            "\n",
            r#"{"type":"model_change","model":"provider/model"}"#,
            "\n"
        );
        fs::write(&path, contents).expect("fixture should be writable");

        let session = parse_session(&path)
            .expect("fixture should be readable")
            .expect("fixture should contain a session header");
        fs::remove_file(&path).expect("fixture should be removable");

        assert_eq!(session.id, "session-id");
        assert_eq!(session.title, "Resume this work");
        assert_eq!(session.cwd, "/tmp/project");
        assert_eq!(session.created_at, "2026-07-18T10:00:00Z");
        assert_eq!(session.model.as_deref(), Some("provider/model"));
        assert!(session.updated_at > 0);
    }
}
