use crate::{
    models::AppError,
    sessions::{normalize_windows_verbatim_path, validated_session_file},
    settings::{self, settings_snapshot, SettingsState},
};
use serde::Deserialize;
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use url::Url;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenContentLinkRequest {
    uri: String,
    session_path: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum ContentTarget {
    External(String),
    Reveal(PathBuf),
}

#[derive(Deserialize)]
struct SessionHeader {
    #[serde(rename = "type")]
    kind: String,
    id: String,
    cwd: String,
}

fn session_header(session: &Path) -> Result<SessionHeader, String> {
    // Only the header is needed; never load conversation content or global session indexes.
    let file = fs::File::open(session).map_err(|_| "Не удалось прочитать заголовок сессии")?;
    let mut line = String::new();
    BufReader::new(file.take(64 * 1024))
        .read_line(&mut line)
        .map_err(|_| "Не удалось прочитать заголовок сессии")?;
    let header: SessionHeader =
        serde_json::from_str(&line).map_err(|_| "Некорректный заголовок сессии OMP")?;
    if header.kind != "session" || header.id.is_empty() || header.cwd.is_empty() {
        return Err("Некорректный заголовок сессии OMP".to_owned());
    }
    Ok(header)
}

fn decode_path(value: &str) -> Result<String, String> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut source = value.bytes();
    while let Some(byte) = source.next() {
        if byte == b'%' {
            let high = source.next().and_then(|byte| (byte as char).to_digit(16));
            let low = source.next().and_then(|byte| (byte as char).to_digit(16));
            let (Some(high), Some(low)) = (high, low) else {
                return Err("Некорректное percent-кодирование ссылки".to_owned());
            };
            bytes.push((high * 16 + low) as u8);
        } else {
            bytes.push(byte);
        }
    }
    let decoded = String::from_utf8(bytes).map_err(|_| "Путь ссылки должен быть UTF-8")?;
    if decoded.chars().any(char::is_control) {
        return Err("Управляющие символы в ссылке запрещены".to_owned());
    }
    Ok(decoded)
}

fn relative_path(value: &str) -> Result<PathBuf, String> {
    let decoded = decode_path(value)?.replace('\\', "/");
    if decoded.is_empty()
        || decoded.starts_with('/')
        || decoded.contains(':')
        || decoded.split('/').any(|part| part == "..")
    {
        return Err("Ссылка должна указывать на файл внутри разрешённой папки".to_owned());
    }
    let path = PathBuf::from(decoded);
    if path
        .components()
        .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err("Недопустимый путь ссылки".to_owned());
    }
    Ok(path)
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map(normalize_windows_verbatim_path)
        .map_err(|_| "Файл или папка ссылки не найдены либо недоступны".to_owned())
}

fn contained(path: &Path, root: &Path) -> Result<PathBuf, String> {
    let target = canonical(path)?;
    if !target.starts_with(root) {
        return Err("Ссылка выходит за пределы разрешённой папки".to_owned());
    }
    Ok(target)
}

fn sidecar_root(session: &Path) -> Result<PathBuf, String> {
    let expected = session.with_extension("");
    let root = canonical(&expected)?;
    // Do not trust a sidecar symlink, even if it points at another valid session.
    if root != expected || !root.is_dir() {
        return Err("Папка артефактов сессии недоступна или перенаправлена".to_owned());
    }
    Ok(root)
}

fn local_root(session: &Path, header: &SessionHeader) -> Result<PathBuf, String> {
    let candidate = session.with_extension("").join("local");
    let expected = if cfg!(windows) && candidate.to_string_lossy().encode_utf16().count() >= 180 {
        // Match runtime resolveLocalRoot/safeSessionId for Windows long paths.
        let id: String = header
            .id
            .encode_utf16()
            .map(|unit| match char::from_u32(u32::from(unit)) {
                Some(ch) if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') => ch,
                _ => '_',
            })
            .collect();
        if id == "." || id == ".." {
            return Err("Некорректный идентификатор сессии".to_owned());
        }
        canonical(&std::env::temp_dir())?.join("omp-local").join(id)
    } else {
        sidecar_root(session)?.join("local")
    };
    let root = canonical(&expected)?;
    if root != expected || !root.is_dir() {
        return Err("Папка local сессии недоступна или перенаправлена".to_owned());
    }
    Ok(root)
}

fn artifact_path(session: &Path, value: &str) -> Result<PathBuf, String> {
    let relative = relative_path(value)?;
    let root = sidecar_root(session)?;
    let decoded = relative.to_string_lossy();
    if decoded.bytes().all(|byte| byte.is_ascii_digit()) {
        // Runtime ArtifactManager stores {id}.{toolType}.log in this session's sidecar.
        let prefix = format!("{decoded}.");
        let mut found = None;
        for entry in fs::read_dir(&root).map_err(|_| "Не удалось прочитать папку артефактов")?
        {
            let entry = entry.map_err(|_| "Не удалось прочитать папку артефактов")?;
            let name = entry.file_name();
            if name.to_str().is_some_and(|name| name.starts_with(&prefix)) {
                if found.is_some() {
                    return Err(
                        "Идентификатор артефакта неоднозначен; укажите полное имя файла".to_owned(),
                    );
                }
                found = Some(entry.path());
            }
        }
        let path = found.ok_or("Артефакт не найден в выбранной сессии")?;
        contained(&path, &root)
    } else {
        contained(&root.join(relative), &root)
    }
}

