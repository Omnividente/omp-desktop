use crate::{
    models::{BootstrapPayload, SessionSummary, WorkspaceSummary},
    settings::runtime_info,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri::AppHandle;

use crate::models::AppSettings;

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
    collect_jsonl_files(root, 0, &mut files)?;
    Ok(files
        .into_iter()
        .filter_map(|path| parse_session(&path).ok().flatten())
        .collect())
}

fn collect_jsonl_files(
    directory: &Path,
    depth: usize,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("Не удалось прочитать {}: {error}", directory.display()))?;

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if file_type.is_dir() && depth < 3 {
            collect_jsonl_files(&path, depth + 1, files)?;
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
    let file = File::open(path)
        .map_err(|error| format!("Не удалось открыть {}: {error}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut line = String::with_capacity(1024);
    let mut id = None;
    let mut cwd = None;
    let mut title = None;
    let mut session_title = None;
    let mut created_at = None;
    let mut model = None;

    for _ in 0..8 {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
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
    let updated_at = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default();

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
    }))
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

#[cfg(test)]
mod tests {
    use super::{parse_session, path_key};
    use std::{
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
            r#"{"type":"title","v":1,"title":"Resume this work"}"#,
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
