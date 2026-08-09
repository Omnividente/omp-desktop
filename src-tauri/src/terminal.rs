use crate::{
    omp_command::GITHUB_AUTH_ENV_KEYS,
    sessions::{apply_session_title_pin, parse_session, path_key},
    settings::{resolve_omp, SettingsState},
    update,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    env, fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Mutex,
    },
    thread,
    time::{Duration, Instant, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

const MAX_PENDING_OUTPUT: usize = 2 * 1024 * 1024;
const PTY_OUTPUT_BATCH_INTERVAL: Duration = Duration::from_millis(5);
const PTY_EXIT_FINALIZE_TIMEOUT: Duration = Duration::from_secs(5);
const PTY_EXIT_TRUNCATION_ERROR: &str =
    "Вывод PTY обрезан: процесс-потомок удерживает консоль после завершения OMP";
const PTY_OUTPUT_BATCH_LIMIT: usize = 64 * 1024;
const PTY_OUTPUT_QUEUE_CAPACITY: usize = 64;
static NEXT_TERMINAL_ID: AtomicU64 = AtomicU64::new(1);
// Deliberate 4 Hz polling: watchers exist only while the PTY is alive, and polling avoids
// platform-specific rename/replacement gaps for OMP's append-only runtime files.
const SESSION_DISCOVERY_INTERVAL: Duration = Duration::from_millis(250);
const RUNTIME_FILE_ANCHOR: usize = 64;
const MAX_RUNTIME_EVENT_LINE: usize = 64 * 1024;
const MAX_RUNTIME_WATERMARK_KEYS: usize = 256;
const THINKING_LEVELS: &[&str] = &[
    "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto",
];
const MAX_SWITCH_INPUT_BUFFER: usize = 64 * 1024;

/// Префикс имени файла breadcrumb, который OMP-агент пишет для привязки terminal_id к сессии.
/// Wire contract (не менять без доказанного стабильного OMP RPC):
///   Файл: <terminal-sessions>/apple-{terminal_id}
///   Содержимое (две строки, без кавычек):
///     <cwd проекта>\n
///     <полный путь к session.jsonl>\n
/// Используется resolve_resume_path / discover_session / cache_resume_path для resume и переключения модели.
const BREADCRUMB_FILE_PREFIX: &str = "apple-";

/// Escape-префикс и суффикс для команды смены модели по приватному протоколу OMP.
/// Текущий wire contract (фиксируем тестами; не менять без доказанного стабильного OMP RPC):
///   ESC p <provider/model> CR
const OMP_MODEL_SWITCH_ESC: &[u8] = b"\x1bp";
const OMP_MODEL_SWITCH_SUFFIX: &[u8] = b"\r";

/// Escape для циклического переключения уровня рассуждений (thinking).
/// Текущий wire: ESC [ Z . Отправляется нужное число раз в цикле.
/// Фиксируем константой и тестами.
const OMP_THINKING_CYCLE_ESC: &[u8] = b"\x1b[Z";
#[derive(Default)]
pub struct TerminalState {
    processes: Mutex<HashMap<String, TerminalProcess>>,
    session_files: Mutex<()>,
}

struct TerminalProcess {
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Option<Box<dyn Write + Send>>,
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
    cwd: String,
    resume_path: Option<String>,
    terminal_sessions_dir: PathBuf,
    breadcrumb_snapshot: HashMap<PathBuf, u128>,
    pending_output: Vec<u8>,
    attached: bool,
    exit_pending: bool,
    exited: bool,
    exit_code: Option<u32>,
    exit_success: bool,
    exit_error: Option<String>,
    thinking: bool,
    restartable: bool,
    switch_pending: bool,
    update_notified: bool,
    update_buffer: Vec<u8>,
    switch_input_buffer: Vec<u8>,
    switch_input_overflow_notified: bool,
}
impl Drop for TerminalProcess {
    fn drop(&mut self) {
        if !self.exited && !self.exit_pending {
            if let Some(killer) = self.killer.as_mut() {
                let _ = killer.kill();
            }
        }
    }
}

impl TerminalState {
    pub fn shutdown_all(&self) {
        let processes = std::mem::take(&mut *lock_processes(self));
        drop(processes);
    }
}

fn lock_processes(
    state: &TerminalState,
) -> std::sync::MutexGuard<'_, HashMap<String, TerminalProcess>> {
    state
        .processes
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_session_files(state: &TerminalState) -> std::sync::MutexGuard<'_, ()> {
    state
        .session_files
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub cwd: String,
    pub resume_path: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchRequest {
    pub terminal_id: String,
    pub model_selector: String,
    pub thinking_level: Option<String>,
    #[serde(default)]
    pub supported_thinking: Vec<String>,
    pub current_model: Option<String>,
    pub current_thinking: Option<String>,
    pub current_thinking_configured: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStarted {
    pub terminal_id: String,
    pub process_id: Option<u32>,
    pub cwd: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRuntime {
    pub terminal_id: String,
    pub model: String,
    pub model_role: Option<String>,
    pub thinking_level: Option<String>,
    pub configured_thinking_level: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachment {
    pub data: String,
    pub exited: bool,
    pub exit_code: Option<u32>,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyOutputEvent {
    terminal_id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExitEvent {
    terminal_id: String,
    exit_code: Option<u32>,
    success: bool,
    error: Option<String>,
    #[serde(skip)]
    output_truncated: bool,
}

struct PtyExitSignal {
    event_sender: mpsc::SyncSender<PtyExitEvent>,
    output_waker: mpsc::SyncSender<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtySessionEvent {
    terminal_id: String,
    session: crate::models::SessionSummary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum PtyRuntimeEventKind {
    Activity,
    RuntimeError,
    ModelChange,
    RetryFallbackApplied,
    ThinkingLevelChange,
    ModelError,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyRuntimeEvent {
    terminal_id: String,
    kind: PtyRuntimeEventKind,
    model: Option<String>,
    model_role: Option<String>,
    thinking_level: Option<String>,
    configured_thinking_level: Option<String>,
    activity: Option<String>,
    error_message: Option<String>,
    fallback_from: Option<String>,
    fallback_to: Option<String>,
    fallback_role: Option<String>,
    resolved_model_is_fallback: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyUpdateEvent {
    terminal_id: String,
}

#[tauri::command]
pub async fn start_terminal(
    request: LaunchRequest,
    app: AppHandle,
) -> Result<TerminalStarted, String> {
    tauri::async_runtime::spawn_blocking(move || start_terminal_blocking(request, app))
        .await
        .map_err(|error| format!("Не удалось дождаться запуска OMP: {error}"))?
}

fn start_terminal_blocking(
    request: LaunchRequest,
    app: AppHandle,
) -> Result<TerminalStarted, String> {
    let terminals = app.state::<TerminalState>();
    let _session_file_guard = lock_session_files(&terminals);
    let cwd = Path::new(&request.cwd);
    if !cwd.is_dir() {
        return Err(format!("Папка проекта не найдена: {}", cwd.display()));
    }
    if let Some(resume_path) = request.resume_path.as_deref() {
        if !Path::new(resume_path).is_file() {
            return Err(format!("Файл сессии не найден: {resume_path}"));
        }
    }

    let settings = app
        .state::<SettingsState>()
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let omp = resolve_omp(&app, &settings);
    if omp.version.is_none() {
        return Err(format!(
            "OMP не найден. Проверьте путь к исполняемому файлу в настройках: {}",
            omp.executable
        ));
    }

    let restartable = request.args.as_ref().is_none_or(Vec::is_empty);
    let args = if restartable {
        initial_agent_args(&request.cwd, request.resume_path.as_deref())
    } else {
        request.args.unwrap_or_default()
    };
    spawn_terminal_process(
        &app,
        &terminals,
        &omp.executable,
        &settings.provider_env,
        request.cwd,
        request.resume_path,
        args,
        PtySize {
            rows: request.rows.clamp(5, 300),
            cols: request.cols.clamp(20, 500),
            pixel_width: 0,
            pixel_height: 0,
        },
        restartable,
    )
}

#[tauri::command]
pub async fn switch_terminal(
    request: SwitchRequest,
    app: AppHandle,
) -> Result<TerminalRuntime, String> {
    tauri::async_runtime::spawn_blocking(move || switch_terminal_blocking(request, app))
        .await
        .map_err(|error| format!("Не удалось дождаться переключения модели: {error}"))?
}

fn switch_terminal_blocking(
    request: SwitchRequest,
    app: AppHandle,
) -> Result<TerminalRuntime, String> {
    validate_switch_request(&request)?;
    let terminals = app.state::<TerminalState>();
    let (known_resume_path, cwd, terminal_sessions_dir, breadcrumb_snapshot) = {
        let processes = lock_processes(&terminals);
        let process = processes
            .get(&request.terminal_id)
            .ok_or_else(|| format!("Терминал не найден: {}", request.terminal_id))?;
        if !process.restartable {
            return Err("Эта служебная вкладка не поддерживает смену модели".to_owned());
        }
        if process.switch_pending {
            return Err("Смена модели уже выполняется".to_owned());
        }
        if process.exited || process.exit_pending {
            return Err("Процесс OMP уже завершён".to_owned());
        }
        (
            process.resume_path.clone(),
            process.cwd.clone(),
            process.terminal_sessions_dir.clone(),
            process.breadcrumb_snapshot.clone(),
        )
    };
    let resume_path = known_resume_path
        .or_else(|| {
            resolve_resume_path(
                &request.terminal_id,
                &cwd,
                &terminal_sessions_dir,
                &breadcrumb_snapshot,
            )
        })
        .ok_or_else(|| "Сессия OMP ещё не готова к переключению".to_owned())?;
    if !Path::new(&resume_path).is_file() {
        return Err(format!("Файл сессии не найден: {resume_path}"));
    }

    let should_spawn_runtime_watcher = {
        let mut processes = lock_processes(&terminals);
        let process = processes
            .get_mut(&request.terminal_id)
            .ok_or_else(|| format!("Терминал не найден: {}", request.terminal_id))?;
        if process.switch_pending {
            return Err("Смена модели уже выполняется".to_owned());
        }
        if process.exited || process.exit_pending {
            return Err("Процесс OMP уже завершён".to_owned());
        }
        let should_spawn = process.resume_path.is_none();
        process.resume_path = Some(resume_path.clone());
        process.switch_pending = true;
        process.switch_input_buffer.clear();
        process.switch_input_overflow_notified = false;
        should_spawn
    };
    if should_spawn_runtime_watcher {
        spawn_runtime_watcher(
            app.clone(),
            request.terminal_id.clone(),
            resume_path.clone(),
        );
    }

    let result = perform_terminal_switch(&request, &resume_path, &terminals);
    let flush_result = finish_switch_input(&request.terminal_id, &terminals);
    match (result, flush_result) {
        (Err(error), _) => Err(error),
        (Ok(runtime), Ok(())) => Ok(runtime),
        (Ok(_), Err(error)) => Err(error),
    }
}

fn finish_switch_input(terminal_id: &str, terminals: &TerminalState) -> Result<(), String> {
    let mut processes = lock_processes(terminals);
    let process = processes
        .get_mut(terminal_id)
        .ok_or_else(|| format!("Терминал не найден: {terminal_id}"))?;
    process.switch_pending = false;
    process.switch_input_overflow_notified = false;
    let buffered = std::mem::take(&mut process.switch_input_buffer);
    if buffered.is_empty() {
        return Ok(());
    }
    let writer = process
        .writer
        .as_mut()
        .ok_or_else(|| "Процесс OMP уже завершён".to_owned())?;
    writer
        .write_all(&buffered)
        .and_then(|()| writer.flush())
        .map_err(|error| format!("Не удалось восстановить ввод после смены модели: {error}"))
}

#[derive(Default)]
struct SessionRuntimeState {
    model: Option<String>,
    model_role: Option<String>,
    thinking_level: Option<String>,
    configured_thinking_level: Option<String>,
}

impl SessionRuntimeState {
    fn from_request(request: &SwitchRequest) -> Self {
        Self {
            model: request.current_model.clone(),
            model_role: None,
            thinking_level: request.current_thinking.clone(),
            configured_thinking_level: request.current_thinking_configured.clone(),
        }
    }

    fn apply(&mut self, event: PtyRuntimeEvent) {
        let model_role = if event.kind == PtyRuntimeEventKind::RetryFallbackApplied {
            Some("fallback".to_owned())
        } else {
            event.model_role
        };
        if let Some(model) = event.model {
            self.model = Some(model);
            self.model_role = Some(model_role.unwrap_or_else(|| "default".to_owned()));
        }
        if let Some(thinking_level) = event.thinking_level {
            self.thinking_level = Some(thinking_level);
        }
        if let Some(configured) = event.configured_thinking_level {
            self.configured_thinking_level = Some(configured);
        }
    }
}

struct RuntimeCursor {
    offset: u64,
    line: Vec<u8>,
    line_overflow: bool,
}

impl RuntimeCursor {
    fn at_end(path: &Path) -> Result<Self, String> {
        let offset = fs::metadata(path)
            .map_err(|error| {
                format!(
                    "Не удалось прочитать файл сессии {}: {error}",
                    path.display()
                )
            })?
            .len();
        Ok(Self {
            offset,
            line: Vec::with_capacity(1024),
            line_overflow: false,
        })
    }
}

fn model_switch_input(selector: &str) -> Vec<u8> {
    let mut input = Vec::with_capacity(
        OMP_MODEL_SWITCH_ESC.len() + selector.len() + OMP_MODEL_SWITCH_SUFFIX.len(),
    );
    input.extend_from_slice(OMP_MODEL_SWITCH_ESC);
    input.extend_from_slice(selector.as_bytes());
    input.extend_from_slice(OMP_MODEL_SWITCH_SUFFIX);
    input
}

fn perform_terminal_switch(
    request: &SwitchRequest,
    resume_path: &str,
    terminals: &TerminalState,
) -> Result<TerminalRuntime, String> {
    let path = Path::new(resume_path);
    let mut cursor = RuntimeCursor::at_end(path)?;
    let mut runtime = SessionRuntimeState::from_request(request);
    let model_changed = runtime
        .model
        .as_deref()
        .is_none_or(|model| !model.eq_ignore_ascii_case(&request.model_selector));

    if model_changed {
        let input = model_switch_input(&request.model_selector);
        write_switch_input(&request.terminal_id, &input, terminals)?;
        wait_for_runtime_state(
            &request.terminal_id,
            path,
            &mut cursor,
            &mut runtime,
            |state| {
                state
                    .model
                    .as_deref()
                    .is_some_and(|model| model.eq_ignore_ascii_case(&request.model_selector))
            },
            "OMP не подтвердил смену модели за 5 секунд",
            terminals,
        )?;
        settle_runtime_state(path, &mut cursor, &mut runtime)?;
    }

    if let Some(target) = request.thinking_level.as_deref() {
        apply_thinking_level(
            &request.terminal_id,
            target,
            &request.supported_thinking,
            path,
            &mut cursor,
            &mut runtime,
            terminals,
        )?;
    }

    Ok(TerminalRuntime {
        terminal_id: request.terminal_id.clone(),
        model: runtime
            .model
            .unwrap_or_else(|| request.model_selector.clone()),
        model_role: runtime.model_role,
        thinking_level: runtime
            .thinking_level
            .or_else(|| request.thinking_level.clone()),
        configured_thinking_level: runtime
            .configured_thinking_level
            .or_else(|| request.thinking_level.clone()),
    })
}

fn apply_thinking_level(
    terminal_id: &str,
    target: &str,
    supported: &[String],
    path: &Path,
    cursor: &mut RuntimeCursor,
    runtime: &mut SessionRuntimeState,
    terminals: &TerminalState,
) -> Result<(), String> {
    let levels = thinking_cycle(supported);
    let target_index = levels
        .iter()
        .position(|level| level == target)
        .ok_or_else(|| format!("Модель не поддерживает уровень рассуждений: {target}"))?;
    let current = runtime
        .configured_thinking_level
        .as_deref()
        .or(runtime.thinking_level.as_deref())
        .unwrap_or("off");
    let current = if current == "inherit" { "off" } else { current };
    let current_index = levels
        .iter()
        .position(|level| level == current)
        .ok_or_else(|| format!("Неизвестный текущий уровень рассуждений: {current}"))?;
    let steps = (target_index + levels.len() - current_index) % levels.len();

    for step in 1..=steps {
        let expected = levels[(current_index + step) % levels.len()].clone();
        write_switch_input(terminal_id, OMP_THINKING_CYCLE_ESC, terminals)?;
        wait_for_runtime_state(
            terminal_id,
            path,
            cursor,
            runtime,
            |state| {
                state
                    .configured_thinking_level
                    .as_deref()
                    .or(state.thinking_level.as_deref())
                    == Some(expected.as_str())
            },
            "OMP не подтвердил уровень рассуждений за 5 секунд",
            terminals,
        )?;
    }
    Ok(())
}

fn thinking_cycle(supported: &[String]) -> Vec<String> {
    let mut levels = vec!["off".to_owned(), "auto".to_owned()];
    for level in supported {
        if !levels.contains(level) {
            levels.push(level.clone());
        }
    }
    levels
}

fn wait_for_runtime_state<F>(
    terminal_id: &str,
    path: &Path,
    cursor: &mut RuntimeCursor,
    runtime: &mut SessionRuntimeState,
    ready: F,
    timeout_message: &str,
    terminals: &TerminalState,
) -> Result<(), String>
where
    F: Fn(&SessionRuntimeState) -> bool,
{
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        read_runtime_updates(path, cursor, runtime)?;
        if ready(runtime) {
            return Ok(());
        }
        ensure_terminal_alive(terminal_id, terminals)?;
        if Instant::now() >= deadline {
            return Err(timeout_message.to_owned());
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn settle_runtime_state(
    path: &Path,
    cursor: &mut RuntimeCursor,
    runtime: &mut SessionRuntimeState,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_millis(500);
    let mut quiet_until = Instant::now() + Duration::from_millis(100);
    loop {
        if read_runtime_updates(path, cursor, runtime)? {
            quiet_until = Instant::now() + Duration::from_millis(100);
        }
        let now = Instant::now();
        if now >= quiet_until || now >= deadline {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn read_runtime_updates(
    path: &Path,
    cursor: &mut RuntimeCursor,
    runtime: &mut SessionRuntimeState,
) -> Result<bool, String> {
    let length = fs::metadata(path)
        .map_err(|error| {
            format!(
                "Не удалось прочитать файл сессии {}: {error}",
                path.display()
            )
        })?
        .len();
    if length < cursor.offset {
        return Err("Файл сессии был перезаписан во время смены модели".to_owned());
    }
    if length == cursor.offset {
        return Ok(false);
    }

    let mut file = fs::File::open(path)
        .map_err(|error| format!("Не удалось открыть файл сессии {}: {error}", path.display()))?;
    file.seek(SeekFrom::Start(cursor.offset)).map_err(|error| {
        format!(
            "Не удалось перейти по файлу сессии {}: {error}",
            path.display()
        )
    })?;
    let mut changed = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            format!(
                "Не удалось прочитать файл сессии {}: {error}",
                path.display()
            )
        })?;
        if read == 0 {
            break;
        }
        cursor.offset = cursor.offset.saturating_add(read as u64);
        feed_runtime_lines(
            &buffer[..read],
            &mut cursor.line,
            &mut cursor.line_overflow,
            |line| {
                if let Some(event) = runtime_event_from_line("", line) {
                    runtime.apply(event);
                    changed = true;
                }
            },
        );
    }
    Ok(changed)
}

fn write_switch_input(
    terminal_id: &str,
    data: &[u8],
    terminals: &TerminalState,
) -> Result<(), String> {
    let mut processes = lock_processes(terminals);
    let process = processes
        .get_mut(terminal_id)
        .ok_or_else(|| format!("Терминал не найден: {terminal_id}"))?;
    if process.exited || process.exit_pending {
        return Err("Процесс OMP уже завершён".to_owned());
    }
    let writer = process
        .writer
        .as_mut()
        .ok_or_else(|| "Процесс OMP уже завершён".to_owned())?;
    writer
        .write_all(data)
        .and_then(|()| writer.flush())
        .map_err(|error| format!("Не удалось отправить команду смены модели в OMP: {error}"))
}

fn ensure_terminal_alive(terminal_id: &str, terminals: &TerminalState) -> Result<(), String> {
    let processes = lock_processes(terminals);
    let process = processes
        .get(terminal_id)
        .ok_or_else(|| format!("Терминал не найден: {terminal_id}"))?;
    if process.exited || process.exit_pending {
        Err("Процесс OMP завершился во время смены модели".to_owned())
    } else {
        Ok(())
    }
}

fn validate_switch_request(request: &SwitchRequest) -> Result<(), String> {
    let selector = request.model_selector.as_str();
    let Some((provider, model)) = selector.split_once('/') else {
        return Err("Selector модели должен иметь формат provider/model".to_owned());
    };
    if provider.is_empty()
        || model.is_empty()
        || selector
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err("Некорректный selector модели".to_owned());
    }
    if request
        .supported_thinking
        .iter()
        .any(|level| !THINKING_LEVELS.contains(&level.as_str()))
    {
        return Err("Модель содержит неизвестный уровень рассуждений".to_owned());
    }
    if let Some(level) = request.thinking_level.as_deref() {
        if !request
            .supported_thinking
            .iter()
            .any(|candidate| candidate == level)
        {
            return Err(format!(
                "Модель не поддерживает уровень рассуждений: {level}"
            ));
        }
    }
    Ok(())
}

fn initial_agent_args(cwd: &str, resume_path: Option<&str>) -> Vec<String> {
    let mut args = vec!["--cwd".to_owned(), cwd.to_owned()];
    if let Some(resume_path) = resume_path {
        args.push("--resume".to_owned());
        args.push(resume_path.to_owned());
    }
    args
}

fn build_omp_command(
    executable: &str,
    cwd: &str,
    terminal_id: &str,
    provider_env: &HashMap<String, String>,
    args: &[String],
) -> CommandBuilder {
    let mut command = CommandBuilder::new(executable);
    command.cwd(Path::new(cwd));
    for arg in args {
        command.arg(arg);
    }
    for (key, value) in provider_env {
        command.env(key, value);
    }
    if args.first().is_some_and(|arg| arg == "update") {
        for key in GITHUB_AUTH_ENV_KEYS {
            command.env_remove(key);
        }
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "OMP Desktop");
    command.env("TERM_SESSION_ID", terminal_id);
    command
}

#[allow(clippy::too_many_arguments)]
fn spawn_terminal_process(
    app: &AppHandle,
    terminals: &TerminalState,
    executable: &str,
    provider_env: &HashMap<String, String>,
    cwd: String,
    resume_path: Option<String>,
    args: Vec<String>,
    size: PtySize,
    restartable: bool,
) -> Result<TerminalStarted, String> {
    let terminal_id = format!(
        "terminal-{}-{}",
        std::process::id(),
        NEXT_TERMINAL_ID.fetch_add(1, Ordering::Relaxed)
    );
    let terminal_sessions_dir = terminal_sessions_dir(app)?;
    let breadcrumb_snapshot = snapshot_breadcrumbs(&terminal_sessions_dir);
    let command = build_omp_command(executable, &cwd, &terminal_id, provider_env, &args);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|error| format!("Не удалось создать PTY: {error}"))?;
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Не удалось запустить OMP: {error}"))?;
    let process_id = child.process_id();
    let killer = child.clone_killer();
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            return Err(format!("Не удалось подключить вывод PTY: {error}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            return Err(format!("Не удалось подключить ввод PTY: {error}"));
        }
    };
    drop(pair.slave);

    let runtime_session_path = resume_path.clone();

    let process = TerminalProcess {
        master: Some(pair.master),
        writer: Some(writer),
        killer: Some(killer),
        cwd: cwd.clone(),
        resume_path,
        terminal_sessions_dir,
        breadcrumb_snapshot,
        pending_output: Vec::new(),
        attached: false,
        exit_pending: false,
        exited: false,
        exit_code: None,
        exit_success: false,
        exit_error: None,
        thinking: false,
        restartable,
        switch_pending: false,
        update_notified: false,
        update_buffer: Vec::new(),
        switch_input_buffer: Vec::new(),
        switch_input_overflow_notified: false,
    };
    lock_processes(terminals).insert(terminal_id.clone(), process);
    let output_exit = match spawn_reader(app.clone(), terminal_id.clone(), reader) {
        Ok(output_exit) => output_exit,
        Err(error) => {
            drop(lock_processes(terminals).remove(&terminal_id));
            return Err(error);
        }
    };
    if let Err(error) = spawn_waiter(app.clone(), terminal_id.clone(), output_exit, move || {
        child.wait()
    }) {
        drop(lock_processes(terminals).remove(&terminal_id));
        return Err(error);
    }
    if restartable {
        if let Some(session_path) = runtime_session_path {
            spawn_runtime_watcher(app.clone(), terminal_id.clone(), session_path);
        } else {
            spawn_session_watcher(app.clone(), terminal_id.clone());
        }
    }

    Ok(TerminalStarted {
        terminal_id,
        process_id,
        cwd,
    })
}

fn terminal_sessions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = env::var_os("PI_CODING_AGENT_DIR") {
        return Ok(PathBuf::from(root).join("terminal-sessions"));
    }
    app.path()
        .home_dir()
        .map(|home| home.join(".omp").join("agent").join("terminal-sessions"))
        .map_err(|error| format!("Не удалось определить папку terminal-sessions: {error}"))
}

fn snapshot_breadcrumbs(directory: &Path) -> HashMap<PathBuf, u128> {
    let Ok(entries) = fs::read_dir(directory) else {
        return HashMap::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            breadcrumb_modified(&path).map(|modified| (path, modified))
        })
        .collect()
}

fn breadcrumb_modified(path: &Path) -> Option<u128> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_nanos())
}

fn resolve_resume_path(
    terminal_id: &str,
    cwd: &str,
    directory: &Path,
    snapshot: &HashMap<PathBuf, u128>,
) -> Option<String> {
    let direct = directory.join(format!("{BREADCRUMB_FILE_PREFIX}{terminal_id}"));
    if breadcrumb_changed(&direct, snapshot) {
        if let Some(path) = read_breadcrumb(&direct, cwd) {
            return Some(path);
        }
    }

    let entries = fs::read_dir(directory).ok()?;
    let mut matches = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !breadcrumb_changed(&path, snapshot) {
            continue;
        }
        if let Some(session_path) = read_breadcrumb(&path, cwd) {
            if !matches.contains(&session_path) {
                matches.push(session_path);
            }
        }
    }
    (matches.len() == 1).then(|| matches.remove(0))
}

fn breadcrumb_changed(path: &Path, snapshot: &HashMap<PathBuf, u128>) -> bool {
    let Some(current) = breadcrumb_modified(path) else {
        return false;
    };
    snapshot
        .get(path)
        .is_none_or(|previous| current > *previous)
}

fn read_breadcrumb(path: &Path, cwd: &str) -> Option<String> {
    let contents = fs::read_to_string(path).ok()?;
    let mut lines = contents.lines();
    let breadcrumb_cwd = lines.next()?.trim();
    let session_path = lines.next()?.trim();
    if path_key(breadcrumb_cwd) != path_key(cwd) || !Path::new(session_path).is_file() {
        return None;
    }
    Some(session_path.to_owned())
}

fn discover_session(
    terminal_id: &str,
    cwd: &str,
    directory: &Path,
    snapshot: &HashMap<PathBuf, u128>,
) -> Option<(String, crate::models::SessionSummary)> {
    let resume_path = resolve_resume_path(terminal_id, cwd, directory, snapshot)?;
    let session = parse_session(Path::new(&resume_path)).ok().flatten()?;
    Some((resume_path, session))
}

fn cache_resume_path(app: &AppHandle, terminal_id: &str) -> bool {
    let state = app.state::<TerminalState>();
    let context = {
        let processes = lock_processes(&state);
        let Some(process) = processes.get(terminal_id) else {
            return true;
        };
        if !process.restartable
            || process.resume_path.is_some()
            || process.exited
            || process.exit_pending
        {
            return true;
        }
        (
            process.cwd.clone(),
            process.terminal_sessions_dir.clone(),
            process.breadcrumb_snapshot.clone(),
        )
    };
    let Some((resume_path, mut session)) =
        discover_session(terminal_id, &context.0, &context.1, &context.2)
    else {
        return false;
    };

    {
        let settings = app.state::<SettingsState>();
        let settings = settings
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        apply_session_title_pin(&mut session, &settings.session_title_pins);
    }

    {
        let mut processes = lock_processes(&state);
        let Some(process) = processes.get_mut(terminal_id) else {
            return true;
        };
        if !process.restartable
            || process.resume_path.is_some()
            || process.exited
            || process.exit_pending
        {
            return true;
        }
        process.resume_path = Some(resume_path.clone());
    }

    let _ = app.emit(
        "pty-session",
        PtySessionEvent {
            terminal_id: terminal_id.to_owned(),
            session,
        },
    );
    spawn_runtime_watcher(app.clone(), terminal_id.to_owned(), resume_path);

    true
}

fn spawn_session_watcher(app: AppHandle, terminal_id: String) {
    let error_app = app.clone();
    let error_terminal_id = terminal_id.clone();
    if let Err(error) = thread::Builder::new()
        .name(format!("session-watcher-{terminal_id}"))
        .spawn(move || {
            while !cache_resume_path(&app, &terminal_id) {
                thread::sleep(SESSION_DISCOVERY_INTERVAL);
            }
        })
    {
        emit_runtime_error(
            &error_app,
            &error_terminal_id,
            format!("Не удалось запустить наблюдение за сессией: {error}"),
        );
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RuntimeFileIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(not(unix))]
    created_at: Option<u128>,
}

impl RuntimeFileIdentity {
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;

            Self {
                device: metadata.dev(),
                inode: metadata.ino(),
            }
        }
        #[cfg(not(unix))]
        {
            Self {
                created_at: metadata
                    .created()
                    .ok()
                    .and_then(|created| created.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_nanos()),
            }
        }
    }
}

// Rewrites normally retain the last JSONL event, so its id (or exact legacy line) is the
// strongest recovery point. The bounded timestamp watermark is the fallback for disjoint
// rotated segments: current OMP events carry RFC 3339 timestamps and unique top-level ids.
#[derive(Clone, Debug, PartialEq, Eq)]
struct RuntimeLineKey {
    id: Option<String>,
    line_without_id: Option<Vec<u8>>,
}

impl RuntimeLineKey {
    fn from_value_and_line(value: &Value, line: &[u8]) -> Self {
        let id = value.get("id").and_then(Value::as_str).map(str::to_owned);
        Self {
            line_without_id: id.is_none().then(|| line.to_vec()),
            id,
        }
    }

    fn matches(&self, other: &Self) -> bool {
        match (&self.id, &other.id) {
            (Some(left), Some(right)) => left == right,
            (None, None) => self.line_without_id == other.line_without_id,
            _ => false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RuntimeLineCheckpoint {
    key: RuntimeLineKey,
    timestamp_nanos: Option<i128>,
}

#[derive(Clone, Debug, Default)]
struct RuntimeEventWatermark {
    timestamp_nanos: Option<i128>,
    keys: Vec<RuntimeLineKey>,
}

impl RuntimeEventWatermark {
    fn push_key(&mut self, key: RuntimeLineKey) {
        if self.keys.iter().any(|existing| existing.matches(&key)) {
            return;
        }
        if self.keys.len() >= MAX_RUNTIME_WATERMARK_KEYS {
            self.keys.remove(0);
        }
        self.keys.push(key);
    }

    fn observe(&mut self, checkpoint: &RuntimeLineCheckpoint) {
        let Some(timestamp) = checkpoint.timestamp_nanos else {
            return;
        };
        match self.timestamp_nanos {
            None => {
                self.timestamp_nanos = Some(timestamp);
                self.keys.push(checkpoint.key.clone());
            }
            Some(current) if timestamp > current => {
                self.timestamp_nanos = Some(timestamp);
                self.keys.clear();
                self.keys.push(checkpoint.key.clone());
            }
            Some(current) if timestamp == current => {
                self.push_key(checkpoint.key.clone());
            }
            Some(_) => {}
        }
    }

    fn is_unseen_after(&self, checkpoint: &RuntimeLineCheckpoint) -> bool {
        let (Some(current), Some(candidate)) = (self.timestamp_nanos, checkpoint.timestamp_nanos)
        else {
            return false;
        };
        candidate > current
            || (candidate == current && !self.keys.iter().any(|key| key.matches(&checkpoint.key)))
    }

    fn merge(&mut self, other: &Self) {
        let Some(other_timestamp) = other.timestamp_nanos else {
            return;
        };
        match self.timestamp_nanos {
            None => *self = other.clone(),
            Some(current) if other_timestamp > current => *self = other.clone(),
            Some(current) if other_timestamp == current => {
                for key in &other.keys {
                    self.push_key(key.clone());
                }
            }
            Some(_) => {}
        }
    }
}

#[derive(Default)]
struct RuntimeWatchCursor {
    offset: u64,
    identity: Option<RuntimeFileIdentity>,
    anchor: Vec<u8>,
    line: Vec<u8>,
    line_overflow: bool,
    checkpoint: Option<RuntimeLineCheckpoint>,
    watermark: RuntimeEventWatermark,
}

impl RuntimeWatchCursor {
    fn at_end(path: &Path) -> Self {
        let mut checkpoint = None;
        let mut watermark = RuntimeEventWatermark::default();
        let length = scan_runtime_file(path, |_, _, line| {
            observe_runtime_line(&mut checkpoint, &mut watermark, line);
        })
        .or_else(|| fs::metadata(path).ok().map(|metadata| metadata.len()))
        .unwrap_or(0);
        let mut cursor = Self::at_offset(path, length);
        cursor.checkpoint = checkpoint;
        cursor.watermark = watermark;
        cursor
    }

    fn at_offset(path: &Path, offset: u64) -> Self {
        let mut cursor = Self {
            line: Vec::with_capacity(1024),
            anchor: Vec::with_capacity(RUNTIME_FILE_ANCHOR),
            ..Self::default()
        };
        let Ok(mut file) = fs::File::open(path) else {
            return cursor;
        };
        let Ok(metadata) = file.metadata() else {
            return cursor;
        };
        cursor.identity = Some(RuntimeFileIdentity::from_metadata(&metadata));
        cursor.offset = offset.min(metadata.len());
        let anchor_start = cursor.offset.saturating_sub(RUNTIME_FILE_ANCHOR as u64);
        let anchor_length = (cursor.offset - anchor_start) as usize;
        if anchor_length > 0 && file.seek(SeekFrom::Start(anchor_start)).is_ok() && {
            cursor.anchor.resize(anchor_length, 0);
            file.read_exact(&mut cursor.anchor).is_ok()
        } {
            return cursor;
        }
        cursor.anchor.clear();
        cursor
    }

    fn anchor_matches(&self, file: &mut fs::File) -> bool {
        if self.anchor.is_empty() {
            return true;
        }
        let Ok(anchor_length) = u64::try_from(self.anchor.len()) else {
            return false;
        };
        let Some(anchor_start) = self.offset.checked_sub(anchor_length) else {
            return false;
        };
        if file.seek(SeekFrom::Start(anchor_start)).is_err() {
            return false;
        }
        let mut actual = [0_u8; RUNTIME_FILE_ANCHOR];
        file.read_exact(&mut actual[..self.anchor.len()]).is_ok()
            && actual[..self.anchor.len()] == self.anchor
    }

    fn record_anchor(&mut self, data: &[u8]) {
        if data.len() >= RUNTIME_FILE_ANCHOR {
            self.anchor.clear();
            self.anchor
                .extend_from_slice(&data[data.len() - RUNTIME_FILE_ANCHOR..]);
            return;
        }
        let overflow = self
            .anchor
            .len()
            .saturating_add(data.len())
            .saturating_sub(RUNTIME_FILE_ANCHOR);
        if overflow > 0 {
            self.anchor.drain(..overflow);
        }
        self.anchor.extend_from_slice(data);
    }
}

fn runtime_line_checkpoint(line: &[u8]) -> Option<RuntimeLineCheckpoint> {
    let value = serde_json::from_slice::<Value>(line).ok()?;
    let timestamp_nanos = value
        .get("timestamp")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/message/timestamp").and_then(Value::as_str))
        .and_then(|timestamp| OffsetDateTime::parse(timestamp, &Rfc3339).ok())
        .map(OffsetDateTime::unix_timestamp_nanos);
    Some(RuntimeLineCheckpoint {
        key: RuntimeLineKey::from_value_and_line(&value, line),
        timestamp_nanos,
    })
}

fn observe_runtime_line(
    checkpoint: &mut Option<RuntimeLineCheckpoint>,
    watermark: &mut RuntimeEventWatermark,
    line: &[u8],
) {
    let Some(next) = runtime_line_checkpoint(line) else {
        return;
    };
    watermark.observe(&next);
    *checkpoint = Some(next);
}

fn scan_runtime_file<F>(path: &Path, mut on_line: F) -> Option<u64>
where
    F: FnMut(u64, u64, &[u8]),
{
    let mut file = fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let mut remaining = length;
    let mut absolute = 0_u64;
    let mut line_start = 0_u64;
    let mut line = Vec::with_capacity(1024);
    let mut line_overflow = false;
    let mut buffer = [0_u8; 8192];
    while remaining > 0 {
        let chunk = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
        let read = file.read(&mut buffer[..chunk]).ok()?;
        if read == 0 {
            break;
        }
        remaining = remaining.saturating_sub(read as u64);
        for byte in &buffer[..read] {
            absolute = absolute.saturating_add(1);
            if *byte == b'\n' {
                if !line_overflow {
                    on_line(line_start, absolute, &line);
                }
                line.clear();
                line_overflow = false;
                line_start = absolute;
            } else if !line_overflow {
                if line.len() < MAX_RUNTIME_EVENT_LINE {
                    line.push(*byte);
                } else {
                    line.clear();
                    line_overflow = true;
                }
            }
        }
    }
    if !line_overflow && !line.is_empty() && serde_json::from_slice::<Value>(&line).is_ok() {
        on_line(line_start, absolute, &line);
    }
    Some(absolute)
}

fn recover_runtime_cursor(path: &Path, cursor: &mut RuntimeWatchCursor) {
    let previous_checkpoint = cursor.checkpoint.clone();
    let previous_watermark = cursor.watermark.clone();
    // Resume after the exact prior checkpoint when possible. If compaction removed it, accept
    // only timestamped events not present at the previous high-water mark; older history becomes
    // the new baseline instead of being replayed as fresh incidents.
    let mut matching_checkpoint_end = None;
    let mut first_unseen_start = None;
    let mut baseline_checkpoint = None;
    let mut baseline_watermark = RuntimeEventWatermark::default();
    let Some(length) = scan_runtime_file(path, |start, end, line| {
        let Some(candidate) = runtime_line_checkpoint(line) else {
            return;
        };
        if previous_checkpoint
            .as_ref()
            .is_some_and(|checkpoint| checkpoint.key.matches(&candidate.key))
        {
            matching_checkpoint_end = Some(end);
        }
        if first_unseen_start.is_none() && previous_watermark.is_unseen_after(&candidate) {
            first_unseen_start = Some(start);
        }
        baseline_watermark.observe(&candidate);
        baseline_checkpoint = Some(candidate);
    }) else {
        return;
    };

    let resume_offset = matching_checkpoint_end
        .or(first_unseen_start)
        .unwrap_or(length);
    let has_unseen_tail = resume_offset < length;
    let mut next = RuntimeWatchCursor::at_offset(path, resume_offset);
    if has_unseen_tail {
        next.checkpoint = previous_checkpoint;
        next.watermark = previous_watermark;
    } else {
        next.checkpoint = baseline_checkpoint.or(previous_checkpoint);
        next.watermark = previous_watermark;
        next.watermark.merge(&baseline_watermark);
    }
    *cursor = next;
}

fn read_runtime_tail<F>(
    file: &mut fs::File,
    length: u64,
    cursor: &mut RuntimeWatchCursor,
    on_line: &mut F,
) where
    F: FnMut(&[u8]),
{
    if length <= cursor.offset || file.seek(SeekFrom::Start(cursor.offset)).is_err() {
        return;
    }
    let mut remaining = length - cursor.offset;
    let mut buffer = [0_u8; 8192];
    while remaining > 0 {
        let chunk = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
        let Ok(read) = file.read(&mut buffer[..chunk]) else {
            return;
        };
        if read == 0 {
            return;
        }
        let data = &buffer[..read];
        cursor.offset = cursor.offset.saturating_add(read as u64);
        remaining = remaining.saturating_sub(read as u64);
        cursor.record_anchor(data);
        let RuntimeWatchCursor {
            line,
            line_overflow,
            checkpoint,
            watermark,
            ..
        } = cursor;
        feed_runtime_lines(data, line, line_overflow, |runtime_line| {
            observe_runtime_line(checkpoint, watermark, runtime_line);
            on_line(runtime_line);
        });
    }

    if !cursor.line_overflow
        && !cursor.line.is_empty()
        && serde_json::from_slice::<Value>(&cursor.line).is_ok()
    {
        let mut completed = Vec::with_capacity(cursor.line.capacity());
        std::mem::swap(&mut completed, &mut cursor.line);
        observe_runtime_line(&mut cursor.checkpoint, &mut cursor.watermark, &completed);
        on_line(&completed);
        completed.clear();
        cursor.line = completed;
    }
}

fn poll_runtime_file<F, R>(
    path: &Path,
    cursor: &mut RuntimeWatchCursor,
    mut on_reset: R,
    mut on_line: F,
) where
    F: FnMut(&[u8]),
    R: FnMut(),
{
    let Ok(mut file) = fs::File::open(path) else {
        return;
    };
    let Ok(metadata) = file.metadata() else {
        return;
    };
    let identity = RuntimeFileIdentity::from_metadata(&metadata);
    let length = metadata.len();
    let reset = cursor.identity.is_some_and(|known| known != identity)
        || length < cursor.offset
        || !cursor.anchor_matches(&mut file);
    if reset {
        on_reset();
        recover_runtime_cursor(path, cursor);
        let Ok(mut recovered_file) = fs::File::open(path) else {
            return;
        };
        let Ok(recovered_metadata) = recovered_file.metadata() else {
            return;
        };
        read_runtime_tail(
            &mut recovered_file,
            recovered_metadata.len(),
            cursor,
            &mut on_line,
        );
        return;
    }
    if cursor.identity.is_none() {
        cursor.identity = Some(identity);
    }
    read_runtime_tail(&mut file, length, cursor, &mut on_line);
}

fn runtime_event_for_emit(thinking: &mut bool, event: PtyRuntimeEvent) -> Option<PtyRuntimeEvent> {
    let Some(activity) = event.activity.as_deref() else {
        return Some(event);
    };
    let next_thinking = activity == "thinking";
    let changed = *thinking != next_thinking;
    *thinking = next_thinking;
    if event.kind == PtyRuntimeEventKind::Activity && next_thinking && !changed {
        None
    } else {
        Some(event)
    }
}

fn emit_runtime_event(app: &AppHandle, event: PtyRuntimeEvent) {
    let event = {
        let state = app.state::<TerminalState>();
        let mut processes = lock_processes(&state);
        let Some(process) = processes.get_mut(&event.terminal_id) else {
            return;
        };
        runtime_event_for_emit(&mut process.thinking, event)
    };
    if let Some(event) = event {
        let _ = app.emit("pty-runtime", event);
    }
}

fn emit_runtime_error(app: &AppHandle, terminal_id: &str, message: String) {
    emit_runtime_event(
        app,
        PtyRuntimeEvent {
            terminal_id: terminal_id.to_owned(),
            kind: PtyRuntimeEventKind::RuntimeError,
            model: None,
            model_role: None,
            thinking_level: None,
            configured_thinking_level: None,
            activity: Some("error".to_owned()),
            error_message: Some(message),
            fallback_from: None,
            fallback_to: None,
            fallback_role: None,
            resolved_model_is_fallback: None,
        },
    );
}

fn spawn_runtime_watcher(app: AppHandle, terminal_id: String, session_path: String) {
    let error_app = app.clone();
    let error_terminal_id = terminal_id.clone();
    if let Err(error) = thread::Builder::new()
        .name(format!("runtime-watcher-{terminal_id}"))
        .spawn(move || {
            let path = PathBuf::from(&session_path);
            let mut cursor = RuntimeWatchCursor::at_end(&path);

            loop {
                let active = {
                    let state = app.state::<TerminalState>();
                    let processes = lock_processes(&state);
                    let Some(process) = processes.get(&terminal_id) else {
                        return;
                    };
                    if process.resume_path.as_deref() != Some(session_path.as_str()) {
                        return;
                    }
                    !process.exited && !process.exit_pending
                };
                if !active {
                    return;
                }

                poll_runtime_file(
                    &path,
                    &mut cursor,
                    || {},
                    |runtime_line| {
                        if let Some(event) = runtime_event_from_line(&terminal_id, runtime_line) {
                            emit_runtime_event(&app, event);
                        }
                    },
                );
                thread::sleep(SESSION_DISCOVERY_INTERVAL);
            }
        })
    {
        emit_runtime_error(
            &error_app,
            &error_terminal_id,
            format!("Не удалось запустить наблюдение за состоянием сессии: {error}"),
        );
    }
}

fn feed_runtime_lines<F>(
    mut data: &[u8],
    line: &mut Vec<u8>,
    line_overflow: &mut bool,
    mut on_line: F,
) where
    F: FnMut(&[u8]),
{
    while !data.is_empty() {
        let newline = data.iter().position(|byte| *byte == b'\n');
        let end = newline.unwrap_or(data.len());
        if !*line_overflow {
            if line.len().saturating_add(end) <= MAX_RUNTIME_EVENT_LINE {
                line.extend_from_slice(&data[..end]);
            } else {
                line.clear();
                *line_overflow = true;
            }
        }
        let Some(newline) = newline else {
            return;
        };
        if !*line_overflow {
            on_line(line);
        }
        line.clear();
        *line_overflow = false;
        data = &data[newline + 1..];
    }
}

fn activity_from_value(value: &Value) -> Option<&'static str> {
    match value.get("type").and_then(Value::as_str)? {
        "message" => {
            let message = value.get("message").unwrap_or(value);
            match message.get("role").and_then(Value::as_str) {
                Some("user" | "toolResult" | "tool") => Some("thinking"),
                Some("assistant") => {
                    let stop_reason = message.get("stopReason").and_then(Value::as_str);
                    let retry_recovered = message
                        .pointer("/retryRecovery/status")
                        .and_then(Value::as_str)
                        .is_some_and(|status| status == "recovered");
                    let has_tool_call = message
                        .get("content")
                        .and_then(Value::as_array)
                        .is_some_and(|items| {
                            items.iter().any(|item| {
                                matches!(
                                    item.get("type").and_then(Value::as_str),
                                    Some("toolCall" | "tool_use" | "function_call")
                                )
                            })
                        });
                    let continues_with_tool = stop_reason.is_some_and(|reason| {
                        matches!(reason, "toolUse" | "tool_call" | "function_call")
                    }) || (stop_reason.is_none() && has_tool_call);
                    Some(if stop_reason == Some("error") {
                        if retry_recovered {
                            "thinking"
                        } else {
                            "error"
                        }
                    } else if continues_with_tool {
                        "thinking"
                    } else {
                        "idle"
                    })
                }
                _ => None,
            }
        }
        "custom" => match value.get("customType").and_then(Value::as_str) {
            Some("tool_execution_start") => Some("thinking"),
            Some("tool_execution_end") => Some("thinking"),
            _ => None,
        },
        _ => None,
    }
}

fn strip_thinking_suffix(selector: &str) -> String {
    match selector.rsplit_once(':') {
        Some((base, suffix))
            if THINKING_LEVELS
                .iter()
                .any(|level| suffix.eq_ignore_ascii_case(level)) =>
        {
            base.to_owned()
        }
        _ => selector.to_owned(),
    }
}

fn runtime_error_message(value: &Value) -> Option<String> {
    let message = value.get("message").unwrap_or(value);
    if message.get("role").and_then(Value::as_str) != Some("assistant")
        || message.get("stopReason").and_then(Value::as_str) != Some("error")
        || message
            .pointer("/retryRecovery/status")
            .and_then(Value::as_str)
            .is_some_and(|status| status == "recovered")
    {
        return None;
    }

    message
        .get("errorMessage")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn runtime_event_from_line(terminal_id: &str, line: &[u8]) -> Option<PtyRuntimeEvent> {
    let value = serde_json::from_slice::<Value>(line).ok()?;
    let activity = activity_from_value(&value).map(str::to_owned);
    match value.get("type").and_then(Value::as_str)? {
        "retry_fallback_applied" => {
            let fallback_to = value.get("to").and_then(Value::as_str).map(str::to_owned);
            Some(PtyRuntimeEvent {
                terminal_id: terminal_id.to_owned(),
                kind: PtyRuntimeEventKind::RetryFallbackApplied,
                model: fallback_to.as_deref().map(strip_thinking_suffix),
                model_role: None,
                thinking_level: None,
                configured_thinking_level: None,
                activity: Some("thinking".to_owned()),
                error_message: None,
                fallback_from: value.get("from").and_then(Value::as_str).map(str::to_owned),
                fallback_to,
                fallback_role: value.get("role").and_then(Value::as_str).map(str::to_owned),
                resolved_model_is_fallback: None,
            })
        }
        "model_change" => Some(PtyRuntimeEvent {
            terminal_id: terminal_id.to_owned(),
            kind: PtyRuntimeEventKind::ModelChange,
            model: value
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned),
            model_role: value.get("role").and_then(Value::as_str).map(str::to_owned),
            thinking_level: None,
            configured_thinking_level: None,
            activity: None,
            error_message: None,
            fallback_from: None,
            fallback_to: None,
            fallback_role: None,
            resolved_model_is_fallback: value
                .get("resolvedModelIsFallback")
                .and_then(Value::as_bool),
        }),
        "thinking_level_change" => {
            let thinking_level = value
                .get("thinkingLevel")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let configured_thinking_level = value
                .get("configured")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| thinking_level.clone());
            Some(PtyRuntimeEvent {
                terminal_id: terminal_id.to_owned(),
                kind: PtyRuntimeEventKind::ThinkingLevelChange,
                model: None,
                model_role: None,
                thinking_level,
                configured_thinking_level,
                activity: None,
                error_message: None,
                fallback_from: None,
                fallback_to: None,
                fallback_role: None,
                resolved_model_is_fallback: None,
            })
        }
        "message" | "custom" => {
            let error_message = runtime_error_message(&value);
            activity.map(|activity| PtyRuntimeEvent {
                terminal_id: terminal_id.to_owned(),
                kind: if error_message.is_some() {
                    PtyRuntimeEventKind::ModelError
                } else {
                    PtyRuntimeEventKind::Activity
                },
                model: None,
                model_role: None,
                thinking_level: None,
                configured_thinking_level: None,
                activity: Some(activity),
                error_message,
                fallback_from: None,
                fallback_to: None,
                fallback_role: None,
                resolved_model_is_fallback: None,
            })
        }
        _ => None,
    }
}

#[tauri::command]
pub fn attach_terminal(
    terminal_id: String,
    terminals: State<'_, TerminalState>,
) -> Result<TerminalAttachment, String> {
    let mut processes = lock_processes(&terminals);
    let process = processes
        .get_mut(&terminal_id)
        .ok_or_else(|| format!("Терминал не найден: {terminal_id}"))?;
    process.attached = true;
    let pending = std::mem::take(&mut process.pending_output);

    Ok(TerminalAttachment {
        data: BASE64.encode(pending),
        exited: process.exited,
        exit_code: process.exit_code,
        success: process.exit_success,
        error: process.exit_error.clone(),
    })
}

#[tauri::command]
pub fn write_terminal(
    terminal_id: String,
    data: String,
    terminals: State<'_, TerminalState>,
) -> Result<(), String> {
    write_bytes(&terminal_id, data.as_bytes(), &terminals)
}

#[tauri::command]
pub fn write_terminal_binary(
    terminal_id: String,
    data: String,
    terminals: State<'_, TerminalState>,
) -> Result<(), String> {
    let bytes = decode_terminal_binary(&data)?;
    write_bytes(&terminal_id, &bytes, &terminals)
}

fn decode_terminal_binary(data: &str) -> Result<Vec<u8>, String> {
    BASE64
        .decode(data)
        .map_err(|error| format!("Некорректный base64 бинарного ввода PTY: {error}"))
}

#[tauri::command]
pub fn resize_terminal(
    terminal_id: String,
    cols: u16,
    rows: u16,
    terminals: State<'_, TerminalState>,
) -> Result<(), String> {
    let processes = lock_processes(&terminals);
    let process = processes
        .get(&terminal_id)
        .ok_or_else(|| format!("Терминал не найден: {terminal_id}"))?;
    let master = process
        .master
        .as_ref()
        .ok_or_else(|| "Процесс OMP уже завершён".to_owned())?;
    master
        .resize(PtySize {
            rows: rows.clamp(5, 300),
            cols: cols.clamp(20, 500),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Не удалось изменить размер терминала: {error}"))
}

#[tauri::command]
pub fn close_terminal(
    terminal_id: String,
    terminals: State<'_, TerminalState>,
) -> Result<(), String> {
    let process = lock_processes(&terminals).remove(&terminal_id);
    drop(process);
    Ok(())
}

fn append_switch_input(
    buffer: &mut Vec<u8>,
    overflow_notified: &mut bool,
    data: &[u8],
) -> Result<(), String> {
    let available = MAX_SWITCH_INPUT_BUFFER.saturating_sub(buffer.len());
    buffer.extend_from_slice(&data[..data.len().min(available)]);
    if data.len() > available && !*overflow_notified {
        *overflow_notified = true;
        return Err(format!(
            "Буфер ввода во время смены модели заполнен ({} KiB)",
            MAX_SWITCH_INPUT_BUFFER / 1024
        ));
    }
    Ok(())
}

fn write_bytes(terminal_id: &str, data: &[u8], terminals: &TerminalState) -> Result<(), String> {
    let mut processes = lock_processes(terminals);
    let process = processes
        .get_mut(terminal_id)
        .ok_or_else(|| format!("Терминал не найден: {terminal_id}"))?;
    if process.exited || process.exit_pending {
        return Err("Процесс OMP уже завершён".to_owned());
    }
    if process.switch_pending {
        return append_switch_input(
            &mut process.switch_input_buffer,
            &mut process.switch_input_overflow_notified,
            data,
        );
    }
    let writer = process
        .writer
        .as_mut()
        .ok_or_else(|| "Процесс OMP уже завершён".to_owned())?;
    writer
        .write_all(data)
        .and_then(|()| writer.flush())
        .map_err(|error| format!("Не удалось отправить ввод в OMP: {error}"))
}

fn receive_ready_output_batch(receiver: &mpsc::Receiver<Vec<u8>>, mut batch: Vec<u8>) -> Vec<u8> {
    while batch.len() < PTY_OUTPUT_BATCH_LIMIT {
        match receiver.try_recv() {
            Ok(chunk) => batch.extend_from_slice(&chunk),
            Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => break,
        }
    }
    batch
}

fn receive_timed_output_batch(receiver: &mpsc::Receiver<Vec<u8>>, mut batch: Vec<u8>) -> Vec<u8> {
    let deadline = Instant::now() + PTY_OUTPUT_BATCH_INTERVAL;
    while batch.len() < PTY_OUTPUT_BATCH_LIMIT {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match receiver.recv_timeout(remaining) {
            Ok(chunk) => batch.extend_from_slice(&chunk),
            Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    batch
}

enum OutputDrainResult {
    OutputDisconnected,
    Exit(PtyExitEvent),
    ExitDisconnected,
}

fn try_output_exit(receiver: &mpsc::Receiver<PtyExitEvent>) -> Option<OutputDrainResult> {
    match receiver.try_recv() {
        Ok(event) => Some(OutputDrainResult::Exit(event)),
        Err(mpsc::TryRecvError::Empty) => None,
        Err(mpsc::TryRecvError::Disconnected) => Some(OutputDrainResult::ExitDisconnected),
    }
}

fn drain_output_batches<Forward>(
    output_receiver: &mpsc::Receiver<Vec<u8>>,
    exit_receiver: &mpsc::Receiver<PtyExitEvent>,
    mut forward: Forward,
) -> OutputDrainResult
where
    Forward: FnMut(&[u8]),
{
    'idle: loop {
        let first = match output_receiver.recv() {
            Ok(first) => first,
            Err(_) => return OutputDrainResult::OutputDisconnected,
        };
        let batch = receive_ready_output_batch(output_receiver, first);
        if !batch.is_empty() {
            forward(&batch);
        }
        if let Some(result) = try_output_exit(exit_receiver) {
            return result;
        }

        loop {
            let first = match output_receiver.recv_timeout(PTY_OUTPUT_BATCH_INTERVAL) {
                Ok(first) => first,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if let Some(result) = try_output_exit(exit_receiver) {
                        return result;
                    }
                    continue 'idle;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return OutputDrainResult::OutputDisconnected;
                }
            };
            let batch = receive_timed_output_batch(output_receiver, first);
            if !batch.is_empty() {
                forward(&batch);
            }
            if let Some(result) = try_output_exit(exit_receiver) {
                return result;
            }
        }
    }
}

fn drain_output_after_exit<Forward>(
    receiver: &mpsc::Receiver<Vec<u8>>,
    timeout: Duration,
    mut forward: Forward,
) -> bool
where
    Forward: FnMut(&[u8]),
{
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        match receiver.recv_timeout(remaining) {
            Ok(first) => {
                let batch = receive_ready_output_batch(receiver, first);
                if !batch.is_empty() {
                    forward(&batch);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => return false,
            Err(mpsc::RecvTimeoutError::Disconnected) => return true,
        }
    }
}

fn run_output_pipeline<Output, Exit>(
    output_receiver: mpsc::Receiver<Vec<u8>>,
    exit_receiver: mpsc::Receiver<PtyExitEvent>,
    exit_finalize_timeout: Duration,
    mut output: Output,
    mut exit: Exit,
) where
    Output: FnMut(&[u8]),
    Exit: FnMut(PtyExitEvent),
{
    let event = match drain_output_batches(&output_receiver, &exit_receiver, |batch| output(batch))
    {
        OutputDrainResult::OutputDisconnected => match exit_receiver.recv() {
            Ok(event) => event,
            Err(_) => return,
        },
        OutputDrainResult::Exit(mut event) => {
            if !drain_output_after_exit(&output_receiver, exit_finalize_timeout, |batch| {
                output(batch)
            }) {
                event.success = false;
                event.output_truncated = true;
                event.error = Some(match event.error.take() {
                    Some(error) => format!("{error}; {PTY_EXIT_TRUNCATION_ERROR}"),
                    None => PTY_EXIT_TRUNCATION_ERROR.to_owned(),
                });
            }
            event
        }
        OutputDrainResult::ExitDisconnected => return,
    };
    exit(event);
}

fn finalize_terminal_exit(app: &AppHandle, terminal_id: &str, event: PtyExitEvent) {
    let runtime_error = event
        .output_truncated
        .then(|| event.error.clone())
        .flatten();
    let should_emit = {
        let state = app.state::<TerminalState>();
        let mut processes = lock_processes(&state);
        let Some(process) = processes.get_mut(terminal_id) else {
            return;
        };
        if process.exited {
            return;
        }
        process.exit_pending = false;
        process.exited = true;
        process.exit_code = event.exit_code;
        process.exit_success = event.success;
        process.exit_error = event.error.clone();
        process.attached
    };

    if should_emit {
        if let Some(error) = runtime_error {
            emit_runtime_error(app, terminal_id, error);
        }
        let _ = app.emit("pty-exit", event);
    }
}

fn forward_output_batches(
    app: AppHandle,
    terminal_id: String,
    output_receiver: mpsc::Receiver<Vec<u8>>,
    exit_receiver: mpsc::Receiver<PtyExitEvent>,
) {
    run_output_pipeline(
        output_receiver,
        exit_receiver,
        PTY_EXIT_FINALIZE_TIMEOUT,
        |batch| route_output(&app, &terminal_id, batch),
        |event| finalize_terminal_exit(&app, &terminal_id, event),
    );
}

fn spawn_reader(
    app: AppHandle,
    terminal_id: String,
    mut reader: Box<dyn Read + Send>,
) -> Result<PtyExitSignal, String> {
    let (output_sender, output_receiver) = mpsc::sync_channel(PTY_OUTPUT_QUEUE_CAPACITY);
    let output_waker = output_sender.clone();
    let (exit_sender, exit_receiver) = mpsc::sync_channel(1);
    let output_app = app.clone();
    let output_terminal_id = terminal_id.clone();

    thread::Builder::new()
        .name(format!("pty-output-{terminal_id}"))
        .spawn(move || {
            forward_output_batches(
                output_app,
                output_terminal_id,
                output_receiver,
                exit_receiver,
            )
        })
        .map_err(|error| format!("Не удалось запустить поток группировки PTY: {error}"))?;

    thread::Builder::new()
        .name(format!("pty-reader-{terminal_id}"))
        .spawn(move || {
            let mut buffer = [0_u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        if output_sender.send(buffer[..read].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        emit_runtime_error(
                            &app,
                            &terminal_id,
                            format!("Ошибка чтения PTY: {error}"),
                        );
                        break;
                    }
                }
            }
        })
        .map_err(|error| format!("Не удалось запустить поток чтения PTY: {error}"))?;

    Ok(PtyExitSignal {
        event_sender: exit_sender,
        output_waker,
    })
}

fn spawn_waiter<F>(
    app: AppHandle,
    terminal_id: String,
    exit_signal: PtyExitSignal,
    wait: F,
) -> Result<(), String>
where
    F: FnOnce() -> std::io::Result<portable_pty::ExitStatus> + Send + 'static,
{
    thread::Builder::new()
        .name(format!("pty-waiter-{terminal_id}"))
        .spawn(move || {
            let status = wait();
            let wait_failed = status.is_err();
            let event = match status {
                Ok(status) => PtyExitEvent {
                    terminal_id: terminal_id.clone(),
                    exit_code: Some(status.exit_code()),
                    success: status.success(),
                    error: status.signal().map(|signal| format!("Сигнал: {signal}")),
                    output_truncated: false,
                },
                Err(error) => PtyExitEvent {
                    terminal_id: terminal_id.clone(),
                    exit_code: None,
                    success: false,
                    error: Some(error.to_string()),
                    output_truncated: false,
                },
            };

            let (master, writer, mut killer) = {
                let state = app.state::<TerminalState>();
                let mut processes = lock_processes(&state);
                let Some(process) = processes.get_mut(&terminal_id) else {
                    return;
                };
                process.exit_pending = true;
                (
                    process.master.take(),
                    process.writer.take(),
                    process.killer.take(),
                )
            };

            if wait_failed {
                if let Some(killer) = killer.as_mut() {
                    let _ = killer.kill();
                }
            }
            drop(writer);
            drop(master);
            drop(killer);

            let fallback_event = event.clone();
            if let Err(error) = exit_signal.event_sender.send(event) {
                finalize_terminal_exit(&app, &terminal_id, error.0);
                return;
            }
            if exit_signal.output_waker.send(Vec::new()).is_err() {
                finalize_terminal_exit(&app, &terminal_id, fallback_event);
            }
        })
        .map(|_| ())
        .map_err(|error| format!("Не удалось запустить поток ожидания PTY: {error}"))
}

fn output_event_name(terminal_id: &str) -> String {
    format!("pty-output:{terminal_id}")
}

fn route_output(app: &AppHandle, terminal_id: &str, data: &[u8]) {
    cache_resume_path(app, terminal_id);
    let (payload, emit_update) = {
        let state = app.state::<TerminalState>();
        let mut processes = lock_processes(&state);
        let Some(process) = processes.get_mut(terminal_id) else {
            return;
        };

        let emit_update = if !process.update_notified {
            if detect_update_notice(&mut process.update_buffer, data) {
                process.update_notified = true;
                true
            } else {
                false
            }
        } else {
            false
        };

        let payload = if process.attached {
            Some(PtyOutputEvent {
                terminal_id: terminal_id.to_owned(),
                data: BASE64.encode(data),
            })
        } else {
            append_pending(&mut process.pending_output, data);
            None
        };
        (payload, emit_update)
    };

    if let Some(payload) = payload {
        let event_name = output_event_name(terminal_id);
        let _ = app.emit(&event_name, payload);
    }
    if emit_update {
        let _ = app.emit(
            "omp-update-notice",
            PtyUpdateEvent {
                terminal_id: terminal_id.to_owned(),
            },
        );
    }
}

const MAX_UPDATE_BUFFER: usize = 4096;

fn strip_ansi_bytes(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == 0x1b {
            i += 1;
            if i < input.len() && (input[i] == b'[' || input[i] == b'(' || input[i] == b')') {
                i += 1;
                while i < input.len() && !input[i].is_ascii_alphabetic() {
                    i += 1;
                }
                if i < input.len() {
                    i += 1;
                }
            }
        } else {
            out.push(input[i]);
            i += 1;
        }
    }
    out
}

fn detect_update_notice(buffer: &mut Vec<u8>, data: &[u8]) -> bool {
    if data.len() >= MAX_UPDATE_BUFFER {
        buffer.clear();
        buffer.extend_from_slice(&data[data.len() - MAX_UPDATE_BUFFER..]);
    } else {
        let overflow = buffer
            .len()
            .saturating_add(data.len())
            .saturating_sub(MAX_UPDATE_BUFFER);
        if overflow > 0 {
            buffer.drain(..overflow);
        }
        buffer.extend_from_slice(data);
    }

    let clean = strip_ansi_bytes(buffer);
    let text = String::from_utf8_lossy(&clean);
    let lower = text.to_lowercase();
    let advertises_update = [
        "new version",
        "update available",
        "upgrade available",
        "новая версия",
        "доступно обновление",
    ]
    .iter()
    .any(|marker| lower.contains(marker));
    advertises_update && lower.contains("omp update") && update::contains_version(&text)
}

fn append_pending(pending: &mut Vec<u8>, data: &[u8]) {
    if data.len() >= MAX_PENDING_OUTPUT {
        pending.clear();
        pending.extend_from_slice(&data[data.len() - MAX_PENDING_OUTPUT..]);
        return;
    }

    let overflow = pending
        .len()
        .saturating_add(data.len())
        .saturating_sub(MAX_PENDING_OUTPUT);
    if overflow > 0 {
        pending.drain(..overflow);
    }
    pending.extend_from_slice(data);
}

#[cfg(test)]
mod tests {
    use super::{
        append_switch_input, build_omp_command, decode_terminal_binary, discover_session,
        feed_runtime_lines, initial_agent_args, model_switch_input, output_event_name,
        poll_runtime_file, receive_ready_output_batch, receive_timed_output_batch,
        run_output_pipeline, runtime_event_for_emit, runtime_event_from_line, thinking_cycle,
        validate_switch_request, PtyExitEvent, PtyRuntimeEventKind, RuntimeWatchCursor,
        SwitchRequest, MAX_RUNTIME_EVENT_LINE, MAX_SWITCH_INPUT_BUFFER, OMP_THINKING_CYCLE_ESC,
        PTY_EXIT_TRUNCATION_ERROR, PTY_OUTPUT_BATCH_LIMIT,
    };
    use std::{
        cell::RefCell,
        collections::HashMap,
        ffi::OsStr,
        fs,
        io::Write,
        sync::mpsc,
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    fn switch_request() -> SwitchRequest {
        SwitchRequest {
            terminal_id: "terminal-1".to_owned(),
            model_selector: "provider/model".to_owned(),
            thinking_level: Some("max".to_owned()),
            supported_thinking: vec!["low".to_owned(), "xhigh".to_owned(), "max".to_owned()],
            current_model: Some("provider/old".to_owned()),
            current_thinking: Some("xhigh".to_owned()),
            current_thinking_configured: Some("xhigh".to_owned()),
        }
    }

    #[test]
    fn switch_wire_bytes_match_omp_contract() {
        assert_eq!(
            model_switch_input("provider/model"),
            b"\x1bpprovider/model\r"
        );
        assert_eq!(OMP_THINKING_CYCLE_ESC, b"\x1b[Z");
    }

    #[test]
    fn output_leading_batch_preserves_ready_chunk_order() {
        let (sender, receiver) = mpsc::sync_channel(4);
        sender.send(b"-second".to_vec()).expect("second chunk");
        sender.send(b"-third".to_vec()).expect("third chunk");

        assert_eq!(
            receive_ready_output_batch(&receiver, b"first".to_vec()),
            b"first-second-third"
        );
    }

    #[test]
    fn output_timed_batch_flushes_at_size_limit() {
        let (sender, receiver) = mpsc::sync_channel(8);
        let chunk_size = PTY_OUTPUT_BATCH_LIMIT / 8;
        for byte in 1_u8..8 {
            sender
                .send(vec![byte; chunk_size])
                .expect("queued output chunk");
        }

        let batch = receive_timed_output_batch(&receiver, vec![0; chunk_size]);
        assert_eq!(batch.len(), PTY_OUTPUT_BATCH_LIMIT);
        assert_eq!(batch[0], 0);
        assert_eq!(batch[chunk_size], 1);
        assert_eq!(batch[PTY_OUTPUT_BATCH_LIMIT - 1], 7);
    }

    #[test]
    fn output_pipeline_emits_exit_after_queued_output() {
        let (output_sender, output_receiver) = mpsc::sync_channel(4);
        let (exit_sender, exit_receiver) = mpsc::sync_channel(1);
        exit_sender
            .send(PtyExitEvent {
                terminal_id: "terminal-1".to_owned(),
                exit_code: Some(0),
                success: true,
                error: None,
                output_truncated: false,
            })
            .expect("queued exit");
        output_sender.send(b"first".to_vec()).expect("first output");
        output_sender
            .send(b"-second".to_vec())
            .expect("second output");
        drop(output_sender);
        drop(exit_sender);

        let events = RefCell::new(Vec::new());
        run_output_pipeline(
            output_receiver,
            exit_receiver,
            Duration::from_millis(50),
            |batch| {
                events
                    .borrow_mut()
                    .push(format!("output:{}", String::from_utf8_lossy(batch)))
            },
            |event| events.borrow_mut().push(format!("exit:{}", event.success)),
        );

        assert_eq!(
            events.into_inner(),
            vec!["output:first-second", "exit:true"]
        );
    }

    #[test]
    fn output_pipeline_bounds_exit_when_output_stays_connected() {
        let (output_sender, output_receiver) = mpsc::sync_channel(4);
        let (exit_sender, exit_receiver) = mpsc::sync_channel(1);
        let (event_sender, event_receiver) = mpsc::channel();
        exit_sender
            .send(PtyExitEvent {
                terminal_id: "terminal-1".to_owned(),
                exit_code: Some(0),
                success: true,
                error: None,
                output_truncated: false,
            })
            .expect("queued exit");
        output_sender.send(Vec::new()).expect("exit wake-up");

        let pipeline = thread::spawn(move || {
            run_output_pipeline(
                output_receiver,
                exit_receiver,
                Duration::from_millis(20),
                |_| {},
                move |event| event_sender.send(event).expect("forwarded exit"),
            )
        });

        let event = event_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("exit must be bounded when PTY output remains connected");
        pipeline.join().expect("output pipeline");

        assert!(!event.success);
        assert!(event.output_truncated);
        assert_eq!(event.error.as_deref(), Some(PTY_EXIT_TRUNCATION_ERROR));
        assert!(output_sender.send(b"late".to_vec()).is_err());
        drop(exit_sender);
    }

    #[test]
    fn initial_args_always_use_exact_resume_path() {
        assert_eq!(
            initial_agent_args("/tmp/project", Some("/tmp/session.jsonl")),
            vec!["--cwd", "/tmp/project", "--resume", "/tmp/session.jsonl",]
        );
    }

    #[test]
    fn update_pty_drops_github_auth_without_affecting_agent_sessions() {
        let provider_env = HashMap::from([
            ("GITHUB_TOKEN".to_owned(), "stale-token".to_owned()),
            ("GH_TOKEN".to_owned(), "stale-token".to_owned()),
        ]);
        let update = build_omp_command(
            "omp",
            ".",
            "terminal-update",
            &provider_env,
            &["update".to_owned()],
        );
        for key in crate::omp_command::GITHUB_AUTH_ENV_KEYS {
            assert_eq!(update.get_env(key), None);
        }

        let agent = build_omp_command(
            "omp",
            ".",
            "terminal-agent",
            &provider_env,
            &["--cwd".to_owned(), ".".to_owned()],
        );
        for key in crate::omp_command::GITHUB_AUTH_ENV_KEYS {
            assert_eq!(agent.get_env(key), Some(OsStr::new("stale-token")));
        }
    }

    #[test]
    fn binary_transport_decodes_base64_and_scopes_output_event() {
        assert_eq!(
            decode_terminal_binary("AP8Q").expect("base64 should decode"),
            [0, 255, 16]
        );
        assert!(decode_terminal_binary("not base64!").is_err());
        assert_eq!(output_event_name("terminal-7"), "pty-output:terminal-7");
    }

    #[test]
    fn switch_input_buffer_is_bounded_and_reports_overflow_once() {
        let mut buffer = vec![1; MAX_SWITCH_INPUT_BUFFER - 1];
        let mut overflow_notified = false;

        assert!(append_switch_input(&mut buffer, &mut overflow_notified, &[2, 3]).is_err());
        assert_eq!(buffer.len(), MAX_SWITCH_INPUT_BUFFER);
        assert_eq!(buffer.last(), Some(&2));
        assert!(overflow_notified);

        assert!(append_switch_input(&mut buffer, &mut overflow_notified, &[4]).is_ok());
        assert_eq!(buffer.len(), MAX_SWITCH_INPUT_BUFFER);
    }

    #[test]
    fn switch_request_rejects_unsafe_values() {
        assert!(validate_switch_request(&switch_request()).is_ok());

        let mut invalid_model = switch_request();
        invalid_model.model_selector = "provider/model with space".to_owned();
        assert!(validate_switch_request(&invalid_model).is_err());

        let mut unsupported_thinking = switch_request();
        unsupported_thinking.thinking_level = Some("medium".to_owned());
        assert!(validate_switch_request(&unsupported_thinking).is_err());

        let mut invalid_thinking = switch_request();
        invalid_thinking.supported_thinking.push("turbo".to_owned());
        assert!(validate_switch_request(&invalid_thinking).is_err());
    }

    #[test]
    fn retry_fallback_model_strips_only_a_known_final_thinking_suffix() {
        for (selector, expected_model) in [
            ("openai/gpt-5.6:high", "openai/gpt-5.6"),
            ("ollama/llama3.1:8b", "ollama/llama3.1:8b"),
            ("ollama/llama3.1:8b:high", "ollama/llama3.1:8b"),
            ("ollama/llama3.1:8b:HIGH", "ollama/llama3.1:8b"),
            ("ollama/llama3.1:8b:HiGh", "ollama/llama3.1:8b"),
            ("ollama/llama3.1:8b:internal", "ollama/llama3.1:8b:internal"),
        ] {
            let line = serde_json::json!({
                "type": "retry_fallback_applied",
                "from": "provider/primary",
                "to": selector,
                "role": "default",
            })
            .to_string();
            let event = runtime_event_from_line("terminal-1", line.as_bytes())
                .expect("fallback event should parse");

            assert_eq!(event.model.as_deref(), Some(expected_model), "{selector}");
            assert_eq!(event.fallback_to.as_deref(), Some(selector), "{selector}");
        }
    }

    #[test]
    fn runtime_lines_report_model_role_and_configured_thinking() {
        let payload = concat!(
            "{\"type\":\"custom_message\",\"content\":\"ignored\"}\n",
            "{\"type\":\"model_change\",\"model\":\"provider/new\",\"role\":\"fallback\",\"resolvedModelIsFallback\":true}\n",
            "{\"type\":\"retry_fallback_applied\",\"from\":\"provider/primary\",\"to\":\"provider/fallback:high\",\"role\":\"default\"}\n",
            "{\"type\":\"thinking_level_change\",\"thinkingLevel\":\"high\",\"configured\":\"auto\"}\n"
        )
        .as_bytes();
        let split = payload.len() / 2;
        let mut line = Vec::new();
        let mut overflow = false;
        let mut events = Vec::new();

        feed_runtime_lines(&payload[..split], &mut line, &mut overflow, |candidate| {
            if let Some(event) = runtime_event_from_line("terminal-1", candidate) {
                events.push(event);
            }
        });
        feed_runtime_lines(&payload[split..], &mut line, &mut overflow, |candidate| {
            if let Some(event) = runtime_event_from_line("terminal-1", candidate) {
                events.push(event);
            }
        });

        assert_eq!(events.len(), 3);
        assert_eq!(events[0].kind, PtyRuntimeEventKind::ModelChange);
        assert_eq!(events[0].model.as_deref(), Some("provider/new"));
        assert_eq!(events[0].model_role.as_deref(), Some("fallback"));
        assert_eq!(events[0].resolved_model_is_fallback, Some(true));
        assert_eq!(events[1].kind, PtyRuntimeEventKind::RetryFallbackApplied);
        assert_eq!(events[1].model.as_deref(), Some("provider/fallback"));
        assert!(events[1].model_role.is_none());
        assert_eq!(events[1].fallback_from.as_deref(), Some("provider/primary"));
        assert_eq!(
            events[1].fallback_to.as_deref(),
            Some("provider/fallback:high")
        );
        assert_eq!(events[1].fallback_role.as_deref(), Some("default"));
        assert_eq!(events[2].thinking_level.as_deref(), Some("high"));
        assert_eq!(events[2].configured_thinking_level.as_deref(), Some("auto"));
    }

    #[test]
    fn runtime_dispatch_preserves_model_fallback_and_error_payloads() {
        let lines: &[&[u8]] = &[
            br#"{"type":"model_change","model":"provider/new","role":"review","resolvedModelIsFallback":true}"#,
            br#"{"type":"retry_fallback_applied","from":"provider/primary","to":"provider/fallback:high","role":"default"}"#,
            br#"{"type":"message","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"Cloud API error (429):\n  Individual quota reached"}}"#,
        ];
        let mut thinking = true;
        let events = lines
            .iter()
            .filter_map(|line| runtime_event_from_line("terminal-1", line))
            .filter_map(|event| runtime_event_for_emit(&mut thinking, event))
            .collect::<Vec<_>>();

        assert_eq!(events.len(), 3);
        let model = serde_json::to_value(&events[0]).expect("model event should serialize");
        assert_eq!(model["kind"], "modelChange");
        assert_eq!(model["model"], "provider/new");
        assert_eq!(model["modelRole"], "review");
        assert_eq!(model["resolvedModelIsFallback"], true);

        let fallback = serde_json::to_value(&events[1]).expect("fallback event should serialize");
        assert_eq!(fallback["kind"], "retryFallbackApplied");
        assert_eq!(fallback["model"], "provider/fallback");
        assert_eq!(fallback["fallbackFrom"], "provider/primary");
        assert_eq!(fallback["fallbackTo"], "provider/fallback:high");
        assert_eq!(fallback["fallbackRole"], "default");
        assert!(fallback["modelRole"].is_null());

        let error = serde_json::to_value(&events[2]).expect("error event should serialize");
        assert_eq!(error["kind"], "modelError");
        assert_eq!(error["activity"], "error");
        assert_eq!(
            error["errorMessage"],
            "Cloud API error (429):\n  Individual quota reached"
        );
    }

    #[test]
    fn runtime_lines_report_thinking_activity() {
        let lines: &[&[u8]] = &[
            br#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}"#,
            br#"{"type":"custom","customType":"tool_execution_start"}"#,
            br#"{"type":"message","message":{"role":"toolResult","content":[{"type":"text","text":"result"}]}}"#,
            br#"{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"done"}],"stopReason":"stop"}}"#,
            br#"{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"next"}],"stopReason":"toolUse"}}"#,
            br#"{"type":"custom","customType":"tool_execution_end"}"#,
            br#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stopReason":"stop"}}"#,
            br#"{"type":"message","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"quota exhausted"}}"#,
            br#"{"type":"message","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"old error","retryRecovery":{"status":"recovered"}}}"#,
        ];

        let activities = lines
            .iter()
            .filter_map(|line| runtime_event_from_line("terminal-1", line))
            .filter_map(|event| event.activity)
            .collect::<Vec<_>>();

        assert_eq!(
            activities,
            [
                "thinking", "thinking", "thinking", "idle", "thinking", "thinking", "idle",
                "error", "thinking",
            ]
        );
    }

    #[test]
    fn runtime_lines_report_only_unrecovered_model_errors() {
        let failed = runtime_event_from_line(
            "terminal-1",
            br#"{"type":"message","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"Cloud API error (429):\n  Individual quota reached"}}"#,
        )
        .expect("failed model turn should emit runtime state");
        assert_eq!(failed.kind, PtyRuntimeEventKind::ModelError);
        assert_eq!(failed.activity.as_deref(), Some("error"));
        assert_eq!(
            failed.error_message.as_deref(),
            Some("Cloud API error (429):\n  Individual quota reached")
        );

        let recovered = runtime_event_from_line(
            "terminal-1",
            br#"{"type":"message","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"old error","retryRecovery":{"status":"recovered"}}}"#,
        )
        .expect("recovered model turn should keep runtime active");
        assert_eq!(recovered.activity.as_deref(), Some("thinking"));
        assert!(recovered.error_message.is_none());
    }

    #[test]
    fn runtime_cursor_does_not_replay_a_historical_error() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "omp-desktop-runtime-seed-{}-{nonce}.jsonl",
            std::process::id()
        ));
        fs::write(
            &path,
            b"{\"type\":\"message\",\"id\":\"error-1\",\"timestamp\":\"2026-08-09T10:00:00Z\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"error\",\"errorMessage\":\"old failure\"}}\n",
        )
        .expect("historical error fixture should be writable");
        let mut cursor = RuntimeWatchCursor::at_end(&path);
        let mut events = Vec::new();
        poll_runtime_file(&path, &mut cursor, || {}, |line| events.push(line.to_vec()));

        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("historical error fixture should be appendable");
        file.write_all(
            b"{\"type\":\"message\",\"id\":\"user-2\",\"timestamp\":\"2026-08-09T10:00:01Z\",\"message\":{\"role\":\"user\"}}\n",
        )
        .expect("live activity should be appendable");
        poll_runtime_file(&path, &mut cursor, || {}, |line| events.push(line.to_vec()));
        fs::remove_file(&path).expect("historical error fixture should be removable");

        assert_eq!(events.len(), 1);
        let event =
            runtime_event_from_line("terminal-1", &events[0]).expect("live activity should parse");
        assert_eq!(event.activity.as_deref(), Some("thinking"));
    }

    #[test]
    fn runtime_watcher_catches_up_events_after_rewrite() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "omp-desktop-runtime-rewrite-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("rewrite fixture directory should be writable");
        let path = directory.join("session.jsonl");
        let baseline = concat!(
            "{\"type\":\"session\",\"id\":\"session-1\",\"timestamp\":\"2026-08-09T10:00:00Z\"}\n",
            "{\"type\":\"message\",\"id\":\"user-1\",\"timestamp\":\"2026-08-09T10:00:01Z\",\"message\":{\"role\":\"user\"}}\n"
        );
        fs::write(&path, baseline).expect("baseline fixture should be writable");
        let mut cursor = RuntimeWatchCursor::at_end(&path);
        fs::write(
            &path,
            format!(
                "{{\"type\":\"title_change\",\"id\":\"title-0\",\"timestamp\":\"2026-08-09T09:59:59Z\",\"title\":\"rewritten\"}}\n{baseline}{{\"type\":\"retry_fallback_applied\",\"id\":\"fallback-1\",\"timestamp\":\"2026-08-09T10:00:02Z\",\"from\":\"provider/primary\",\"to\":\"provider/fallback\",\"role\":\"default\"}}\n{{\"type\":\"model_change\",\"id\":\"model-1\",\"timestamp\":\"2026-08-09T10:00:03Z\",\"model\":\"provider/fallback\",\"role\":\"fallback\"}}\n"
            ),
        )
        .expect("rewritten fixture should be writable");
        let mut resets = 0;
        let mut events = Vec::new();

        poll_runtime_file(
            &path,
            &mut cursor,
            || resets += 1,
            |line| {
                if let Some(event) = runtime_event_from_line("terminal-1", line) {
                    events.push(event);
                }
            },
        );
        fs::remove_dir_all(&directory).expect("rewrite fixture directory should be removable");

        assert_eq!(resets, 1);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, PtyRuntimeEventKind::RetryFallbackApplied);
        assert_eq!(events[1].kind, PtyRuntimeEventKind::ModelChange);
    }

    #[test]
    fn runtime_watcher_catches_up_a_disjoint_rotated_segment() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "omp-desktop-runtime-rotation-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("rotation fixture directory should be writable");
        let path = directory.join("session.jsonl");
        fs::write(
            &path,
            b"{\"type\":\"message\",\"id\":\"old-1\",\"timestamp\":\"2026-08-09T10:00:00Z\",\"message\":{\"role\":\"user\"}}\n",
        )
        .expect("old segment should be writable");
        let mut cursor = RuntimeWatchCursor::at_end(&path);
        fs::rename(&path, directory.join("session.old.jsonl"))
            .expect("old segment should be rotatable");
        fs::write(
            &path,
            b"{\"type\":\"retry_fallback_applied\",\"id\":\"new-1\",\"timestamp\":\"2026-08-09T10:00:00Z\",\"from\":\"provider/primary\",\"to\":\"provider/fallback\",\"role\":\"default\"}\n",
        )
        .expect("new segment should be writable");
        let mut events = Vec::new();

        poll_runtime_file(
            &path,
            &mut cursor,
            || {},
            |line| {
                if let Some(event) = runtime_event_from_line("terminal-1", line) {
                    events.push(event);
                }
            },
        );
        fs::remove_dir_all(&directory).expect("rotation fixture directory should be removable");

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, PtyRuntimeEventKind::RetryFallbackApplied);
    }

    #[test]
    fn runtime_watcher_filters_history_and_keeps_new_detailed_errors() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "omp-desktop-runtime-watermark-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("watermark fixture directory should be writable");
        let path = directory.join("session.jsonl");
        fs::write(
            &path,
            b"{\"type\":\"message\",\"id\":\"old-user\",\"timestamp\":\"2026-08-09T10:00:03Z\",\"message\":{\"role\":\"user\"}}\n",
        )
        .expect("watermark baseline should be writable");
        let mut cursor = RuntimeWatchCursor::at_end(&path);
        fs::rename(&path, directory.join("session.old.jsonl"))
            .expect("watermark baseline should be rotatable");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"message\",\"id\":\"historical-error\",\"timestamp\":\"2026-08-09T10:00:01Z\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"error\",\"errorMessage\":\"historical\"}}\n",
                "{\"type\":\"retry_fallback_applied\",\"id\":\"historical-fallback\",\"timestamp\":\"2026-08-09T10:00:02Z\",\"from\":\"provider/primary\",\"to\":\"provider/fallback\",\"role\":\"default\"}\n",
                "{\"type\":\"message\",\"id\":\"live-error\",\"timestamp\":\"2026-08-09T10:00:04Z\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"error\",\"errorMessage\":\"live failure\"}}\n"
            ),
        )
        .expect("watermark replacement should be writable");
        let mut events = Vec::new();

        poll_runtime_file(
            &path,
            &mut cursor,
            || {},
            |line| {
                if let Some(event) = runtime_event_from_line("terminal-1", line) {
                    events.push(event);
                }
            },
        );
        fs::remove_dir_all(&directory).expect("watermark fixture directory should be removable");

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, PtyRuntimeEventKind::ModelError);
        assert_eq!(events[0].error_message.as_deref(), Some("live failure"));
    }

    #[test]
    fn runtime_watcher_skips_unordered_legacy_history_after_reset() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "omp-desktop-runtime-watcher-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("fixture directory should be writable");
        let path = directory.join("session.jsonl");
        fs::write(
            &path,
            b"{\"type\":\"message\",\"message\":{\"role\":\"user\"}}\n",
        )
        .expect("initial runtime fixture should be writable");
        let mut cursor = RuntimeWatchCursor::at_end(&path);
        let mut resets = 0;
        let mut activities = Vec::new();

        poll_runtime_file(
            &path,
            &mut cursor,
            || resets += 1,
            |line| {
                if let Some(event) = runtime_event_from_line("terminal-1", line) {
                    activities.extend(event.activity);
                }
            },
        );
        assert_eq!(resets, 0);
        assert!(activities.is_empty());

        fs::write(
            &path,
            b"{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\"}}\n",
        )
        .expect("runtime fixture should be rewritable");
        poll_runtime_file(
            &path,
            &mut cursor,
            || resets += 1,
            |line| {
                if let Some(event) = runtime_event_from_line("terminal-1", line) {
                    activities.extend(event.activity);
                }
            },
        );
        assert_eq!(resets, 1);
        assert!(activities.is_empty());

        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("rewritten runtime fixture should be appendable");
        file.write_all(b"{\"type\":\"message\",\"message\":{\"role\":\"user\"}}\n")
            .expect("new runtime activity should be appendable");
        poll_runtime_file(
            &path,
            &mut cursor,
            || resets += 1,
            |line| {
                if let Some(event) = runtime_event_from_line("terminal-1", line) {
                    activities.extend(event.activity);
                }
            },
        );
        assert_eq!(activities, ["thinking"]);

        fs::rename(&path, directory.join("rotated.jsonl"))
            .expect("runtime fixture should be rotatable");
        fs::write(
            &path,
            b"{\"type\":\"message\",\"message\":{\"role\":\"user\"}}\n",
        )
        .expect("rotated runtime fixture should be replaceable");
        poll_runtime_file(
            &path,
            &mut cursor,
            || resets += 1,
            |line| {
                if let Some(event) = runtime_event_from_line("terminal-1", line) {
                    activities.extend(event.activity);
                }
            },
        );
        assert_eq!(resets, 2);
        assert_eq!(activities, ["thinking"]);

        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("rotated runtime fixture should be appendable");
        file.write_all(
            b"{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\"}}\n",
        )
        .expect("post-rotation activity should be appendable");
        poll_runtime_file(
            &path,
            &mut cursor,
            || resets += 1,
            |line| {
                if let Some(event) = runtime_event_from_line("terminal-1", line) {
                    activities.extend(event.activity);
                }
            },
        );
        fs::remove_dir_all(&directory).expect("fixture directory should be removable");

        assert_eq!(activities, ["thinking", "idle"]);
    }

    #[test]
    fn runtime_cursor_baselines_oversized_and_final_historical_lines() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "omp-desktop-runtime-activity-{}-{nonce}.jsonl",
            std::process::id()
        ));
        let mut contents = vec![b'x'; MAX_RUNTIME_EVENT_LINE + 1];
        contents.push(b'\n');
        contents.extend_from_slice(
            b"{\"type\":\"message\",\"id\":\"idle-1\",\"timestamp\":\"2026-08-09T10:00:00Z\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\"}}",
        );
        fs::write(&path, contents).expect("activity fixture should be writable");
        let mut cursor = RuntimeWatchCursor::at_end(&path);
        let mut activities = Vec::new();
        poll_runtime_file(
            &path,
            &mut cursor,
            || {},
            |line| {
                if let Some(event) = runtime_event_from_line("terminal-1", line) {
                    activities.extend(event.activity);
                }
            },
        );

        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("activity fixture should be appendable");
        file.write_all(
            b"\n{\"type\":\"message\",\"id\":\"user-2\",\"timestamp\":\"2026-08-09T10:00:01Z\",\"message\":{\"role\":\"user\"}}\n",
        )
        .expect("live activity should be appendable");
        poll_runtime_file(
            &path,
            &mut cursor,
            || {},
            |line| {
                if let Some(event) = runtime_event_from_line("terminal-1", line) {
                    activities.extend(event.activity);
                }
            },
        );
        fs::remove_file(&path).expect("activity fixture should be removable");

        assert_eq!(activities, ["thinking"]);
    }

    #[test]
    fn thinking_cycle_matches_omp_order() {
        assert_eq!(
            thinking_cycle(&["low".to_owned(), "xhigh".to_owned(), "max".to_owned()]),
            ["off", "auto", "low", "xhigh", "max"]
        );
    }

    #[test]
    fn terminal_breadcrumb_waits_for_parseable_session() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "omp-desktop-breadcrumb-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("fixture directory should be writable");
        let session_path = directory.join("session.jsonl");
        fs::write(&session_path, "{}\n").expect("session fixture should be writable");
        fs::write(
            directory.join("apple-terminal-1"),
            format!("/tmp/project\n{}\n", session_path.display()),
        )
        .expect("breadcrumb fixture should be writable");

        assert!(
            discover_session("terminal-1", "/tmp/project", &directory, &HashMap::new(),).is_none()
        );
        fs::write(
            &session_path,
            "{\"type\":\"session\",\"id\":\"new-session\",\"timestamp\":\"2026-07-20T12:00:00Z\",\"cwd\":\"/tmp/project\",\"title\":\"New session\"}\n",
        )
        .expect("session header should be writable");

        let (resolved, session) =
            discover_session("terminal-1", "/tmp/project", &directory, &HashMap::new())
                .expect("parseable session should be discovered");
        fs::remove_dir_all(&directory).expect("fixture directory should be removable");

        assert_eq!(resolved, session_path.to_string_lossy());
        assert_eq!(session.id, "new-session");
    }
    #[test]
    fn update_notice_detection_handles_ansi_and_split_chunks() {
        use super::detect_update_notice;

        let mut buffer = Vec::new();
        assert!(!detect_update_notice(
            &mut buffer,
            b"\x1b[32mNew version 17.1.0 is available.\x1b[0m"
        ));
        assert!(detect_update_notice(&mut buffer, b" Run: omp update\n"));

        let mut unrelated = Vec::new();
        assert!(!detect_update_notice(
            &mut unrelated,
            b"compiling crate omp_desktop_lib v0.1.8\n"
        ));

        let mut localized = Vec::new();
        assert!(detect_update_notice(
            &mut localized,
            "Доступна новая версия OMP 17.2.0. Запустите omp update\n".as_bytes()
        ));

        let mut missing_version = Vec::new();
        assert!(!detect_update_notice(
            &mut missing_version,
            b"New version is available. Run: omp update\n"
        ));
    }
}
