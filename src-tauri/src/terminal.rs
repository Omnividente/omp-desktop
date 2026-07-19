use crate::{
    sessions::{parse_session, path_key},
    settings::{resolve_omp, SettingsState},
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_PENDING_OUTPUT: usize = 2 * 1024 * 1024;
static NEXT_TERMINAL_ID: AtomicU64 = AtomicU64::new(1);
const RESTART_TIMEOUT: Duration = Duration::from_secs(5);
const SESSION_DISCOVERY_INTERVAL: Duration = Duration::from_millis(250);
const THINKING_LEVELS: &[&str] = &[
    "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto",
];

#[derive(Default)]
pub struct TerminalState {
    processes: Mutex<HashMap<String, TerminalProcess>>,
    process_exited: Condvar,
}

struct TerminalProcess {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    cwd: String,
    resume_path: Option<String>,
    terminal_sessions_dir: PathBuf,
    breadcrumb_snapshot: HashMap<PathBuf, u128>,
    pending_output: Vec<u8>,
    attached: bool,
    exited: bool,
    exit_code: Option<u32>,
    exit_success: bool,
    exit_error: Option<String>,
    restartable: bool,
    restart_pending: bool,
}

impl Drop for TerminalProcess {
    fn drop(&mut self) {
        if !self.exited {
            let _ = self.killer.kill();
        }
    }
}

impl TerminalState {
    pub fn shutdown_all(&self) {
        let processes = self
            .processes
            .lock()
            .map(|mut processes| std::mem::take(&mut *processes));
        self.process_exited.notify_all();
        if let Ok(processes) = processes {
            drop(processes);
        }
    }
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
pub struct RestartRequest {
    pub terminal_id: String,
    pub model_selector: String,
    pub thinking_level: Option<String>,
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtySessionEvent {
    terminal_id: String,
    session: crate::models::SessionSummary,
}

#[tauri::command]
pub fn start_terminal(
    request: LaunchRequest,
    app: AppHandle,
    settings: State<'_, SettingsState>,
    terminals: State<'_, TerminalState>,
) -> Result<TerminalStarted, String> {
    let cwd = Path::new(&request.cwd);
    if !cwd.is_dir() {
        return Err(format!("Папка проекта не найдена: {}", cwd.display()));
    }
    if let Some(resume_path) = request.resume_path.as_deref() {
        if !Path::new(resume_path).is_file() {
            return Err(format!("Файл сессии не найден: {resume_path}"));
        }
    }

    let settings = settings
        .0
        .lock()
        .map_err(|_| "Настройки заблокированы после внутренней ошибки".to_owned())?
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
pub async fn restart_terminal(
    request: RestartRequest,
    app: AppHandle,
) -> Result<TerminalStarted, String> {
    tauri::async_runtime::spawn_blocking(move || restart_terminal_blocking(request, app))
        .await
        .map_err(|error| format!("Не удалось дождаться перезапуска OMP: {error}"))?
}

fn restart_terminal_blocking(
    request: RestartRequest,
    app: AppHandle,
) -> Result<TerminalStarted, String> {
    validate_restart_request(&request)?;
    let settings = app
        .state::<SettingsState>()
        .0
        .lock()
        .map_err(|_| "Настройки заблокированы после внутренней ошибки".to_owned())?
        .clone();
    let omp = resolve_omp(&app, &settings);
    if omp.version.is_none() {
        return Err(format!(
            "OMP не найден. Проверьте путь к исполняемому файлу в настройках: {}",
            omp.executable
        ));
    }

    let terminals = app.state::<TerminalState>();
    let (known_resume_path, cwd, terminal_sessions_dir, breadcrumb_snapshot) = {
        let processes = terminals
            .processes
            .lock()
            .map_err(|_| "Список терминалов заблокирован после внутренней ошибки".to_owned())?;
        let process = processes
            .get(&request.terminal_id)
            .ok_or_else(|| format!("Терминал не найден: {}", request.terminal_id))?;
        if !process.restartable {
            return Err("Эта служебная вкладка не поддерживает смену модели".to_owned());
        }
        if process.restart_pending {
            return Err("Перезапуск OMP уже выполняется".to_owned());
        }
        if process.exited {
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

    let mut processes = terminals
        .processes
        .lock()
        .map_err(|_| "Список терминалов заблокирован после внутренней ошибки".to_owned())?;
    let size = {
        let process = processes
            .get_mut(&request.terminal_id)
            .ok_or_else(|| format!("Терминал не найден: {}", request.terminal_id))?;
        if process.restart_pending {
            return Err("Перезапуск OMP уже выполняется".to_owned());
        }
        if process.exited {
            return Err("Процесс OMP уже завершён".to_owned());
        }
        let size = process
            .master
            .get_size()
            .map_err(|error| format!("Не удалось прочитать размер терминала: {error}"))?;
        process.resume_path = Some(resume_path.clone());
        process.restart_pending = true;
        if let Err(error) = process.killer.kill() {
            process.restart_pending = false;
            return Err(format!(
                "Не удалось остановить OMP для переключения: {error}"
            ));
        }
        size
    };

    let deadline = Instant::now() + RESTART_TIMEOUT;
    loop {
        let process = processes
            .get_mut(&request.terminal_id)
            .ok_or_else(|| format!("Терминал закрыт: {}", request.terminal_id))?;
        if process.exited {
            break;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            process.restart_pending = false;
            return Err("OMP не завершился за 5 секунд; переключение отменено".to_owned());
        }
        let (next, timeout) = terminals
            .process_exited
            .wait_timeout(processes, remaining)
            .map_err(|_| "Список терминалов заблокирован после внутренней ошибки".to_owned())?;
        processes = next;
        if timeout.timed_out() {
            if let Some(process) = processes.get_mut(&request.terminal_id) {
                if !process.exited {
                    process.restart_pending = false;
                }
            }
            return Err("OMP не завершился за 5 секунд; переключение отменено".to_owned());
        }
    }
    drop(processes);

    let args = restart_agent_args(
        &cwd,
        &resume_path,
        &request.model_selector,
        request.thinking_level.as_deref(),
    );
    let started = spawn_terminal_process(
        &app,
        &terminals,
        &omp.executable,
        &settings.provider_env,
        cwd,
        Some(resume_path),
        args,
        size,
        true,
    );
    match started {
        Ok(started) => {
            let mut processes = terminals
                .processes
                .lock()
                .map_err(|_| "Список терминалов заблокирован после внутренней ошибки".to_owned())?;
            if processes.remove(&request.terminal_id).is_none() {
                let replacement = processes.remove(&started.terminal_id);
                drop(processes);
                drop(replacement);
                return Err(format!("Терминал закрыт: {}", request.terminal_id));
            }
            terminals.process_exited.notify_all();
            Ok(started)
        }
        Err(error) => {
            let message = format!("Не удалось перезапустить OMP: {error}");
            let should_emit = {
                let mut processes = terminals.processes.lock().map_err(|_| {
                    "Список терминалов заблокирован после внутренней ошибки".to_owned()
                })?;
                if let Some(process) = processes.get_mut(&request.terminal_id) {
                    process.restart_pending = false;
                    process.exited = true;
                    process.exit_code = None;
                    process.exit_success = false;
                    process.exit_error = Some(message.clone());
                    process.attached
                } else {
                    false
                }
            };
            terminals.process_exited.notify_all();
            if should_emit {
                let _ = app.emit(
                    "pty-exit",
                    PtyExitEvent {
                        terminal_id: request.terminal_id,
                        exit_code: None,
                        success: false,
                        error: Some(message.clone()),
                    },
                );
            }
            Err(message)
        }
    }
}

fn validate_restart_request(request: &RestartRequest) -> Result<(), String> {
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
    if let Some(level) = request.thinking_level.as_deref() {
        if !THINKING_LEVELS.contains(&level) {
            return Err(format!("Неизвестный уровень рассуждений: {level}"));
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

fn restart_agent_args(
    cwd: &str,
    resume_path: &str,
    model_selector: &str,
    thinking_level: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "--cwd".to_owned(),
        cwd.to_owned(),
        "--resume".to_owned(),
        resume_path.to_owned(),
        "--model".to_owned(),
        model_selector.to_owned(),
    ];
    if let Some(thinking_level) = thinking_level {
        args.push("--thinking".to_owned());
        args.push(thinking_level.to_owned());
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

    let watch_session = restartable && resume_path.is_none();
    let process = TerminalProcess {
        master: pair.master,
        writer,
        killer,
        cwd: cwd.clone(),
        resume_path,
        terminal_sessions_dir,
        breadcrumb_snapshot,
        pending_output: Vec::new(),
        attached: false,
        exited: false,
        exit_code: None,
        exit_success: false,
        exit_error: None,
        restartable,
        restart_pending: false,
    };
    terminals
        .processes
        .lock()
        .map_err(|_| "Список терминалов заблокирован после внутренней ошибки".to_owned())?
        .insert(terminal_id.clone(), process);
    spawn_reader(app.clone(), terminal_id.clone(), reader);
    spawn_waiter(app.clone(), terminal_id.clone(), move || child.wait());
    if watch_session {
        spawn_session_watcher(app.clone(), terminal_id.clone());
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
    let direct = directory.join(format!("apple-{terminal_id}"));
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
        let Ok(processes) = state.processes.lock() else {
            return true;
        };
        let Some(process) = processes.get(terminal_id) else {
            return true;
        };
        if !process.restartable || process.resume_path.is_some() || process.exited {
            return true;
        }
        (
            process.cwd.clone(),
            process.terminal_sessions_dir.clone(),
            process.breadcrumb_snapshot.clone(),
        )
    };
    let Some((resume_path, session)) =
        discover_session(terminal_id, &context.0, &context.1, &context.2)
    else {
        return false;
    };

    {
        let Ok(mut processes) = state.processes.lock() else {
            return true;
        };
        let Some(process) = processes.get_mut(terminal_id) else {
            return true;
        };
        if !process.restartable || process.resume_path.is_some() || process.exited {
            return true;
        }
        process.resume_path = Some(resume_path);
    }

    let _ = app.emit(
        "pty-session",
        PtySessionEvent {
            terminal_id: terminal_id.to_owned(),
            session,
        },
    );
    true
}

fn spawn_session_watcher(app: AppHandle, terminal_id: String) {
    thread::Builder::new()
        .name(format!("session-watcher-{terminal_id}"))
        .spawn(move || {
            while !cache_resume_path(&app, &terminal_id) {
                thread::sleep(SESSION_DISCOVERY_INTERVAL);
            }
        })
        .expect("failed to spawn OMP session watcher thread");
}

#[tauri::command]
pub fn attach_terminal(
    terminal_id: String,
    terminals: State<'_, TerminalState>,
) -> Result<TerminalAttachment, String> {
    let mut processes = terminals
        .processes
        .lock()
        .map_err(|_| "Список терминалов заблокирован после внутренней ошибки".to_owned())?;
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
    data: Vec<u8>,
    terminals: State<'_, TerminalState>,
) -> Result<(), String> {
    write_bytes(&terminal_id, &data, &terminals)
}

#[tauri::command]
pub fn resize_terminal(
    terminal_id: String,
    cols: u16,
    rows: u16,
    terminals: State<'_, TerminalState>,
) -> Result<(), String> {
    let processes = terminals
        .processes
        .lock()
        .map_err(|_| "Список терминалов заблокирован после внутренней ошибки".to_owned())?;
    let process = processes
        .get(&terminal_id)
        .ok_or_else(|| format!("Терминал не найден: {terminal_id}"))?;
    process
        .master
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
    let process = terminals
        .processes
        .lock()
        .map_err(|_| "Список терминалов заблокирован после внутренней ошибки".to_owned())?
        .remove(&terminal_id);
    terminals.process_exited.notify_all();
    drop(process);
    Ok(())
}

fn write_bytes(terminal_id: &str, data: &[u8], terminals: &TerminalState) -> Result<(), String> {
    let mut processes = terminals
        .processes
        .lock()
        .map_err(|_| "Список терминалов заблокирован после внутренней ошибки".to_owned())?;
    let process = processes
        .get_mut(terminal_id)
        .ok_or_else(|| format!("Терминал не найден: {terminal_id}"))?;
    if process.exited {
        return Err("Процесс OMP уже завершён".to_owned());
    }
    if process.restart_pending {
        return Err("Процесс OMP перезапускается".to_owned());
    }
    process
        .writer
        .write_all(data)
        .map_err(|error| format!("Не удалось отправить ввод в OMP: {error}"))
}

fn spawn_reader(app: AppHandle, terminal_id: String, mut reader: Box<dyn Read + Send>) {
    thread::Builder::new()
        .name(format!("pty-reader-{terminal_id}"))
        .spawn(move || {
            let mut buffer = [0_u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => route_output(&app, &terminal_id, &buffer[..read]),
                    Err(_) => break,
                }
            }
        })
        .expect("failed to spawn PTY reader thread");
}

fn spawn_waiter<F>(app: AppHandle, terminal_id: String, wait: F)
where
    F: FnOnce() -> std::io::Result<portable_pty::ExitStatus> + Send + 'static,
{
    thread::Builder::new()
        .name(format!("pty-waiter-{terminal_id}"))
        .spawn(move || {
            let event = match wait() {
                Ok(status) => PtyExitEvent {
                    terminal_id: terminal_id.clone(),
                    exit_code: Some(status.exit_code()),
                    success: status.success(),
                    error: status.signal().map(|signal| format!("Сигнал: {signal}")),
                },
                Err(error) => PtyExitEvent {
                    terminal_id: terminal_id.clone(),
                    exit_code: None,
                    success: false,
                    error: Some(error.to_string()),
                },
            };

            let should_emit = {
                let state = app.state::<TerminalState>();
                let Ok(mut processes) = state.processes.lock() else {
                    return;
                };
                let Some(process) = processes.get_mut(&terminal_id) else {
                    state.process_exited.notify_all();
                    return;
                };
                process.exited = true;
                process.exit_code = event.exit_code;
                process.exit_success = event.success;
                process.exit_error = event.error.clone();
                let should_emit = process.attached && !process.restart_pending;
                state.process_exited.notify_all();
                should_emit
            };

            if should_emit {
                let _ = app.emit("pty-exit", event);
            }
        })
        .expect("failed to spawn PTY waiter thread");
}

fn route_output(app: &AppHandle, terminal_id: &str, data: &[u8]) {
    cache_resume_path(app, terminal_id);
    let payload = {
        let state = app.state::<TerminalState>();
        let Ok(mut processes) = state.processes.lock() else {
            return;
        };
        let Some(process) = processes.get_mut(terminal_id) else {
            return;
        };

        if process.attached {
            Some(PtyOutputEvent {
                terminal_id: terminal_id.to_owned(),
                data: BASE64.encode(data),
            })
        } else {
            append_pending(&mut process.pending_output, data);
            None
        }
    };

    if let Some(payload) = payload {
        let _ = app.emit("pty-output", payload);
    }
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
        discover_session, initial_agent_args, restart_agent_args, validate_restart_request,
        RestartRequest,
    };
    use std::{
        collections::HashMap,
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn restart_args_always_use_exact_resume_path() {
        assert_eq!(
            restart_agent_args(
                "/tmp/project",
                "/tmp/session.jsonl",
                "provider/model",
                Some("xhigh"),
            ),
            vec![
                "--cwd",
                "/tmp/project",
                "--resume",
                "/tmp/session.jsonl",
                "--model",
                "provider/model",
                "--thinking",
                "xhigh",
            ]
        );
        assert_eq!(
            initial_agent_args("/tmp/project", Some("/tmp/session.jsonl")),
            vec!["--cwd", "/tmp/project", "--resume", "/tmp/session.jsonl",]
        );
    }

    #[test]
    fn restart_request_rejects_unsafe_values() {
        let valid = RestartRequest {
            terminal_id: "terminal-1".to_owned(),
            model_selector: "provider/model".to_owned(),
            thinking_level: Some("max".to_owned()),
        };
        assert!(validate_restart_request(&valid).is_ok());

        let invalid_model = RestartRequest {
            model_selector: "provider/model with space".to_owned(),
            ..valid
        };
        assert!(validate_restart_request(&invalid_model).is_err());

        let invalid_thinking = RestartRequest {
            terminal_id: "terminal-1".to_owned(),
            model_selector: "provider/model".to_owned(),
            thinking_level: Some("turbo".to_owned()),
        };
        assert!(validate_restart_request(&invalid_thinking).is_err());
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
}
