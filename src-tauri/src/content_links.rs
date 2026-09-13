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
    #[serde(default)]
    action: ContentLinkAction,
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ContentLinkAction {
    #[default]
    Open,
    Reveal,
}

#[derive(Debug, PartialEq, Eq)]
enum ContentTarget {
    External(String),
    Open(PathBuf),
    Reveal(PathBuf),
}

#[derive(Deserialize)]
struct SessionHeader {
    #[serde(rename = "type")]
    kind: String,
    id: String,
    #[serde(default)]
    cwd: Option<String>,
}

fn session_header(session: &Path) -> Result<SessionHeader, String> {
    // Runtime session-title-slot.ts writes an optional title record before the
    // logical session header. Read at most these two metadata records, not chat.
    let file = fs::File::open(session).map_err(|_| "Не удалось прочитать заголовок сессии")?;
    let mut reader = BufReader::new(file.take(64 * 1024));
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|_| "Не удалось прочитать заголовок сессии")?;
    let value: serde_json::Value =
        serde_json::from_str(&line).map_err(|_| "Некорректные метаданные сессии OMP")?;
    let value = if value.get("type").and_then(serde_json::Value::as_str) == Some("title") {
        if value.get("v").and_then(serde_json::Value::as_u64) != Some(1)
            || ["title", "updatedAt", "pad"]
                .iter()
                .any(|key| !value.get(key).is_some_and(serde_json::Value::is_string))
            || value
                .get("source")
                .is_some_and(|source| !matches!(source.as_str(), Some("auto" | "user")))
        {
            return Err("Некорректная запись заголовка названия сессии OMP".to_owned());
        }
        line.clear();
        reader
            .read_line(&mut line)
            .map_err(|_| "Не удалось прочитать заголовок сессии")?;
        serde_json::from_str(&line)
            .map_err(|_| "После названия отсутствует корректный заголовок сессии OMP")?
    } else {
        value
    };
    let header: SessionHeader =
        serde_json::from_value(value).map_err(|_| "Некорректный заголовок сессии OMP")?;
    if header.kind != "session" || header.id.is_empty() {
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

fn local_root(session: &Path) -> Result<PathBuf, String> {
    let candidate = session.with_extension("").join("local");
    let expected = if cfg!(windows) && candidate.to_string_lossy().encode_utf16().count() >= 180 {
        // Match runtime resolveLocalRoot/safeSessionId for Windows long paths.
        let header = session_header(session)?;
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
            if name
                .to_str()
                .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".log"))
            {
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

fn is_line_selector(value: &str) -> bool {
    fn number(value: &str) -> Option<u64> {
        let value = value.strip_prefix(['L', 'l']).unwrap_or(value);
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        value.parse().ok().filter(|value| *value > 0)
    }
    value.split(',').all(|range| {
        if let Some(rest) = range.strip_prefix('-') {
            return number(rest).is_some();
        }
        if let Some((start, count)) = range.split_once('+') {
            return number(start)
                .zip(number(count))
                .is_some_and(|(start, count)| start.checked_add(count - 1).is_some());
        }
        if let Some((start, end)) = range.split_once("..").or_else(|| range.split_once('-')) {
            return number(start).is_some_and(|start| {
                end.is_empty() || number(end).is_some_and(|end| end >= start)
            });
        }
        number(range).is_some()
    })
}

// Native associations cannot honor line/render selectors. Open their underlying
// file, without interpreting encoded colons (which may be ADS or literal names).
fn without_selector(value: &str) -> &str {
    let Some((path, selector)) = value.rsplit_once(':') else {
        return value;
    };
    if selector.eq_ignore_ascii_case("raw") || is_line_selector(selector) {
        if let Some((base, previous)) = path.rsplit_once(':') {
            if (selector.eq_ignore_ascii_case("raw") && is_line_selector(previous))
                || (is_line_selector(selector) && previous.eq_ignore_ascii_case("raw"))
            {
                return base;
            }
        }
        return path;
    }
    if selector.eq_ignore_ascii_case("img") || selector.eq_ignore_ascii_case("conflicts") {
        return path;
    }
    value
}

fn opens_as_document(path: &Path) -> Result<bool, String> {
    // Unknown associations, programs, scripts, shortcuts and macro-enabled Office
    // files are reveal-only. An extension allowlist avoids an incomplete denylist.
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "txt"
            | "md"
            | "markdown"
            | "log"
            | "csv"
            | "tsv"
            | "json"
            | "jsonl"
            | "yaml"
            | "yml"
            | "toml"
            | "xml"
            | "ini"
            | "cfg"
            | "pdf"
            | "rtf"
            | "docx"
            | "xlsx"
            | "pptx"
            | "odt"
            | "ods"
            | "odp"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "ico"
            | "svg"
            | "html"
            | "htm"
            | "mp3"
            | "wav"
            | "ogg"
            | "mp4"
            | "webm"
            | "mov"
    ) {
        return Ok(false);
    }
    let mut file = fs::File::open(path).map_err(|_| "Не удалось проверить тип файла ссылки")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if file
            .metadata()
            .map_err(|_| "Не удалось проверить права файла")?
            .permissions()
            .mode()
            & 0o111
            != 0
        {
            return Ok(false);
        }
    }
    let mut prefix = [0; 4];
    let count = file
        .read(&mut prefix)
        .map_err(|_| "Не удалось проверить тип файла ссылки")?;
    let prefix = &prefix[..count];
    Ok(!prefix.starts_with(b"#!") && !prefix.starts_with(b"MZ") && !prefix.starts_with(b"\x7fELF"))
}

