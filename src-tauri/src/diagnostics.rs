use crate::sessions::{harden_private_directory, harden_private_file};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::SystemTime,
};
use tauri::{AppHandle, Manager};
use time::{Date, OffsetDateTime};
use tracing_appender::non_blocking::WorkerGuard;

const LOG_FILE_PREFIX: &str = "omp-desktop";
const RETAINED_LOG_FILES: usize = 7;

pub struct LogGuard {
    _guard: WorkerGuard,
}

struct PrivateDailyAppender {
    directory: PathBuf,
    day: Date,
    file: fs::File,
}

impl PrivateDailyAppender {
    fn new(directory: PathBuf) -> io::Result<Self> {
        let day = OffsetDateTime::now_utc().date();
        let file = open_private_log_file(&directory, day)?;
        Ok(Self {
            directory,
            day,
            file,
        })
    }

    fn rotate_if_needed(&mut self) -> io::Result<()> {
        let day = OffsetDateTime::now_utc().date();
        if day == self.day {
            return Ok(());
        }
        let next = open_private_log_file(&self.directory, day)?;
        self.file.flush()?;
        self.file.sync_all()?;
        self.file = next;
        self.day = day;
        remove_old_logs(&self.directory);
        Ok(())
    }
}

impl Write for PrivateDailyAppender {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.rotate_if_needed()?;
        self.file.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

fn open_private_log_file(directory: &Path, day: Date) -> io::Result<fs::File> {
    let path = directory.join(format!("{LOG_FILE_PREFIX}.{day}.log"));
    let existed = path.exists();
    if existed {
        harden_private_file(&path)?;
    }
    let mut options = fs::OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&path)?;
    if let Err(error) = harden_private_file(&path) {
        drop(file);
        if !existed {
            let _ = fs::remove_file(&path);
        }
        return Err(error);
    }
    Ok(file)
}

pub fn init(app: &AppHandle) -> Result<LogGuard, String> {
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("не удалось определить каталог логов: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("не удалось создать {}: {error}", directory.display()))?;
    harden_private_directory(&directory).map_err(|error| {
        format!(
            "не удалось ограничить права каталога {}: {error}",
            directory.display()
        )
    })?;
    remove_old_logs(&directory);
    harden_log_files(&directory)?;

    let appender = PrivateDailyAppender::new(directory.clone())
        .map_err(|error| format!("не удалось открыть private log file: {error}"))?;
    let (writer, guard) = tracing_appender::non_blocking(appender);
    tracing_subscriber::fmt()
        .with_writer(writer)
        .with_ansi(false)
        .with_target(true)
        .with_max_level(tracing::Level::INFO)
        .try_init()
        .map_err(|error| format!("не удалось инициализировать tracing: {error}"))?;
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "OMP Desktop started");
    Ok(LogGuard { _guard: guard })
}

pub fn warn(operation: &str, error: &str) {
    tracing::warn!(operation, error = %redact_text(error), "operation failed");
}

pub fn info(operation: &str, message: &str) {
    tracing::info!(operation, message = %redact_text(message));
}

fn harden_log_files(directory: &Path) -> Result<(), String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("не удалось прочитать {}: {error}", directory.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("не удалось прочитать log entry: {error}"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(LOG_FILE_PREFIX) || !name.ends_with(".log") {
            continue;
        }
        harden_private_file(&entry.path()).map_err(|error| {
            format!(
                "не удалось ограничить права файла {}: {error}",
                entry.path().display()
            )
        })?;
    }
    Ok(())
}

fn remove_old_logs(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut logs = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with(LOG_FILE_PREFIX) || !name.ends_with(".log") {
                return None;
            }
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            Some((modified, entry.path()))
        })
        .collect::<Vec<_>>();
    logs.sort_unstable_by_key(|entry| std::cmp::Reverse(entry.0));
    for (_, path) in logs.into_iter().skip(RETAINED_LOG_FILES) {
        let _ = fs::remove_file(path);
    }
}

pub(crate) fn redact_text(value: &str) -> String {
    value
        .lines()
        .map(redact_line)
        .collect::<Vec<_>>()
        .join("\n")
}

fn redact_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    if lower.contains("bearer ") || contains_sensitive_assignment(&lower) {
        return "[REDACTED SENSITIVE LINE]".to_owned();
    }

    line.split_inclusive(char::is_whitespace)
        .map(|token| {
            let trimmed = token.trim_end_matches(char::is_whitespace);
            let suffix = &token[trimmed.len()..];
            if contains_known_secret_token(trimmed) {
                format!("[REDACTED]{suffix}")
            } else {
                token.to_owned()
            }
        })
        .collect()
}