fn resolve_content_link(
    request: &OpenContentLinkRequest,
    session_root: &Path,
) -> Result<ContentTarget, String> {
    let uri = request.uri.trim();
    if uri.is_empty() || request.uri.chars().any(char::is_control) {
        return Err("Ссылка пуста или содержит управляющие символы".to_owned());
    }
    let parsed = Url::parse(uri).ok();
    if let Some(url) = &parsed {
        match url.scheme() {
            "http" | "https" if url.host_str().is_some() => {
                return Ok(ContentTarget::External(url.as_str().to_owned()));
            }
            "mailto" if !url.path().is_empty() => {
                decode_path(uri)?;
                return Ok(ContentTarget::External(url.as_str().to_owned()));
            }
            "local" | "artifact" | "file" => {}
            _ => return Err("Этот протокол ссылки не поддерживается".to_owned()),
        }
    }
    let session = validated_session_file(
        request
            .session_path
            .as_deref()
            .ok_or("Для файловой ссылки нужна сохранённая сессия OMP")?,
        session_root,
    )
    .map_err(|_| "Разрешена только существующая сессия JSONL из настроенной папки OMP")?;
    let header = session_header(&session)?;
    let target = match parsed.as_ref().map(Url::scheme) {
        Some("local" | "artifact") => {
            // Preserve raw case and dot segments: URL normalization must not erase traversal.
            let (scheme, value) = uri
                .split_once("://")
                .ok_or("Некорректная внутренняя ссылка")?;
            if value.contains(['?', '#']) {
                return Err(
                    "Селекторы внутренних ресурсов не поддерживаются; откройте ссылку на файл"
                        .to_owned(),
                );
            }
            if scheme.eq_ignore_ascii_case("local") {
                let relative = relative_path(value)?;
                let root = local_root(&session, &header)?;
                contained(&root.join(relative), &root)?
            } else {
                artifact_path(&session, value)?
            }
        }
        Some("file") => {
            let url = parsed.as_ref().expect("file URL was parsed");
            if url
                .host_str()
                .is_some_and(|host| !host.eq_ignore_ascii_case("localhost"))
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("Разрешены только локальные file:// ссылки без селекторов".to_owned());
            }
            let raw = decode_path(uri)?.replace('\\', "/");
            if raw.split('/').any(|part| part == "..") {
                return Err("Переход к родительской папке в ссылке запрещён".to_owned());
            }
            let path = url
                .to_file_path()
                .map_err(|_| "Некорректная file:// ссылка")?;
            let text = path.to_string_lossy();
            if text.starts_with("\\\\") || text.starts_with("//")
                || path.components().any(|part| matches!(part, Component::Normal(value) if value.to_string_lossy().contains(':')))
            {
                return Err("Сетевые, служебные пути и альтернативные потоки запрещены".to_owned());
            }
            canonical(&path)?
        }
        None => {
            let relative = relative_path(uri)?;
            let cwd = Path::new(&header.cwd);
            if !cwd.is_absolute() {
                return Err("Рабочая папка сессии недоступна".to_owned());
            }
            let root = canonical(cwd)?;
            contained(&root.join(relative), &root)?
        }
        _ => return Err("Этот протокол ссылки не поддерживается".to_owned()),
    };
    if target.to_string_lossy().starts_with("\\\\") || target.to_string_lossy().starts_with("//") {
        return Err("Сетевые файловые ссылки не поддерживаются".to_owned());
    }
    if !target.is_file() && !target.is_dir() {
        return Err("Ссылка не указывает на обычный файл или папку".to_owned());
    }
    Ok(ContentTarget::Reveal(target))
}

