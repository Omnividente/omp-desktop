use std::{fs, path::Path, time::SystemTime};
use tauri::{AppHandle, Manager};
use tracing_appender::{
    non_blocking::WorkerGuard,
    rolling::{RollingFileAppender, Rotation},
};

const LOG_FILE_PREFIX: &str = "omp-desktop";
const RETAINED_LOG_FILES: usize = 7;

pub struct LogGuard {
    _guard: WorkerGuard,
}

pub fn init(app: &AppHandle) -> Result<LogGuard, String> {
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("не удалось определить каталог логов: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("не удалось создать {}: {error}", directory.display()))?;
    remove_old_logs(&directory);

    let appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(LOG_FILE_PREFIX)
        .filename_suffix("log")
        .build(&directory)
        .map_err(|error| format!("не удалось открыть файл лога: {error}"))?;
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

fn redact_text(value: &str) -> String {
    value
        .lines()
        .map(redact_line)
        .collect::<Vec<_>>()
        .join("\n")
}

fn redact_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    if [
        "authorization:",
        "authorization=",
        "bearer ",
        "api_key=",
        "apikey=",
        "access_token=",
        "refresh_token=",
        "password=",
        "secret=",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return "[REDACTED SENSITIVE LINE]".to_owned();
    }

    line.split_inclusive(char::is_whitespace)
        .map(|token| {
            let trimmed = token.trim_end_matches(char::is_whitespace);
            let suffix = &token[trimmed.len()..];
            if looks_like_secret_token(trimmed) {
                format!("[REDACTED]{suffix}")
            } else {
                token.to_owned()
            }
        })
        .collect()
}

fn looks_like_secret_token(token: &str) -> bool {
    let token = token.trim_matches(['\'', '"', '`', '(', ')', '[', ']', '{', '}', ',', ';']);
    token.starts_with("sk-")
        || token.starts_with("AIza")
        || token.starts_with("ghp_")
        || token.starts_with("github_pat_")
        || token.starts_with("ya29.")
        || token.starts_with("xoxb-")
        || token.starts_with("xoxp-")
}

#[cfg(test)]
mod tests {
    use super::redact_text;

    #[test]
    fn redacts_sensitive_assignments_and_known_token_prefixes() {
        let text = "request failed\nAuthorization: Bearer abc\nupstream sk-test-secret failed";
        let redacted = redact_text(text);
        assert!(redacted.contains("request failed"));
        assert!(redacted.contains("[REDACTED SENSITIVE LINE]"));
        assert!(redacted.contains("upstream [REDACTED] failed"));
        assert!(!redacted.contains("abc"));
        assert!(!redacted.contains("sk-test-secret"));
    }
}