fn contains_sensitive_assignment(lower: &str) -> bool {
    [
        "authorization",
        "api_key",
        "apikey",
        "access_token",
        "refresh_token",
        "password",
        "secret",
        "token",
        "providerenv",
        "provider_env",
    ]
    .iter()
    .any(|marker| {
        lower.match_indices(marker).any(|(index, _)| {
            lower[index + marker.len()..]
                .trim_start_matches(|character: char| {
                    character.is_ascii_whitespace()
                        || matches!(character, '\'' | '"' | '`' | ']' | '}')
                })
                .starts_with([':', '='])
        })
    })
}

fn contains_known_secret_token(token: &str) -> bool {
    [
        "sk-",
        "AIza",
        "ghp_",
        "github_pat_",
        "ya29.",
        "xoxb-",
        "xoxp-",
    ]
    .iter()
    .any(|prefix| {
        token.match_indices(prefix).any(|(index, _)| {
            index == 0
                || token
                    .as_bytes()
                    .get(index.wrapping_sub(1))
                    .is_some_and(|byte| {
                        matches!(byte, b'=' | b':' | b'\'' | b'"' | b'`' | b'(' | b'[' | b'{')
                    })
        })
    })
}

#[cfg(test)]
mod tests {
    use super::{harden_log_files, redact_text, PrivateDailyAppender, LOG_FILE_PREFIX};
    use std::{
        fs,
        io::Write,
        time::{SystemTime, UNIX_EPOCH},
    };
    use time::OffsetDateTime;

    #[test]
    fn redacts_sensitive_assignments_and_known_token_prefixes() {
        let text = concat!(
            "request failed\n",
            "Authorization: Bearer abc\n",
            "upstream sk-test-secret failed\n",
            r#"credentials={"OPENAI_API_KEY":"opaque-value"}"#,
            "\n",
            r#"payload={"providerEnv":{"CUSTOM_CREDENTIAL":"opaque-value"}}"#,
        );
        let redacted = redact_text(text);
        assert!(redacted.contains("request failed"));
        assert!(redacted.contains("[REDACTED SENSITIVE LINE]"));
        assert!(redacted.contains("upstream [REDACTED] failed"));
        assert!(!redacted.contains("abc"));
        assert!(!redacted.contains("sk-test-secret"));
        assert!(!redacted.contains("opaque-value"));
    }

    #[test]
    fn hardens_only_retained_log_files() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-log-permissions-{}-{nonce}",
            std::process::id()
        ));
        let log = root.join("omp-desktop.2026-08-29.log");
        let unrelated = root.join("notes.txt");
        fs::create_dir_all(&root).expect("fixture directory should be writable");
        fs::write(&log, b"log").expect("log fixture should be writable");
        fs::write(&unrelated, b"notes").expect("unrelated fixture should be writable");

        harden_log_files(&root).expect("log hardening should succeed");
        assert_eq!(fs::read(&log).expect("log should remain readable"), b"log");
        assert_eq!(
            fs::read(&unrelated).expect("unrelated file should remain readable"),
            b"notes"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&log)
                    .expect("log metadata should be readable")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        fs::remove_dir_all(root).expect("fixture directory should be removable");
    }

    #[test]
    fn private_appender_protects_log_before_first_write() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-private-log-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("fixture directory should be writable");
        crate::sessions::harden_private_directory(&root)
            .expect("log directory should become private");

        let mut appender = PrivateDailyAppender::new(root.clone())
            .expect("private log appender should initialize");
        appender
            .write_all(b"private log line\n")
            .expect("private log should be writable");
        appender.flush().expect("private log should flush");
        let log = root.join(format!(
            "{LOG_FILE_PREFIX}.{}.log",
            OffsetDateTime::now_utc().date()
        ));
        assert_eq!(
            fs::read(&log).expect("private log should remain readable"),
            b"private log line\n"
        );

        #[cfg(windows)]
        {
            assert_eq!(
                crate::sessions::windows_private_acl_summary(&root)
                    .expect("log directory DACL should be readable"),
                (true, 3, true, true, true)
            );
            assert_eq!(
                crate::sessions::windows_private_acl_summary(&log)
                    .expect("log file DACL should be readable"),
                (true, 3, true, true, true)
            );
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&root)
                    .expect("log directory metadata should be readable")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&log)
                    .expect("log metadata should be readable")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        drop(appender);
        fs::remove_dir_all(root).expect("fixture directory should be removable");
    }
}