#[tauri::command]
pub(crate) async fn open_content_link(
    request: OpenContentLinkRequest,
    app: AppHandle,
) -> Result<(), AppError> {
    crate::run_blocking(
        "открытия ссылки",
        "content_link_failed",
        "Не удалось открыть ссылку",
        move || {
            let state = app.state::<SettingsState>();
            let snapshot = settings_snapshot(&app, &state)
                .map_err(|_| "Не удалось получить настройки папки сессий")?;
            let root = settings::session_root(&app, &snapshot)
                .map_err(|_| "Не удалось определить папку сессий")?;
            match resolve_content_link(&request, &root)? {
                ContentTarget::External(uri) => app
                    .opener()
                    .open_url(uri, None::<&str>)
                    .map_err(|_| "Системное приложение не смогло открыть ссылку".to_owned()),
                // Reveal every file type, including executables, scripts, shortcuts and HTML.
                // Never invoke a file association that can execute response-provided content.
                ContentTarget::Reveal(path) => app
                    .opener()
                    .reveal_item_in_dir(path)
                    .map_err(|_| "Файловый менеджер не смог показать файл".to_owned()),
            }
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Fixture {
        directory: PathBuf,
        sessions: PathBuf,
        session: PathBuf,
        project: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let directory = std::env::temp_dir().join(format!(
                "omp-links-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&directory).unwrap();
            let sessions = directory.join("sessions");
            let project = directory.join("проект с пробелами");
            fs::create_dir(&sessions).unwrap();
            fs::create_dir(&project).unwrap();
            let session = sessions.join("test.jsonl");
            fs::write(
                &session,
                serde_json::json!({
                    "type": "session", "id": "content-link-fixture", "cwd": project,
                })
                .to_string()
                    + "\n",
            )
            .unwrap();
            fs::create_dir_all(session.with_extension("").join("local")).unwrap();
            Self {
                directory,
                sessions,
                session,
                project,
            }
        }

        fn resolve(&self, uri: &str) -> Result<ContentTarget, String> {
            resolve_content_link(
                &OpenContentLinkRequest {
                    uri: uri.to_owned(),
                    session_path: Some(self.session.to_string_lossy().into_owned()),
                },
                &self.sessions,
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn resolves_session_local_artifact_and_project_files_without_executing() {
        let fixture = Fixture::new();
        let sidecar = fixture.session.with_extension("");
        let local = sidecar.join("local/Отчёт за день.md");
        let artifact = sidecar.join("12.bash.log");
        let script = fixture.project.join("не запускать.cmd");
        fs::write(&local, "document").unwrap();
        fs::write(&artifact, "output").unwrap();
        fs::write(&script, "exit 1").unwrap();
        for (uri, path) in [
            ("local://%D0%9E%D1%82%D1%87%D1%91%D1%82%20%D0%B7%D0%B0%20%D0%B4%D0%B5%D0%BD%D1%8C.md", &local),
            ("artifact://12", &artifact),
            ("artifact://12.bash.log", &artifact),
            ("не%20запускать.cmd", &script),
        ] {
            assert_eq!(fixture.resolve(uri).unwrap(), ContentTarget::Reveal(canonical(path).unwrap()));
        }
        let url = Url::from_file_path(&script).unwrap();
        assert_eq!(
            fixture.resolve(url.as_str()).unwrap(),
            ContentTarget::Reveal(canonical(&script).unwrap())
        );
        assert!(fixture.resolve("artifact://13").is_err());
        assert!(fixture.resolve("local://missing.md").is_err());
    }

    #[test]
    fn rejects_traversal_unsafe_protocols_and_foreign_sessions() {
        let fixture = Fixture::new();
        for uri in [
            "local://../test.jsonl",
            "local://%2e%2e/test.jsonl",
            "local://folder/%2e%2e/test.jsonl",
            "local://%2fetc/passwd",
            "artifact://..%5csecret",
            "../outside.txt",
            "local://doc%00.md",
            "local://doc%ZZ.md",
            "local://C%3A/file",
            "javascript:alert(1)",
            "data:text/html,test",
            "powershell://run",
            "file://server/share/file",
            "mailto:test@example.com?subject=hello%0d%0abcc:other@example.com",
        ] {
            assert!(fixture.resolve(uri).is_err(), "must reject {uri}");
        }
        let outside = fixture.directory.join("outside.jsonl");
        fs::copy(&fixture.session, &outside).unwrap();
        let result = resolve_content_link(
            &OpenContentLinkRequest {
                uri: "local://file.md".to_owned(),
                session_path: Some(outside.to_string_lossy().into_owned()),
            },
            &fixture.sessions,
        );
        assert!(result.is_err());
    }

    #[test]
    fn external_links_do_not_require_a_saved_session() {
        for uri in [
            "https://example.com/a%20b?q=1#part",
            "http://example.com/",
            "mailto:test@example.com?subject=Hello%20world",
        ] {
            assert_eq!(
                resolve_content_link(
                    &OpenContentLinkRequest {
                        uri: uri.to_owned(),
                        session_path: None,
                    },
                    Path::new("missing-session-root")
                )
                .unwrap(),
                ContentTarget::External(uri.to_owned())
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_and_redirected_sidecar() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = fixture.project.join("outside.txt");
        fs::write(&outside, "outside").unwrap();
        let sidecar = fixture.session.with_extension("");
        symlink(&outside, sidecar.join("local/escape.txt")).unwrap();
        assert!(fixture.resolve("local://escape.txt").is_err());
        fs::remove_dir_all(&sidecar).unwrap();
        symlink(&fixture.project, &sidecar).unwrap();
        assert!(fixture.resolve("artifact://outside.txt").is_err());
    }
}