fn resolve_content_link(
    request: &OpenContentLinkRequest,
    session_root: &Path,
) -> Result<ContentTarget, String> {
    let uri = request.uri.trim();
    if uri.is_empty() || request.uri.chars().any(char::is_control) {
        return Err("Ссылка пуста или содержит управляющие символы".to_owned());
    }
    let scheme = uri.split_once("://").map(|(scheme, _)| scheme);
    let internal = scheme.is_some_and(|scheme| {
        scheme.eq_ignore_ascii_case("local") || scheme.eq_ignore_ascii_case("artifact")
    });
    let file = scheme.is_some_and(|scheme| scheme.eq_ignore_ascii_case("file"));
    if !internal && !file {
        if let Ok(url) = Url::parse(uri) {
            if matches!(url.scheme(), "http" | "https" | "mailto") {
                if request.action == ContentLinkAction::Reveal {
                    return Err("Показать в папке можно только файловую ссылку".to_owned());
                }
                if url.scheme() == "mailto" {
                    decode_path(uri)?;
                    if url.path().is_empty() {
                        return Err("Пустой адрес почты".to_owned());
                    }
                } else if url.host_str().is_none() {
                    return Err("В ссылке отсутствует адрес сервера".to_owned());
                }
                return Ok(ContentTarget::External(url.as_str().to_owned()));
            }
            // A filename such as report.md:raw looks like a URL scheme to Url.
            // Bare protocol names must still be rejected before selector removal.
            if !url.scheme().contains('.') {
                return Err("Этот протокол ссылки не поддерживается".to_owned());
            }
        }
    }
    let uri = without_selector(uri);
    let session = || {
        validated_session_file(
            request
                .session_path
                .as_deref()
                .ok_or("Для этой ссылки нужна сохранённая сессия OMP")?,
            session_root,
        )
        .map_err(|_| {
            "Разрешена только существующая сессия JSONL из настроенной папки OMP".to_owned()
        })
    };
    let target = if internal {
        // Keep raw case/dot segments: URL normalization must not erase traversal.
        let (scheme, value) = uri
            .split_once("://")
            .ok_or("Некорректная внутренняя ссылка")?;
        if value.contains(['?', '#']) {
            return Err("Параметры и фрагменты файловых ссылок не поддерживаются; символы имени кодируйте percent-кодированием".to_owned());
        }
        let session = session()?;
        if scheme.eq_ignore_ascii_case("local") {
            // The runtime accepts an empty host and a single root slash too.
            let value = value.strip_prefix('/').unwrap_or(value);
            let root = local_root(&session)?;
            if value.is_empty() {
                root
            } else {
                contained(&root.join(relative_path(value)?), &root)?
            }
        } else if value.is_empty() {
            sidecar_root(&session)?
        } else {
            artifact_path(&session, value)?
        }
    } else if file {
        // A fully qualified file URL needs neither a session nor its metadata.
        let url = Url::parse(uri).map_err(|_| "Некорректная file:// ссылка")?;
        if url
            .host_str()
            .is_some_and(|host| !host.eq_ignore_ascii_case("localhost"))
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "Разрешены только локальные file:// ссылки без параметров и фрагментов".to_owned(),
            );
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
    } else {
        if Url::parse(uri).is_ok() {
            return Err("Этот протокол ссылки не поддерживается".to_owned());
        }
        if uri.contains(['?', '#']) {
            return Err("Параметры и фрагменты файловых ссылок не поддерживаются".to_owned());
        }
        let relative = relative_path(uri)?;
        let header = session_header(&session()?)?;
        let cwd = Path::new(
            header
                .cwd
                .as_deref()
                .filter(|cwd| !cwd.is_empty())
                .ok_or("В заголовке сессии отсутствует рабочая папка")?,
        );
        if !cwd.is_absolute() {
            return Err("Рабочая папка сессии должна быть абсолютным путём".to_owned());
        }
        let root = canonical(cwd)?;
        contained(&root.join(relative), &root)?
    };
    if target.to_string_lossy().starts_with("\\\\") || target.to_string_lossy().starts_with("//") {
        return Err("Сетевые файловые ссылки не поддерживаются".to_owned());
    }
    if target.is_dir() {
        return Ok(ContentTarget::Open(target));
    }
    if !target.is_file() {
        return Err("Ссылка не указывает на обычный файл или папку".to_owned());
    }
    if request.action == ContentLinkAction::Reveal || !opens_as_document(&target)? {
        Ok(ContentTarget::Reveal(target))
    } else {
        Ok(ContentTarget::Open(target))
    }
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
                ContentTarget::Open(path) => app
                    .opener()
                    .open_path(path.to_string_lossy(), None::<&str>)
                    .map_err(|_| {
                        "Системное приложение не смогло открыть файл или папку".to_owned()
                    }),
                ContentTarget::Reveal(path) => app
                    .opener()
                    .reveal_item_in_dir(&path)
                    .or_else(|error| match path.parent() {
                        Some(parent) => app
                            .opener()
                            .open_path(parent.to_string_lossy(), None::<&str>),
                        None => Err(error),
                    })
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
                    action: ContentLinkAction::Open,
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
        ] {
            assert_eq!(fixture.resolve(uri).unwrap(), ContentTarget::Open(canonical(path).unwrap()));
        }
        let url = Url::from_file_path(&script).unwrap();
        assert_eq!(
            fixture.resolve(url.as_str()).unwrap(),
            ContentTarget::Reveal(canonical(&script).unwrap())
        );
        assert_eq!(
            fixture.resolve("не%20запускать.cmd").unwrap(),
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
            "local://doc.md%3Asecret",
            "local://doc.md:secret",
            "local://doc.md:0",
            "local://doc.md:8-2",
            "local://doc.md?query=1",
            "local://%5c%5cserver/share",
            "file:///tmp/file.txt%3Asecret",
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
                action: ContentLinkAction::Open,
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
                        action: ContentLinkAction::Open,
                    },
                    Path::new("missing-session-root")
                )
                .unwrap(),
                ContentTarget::External(uri.to_owned())
            );
        }
    }

    #[test]
    fn resolves_project_documents_after_runtime_fixed_width_title_slot() {
        let fixture = Fixture::new();
        let header = fs::read_to_string(&fixture.session).unwrap();
        let mut slot = serde_json::json!({
            "type": "title", "v": 1, "title": "Синтетический заголовок", "source": "user",
            "updatedAt": "2026-09-13T00:00:00Z", "pad": "",
        });
        slot["pad"] = " ".repeat(256 - slot.to_string().len() - 1).into();
        fs::write(
            &fixture.session,
            format!("{slot}\n{header}not a chat record\n"),
        )
        .unwrap();
        let document = fixture.project.join("Отчёт за день.md");
        fs::write(&document, "synthetic document").unwrap();
        for uri in [
            "Отчёт%20за%20день.md",
            "Отчёт%20за%20день.md:raw:2-4",
            "Отчёт%20за%20день.md:5-16,960-973",
        ] {
            assert_eq!(
                fixture.resolve(uri).unwrap(),
                ContentTarget::Open(canonical(&document).unwrap())
            );
        }
        // Invalid metadata must not be treated as an absent optional title slot.
        slot["v"] = 2.into();
        fs::write(&fixture.session, format!("{slot}\n{header}")).unwrap();
        assert!(fixture.resolve("Отчёт%20за%20день.md").is_err());
        fs::write(
            &fixture.session,
            "{\"type\":\"session\",\"id\":\"fixture\"}\n",
        )
        .unwrap();
        assert!(fixture.resolve("Отчёт%20за%20день.md").is_err());
    }

    #[test]
    fn independent_paths_do_not_parse_unrelated_session_metadata() {
        let fixture = Fixture::new();
        fs::write(&fixture.session, "invalid metadata\n").unwrap();
        let sidecar = fixture.session.with_extension("");
        let artifact = sidecar.join("7.bash.log");
        let local = sidecar.join("local/документ.md");
        fs::write(&artifact, "synthetic output").unwrap();
        fs::write(&local, "synthetic document").unwrap();
        assert_eq!(
            fixture.resolve("artifact://7:raw:1-3").unwrap(),
            ContentTarget::Open(canonical(&artifact).unwrap())
        );
        // This fixture has a short path on Windows, so local derives only from the sidecar.
        assert_eq!(
            fixture.resolve("local://документ.md:raw").unwrap(),
            ContentTarget::Open(canonical(&local).unwrap())
        );
        assert_eq!(
            fixture.resolve("local:///документ.md:raw").unwrap(),
            ContentTarget::Open(canonical(&local).unwrap())
        );
        let request = OpenContentLinkRequest {
            uri: Url::from_file_path(&local).unwrap().to_string(),
            session_path: None,
            action: ContentLinkAction::Open,
        };
        assert_eq!(
            resolve_content_link(&request, Path::new("missing-root")).unwrap(),
            ContentTarget::Open(canonical(&local).unwrap())
        );
        assert!(fixture.resolve("project.md").is_err());
    }

    #[test]
    fn explicit_reveal_and_programs_never_use_document_associations() {
        let fixture = Fixture::new();
        let document = fixture.project.join("document.md");
        fs::write(&document, "synthetic document").unwrap();
        let request = OpenContentLinkRequest {
            uri: "document.md".to_owned(),
            session_path: Some(fixture.session.to_string_lossy().into_owned()),
            action: ContentLinkAction::Reveal,
        };
        assert_eq!(
            resolve_content_link(&request, &fixture.sessions).unwrap(),
            ContentTarget::Reveal(canonical(&document).unwrap())
        );
        for (name, body) in [
            ("run.exe", "program"),
            ("run.desktop", "[Desktop Entry]"),
            ("run.py", "print('never')"),
            ("disguised.md", "#!/bin/sh\nexit 1"),
            ("binary.txt", "MZfake"),
        ] {
            let path = fixture.project.join(name);
            fs::write(&path, body).unwrap();
            assert_eq!(
                fixture.resolve(name).unwrap(),
                ContentTarget::Reveal(canonical(&path).unwrap())
            );
        }
        let folder = fixture.project.join("folder");
        fs::create_dir(&folder).unwrap();
        assert_eq!(
            fixture.resolve("folder/").unwrap(),
            ContentTarget::Open(canonical(&folder).unwrap())
        );
        assert_eq!(
            resolve_content_link(
                &OpenContentLinkRequest {
                    uri: "folder/".to_owned(),
                    ..request
                },
                &fixture.sessions
            )
            .unwrap(),
            ContentTarget::Open(canonical(&folder).unwrap())
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_long_local_root_uses_header_id_not_session_filename() {
        let fixture = Fixture::new();
        let nested = fixture.sessions.join("nested-".repeat(15));
        fs::create_dir(&nested).unwrap();
        let session = nested.join(format!("{}.jsonl", "long-".repeat(8)));
        let id = format!(
            "omp-links-short-{}",
            fixture.directory.file_name().unwrap().to_string_lossy()
        );
        let root = std::env::temp_dir().join("omp-local").join(&id);
        fs::create_dir_all(&root).unwrap();
        let document = root.join("report.md");
        fs::write(&document, "synthetic document").unwrap();
        fs::write(&session, format!("{{\"type\":\"title\",\"v\":1,\"title\":\"\",\"updatedAt\":\"\",\"pad\":\"\"}}\n{}\n", serde_json::json!({"type":"session", "id":id}))).unwrap();
        let result = resolve_content_link(
            &OpenContentLinkRequest {
                uri: "local://report.md".to_owned(),
                session_path: Some(session.to_string_lossy().into_owned()),
                action: ContentLinkAction::Open,
            },
            &fixture.sessions,
        );
        let expected = canonical(&document).unwrap();
        fs::remove_dir_all(&root).unwrap();
        assert_eq!(result.unwrap(), ContentTarget::Open(expected));
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
