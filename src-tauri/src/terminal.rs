use crate::{
    sessions::{parse_session, path_key},
    settings::{resolve_omp, SettingsState},
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
        Mutex,
    },
    thread,
    time::{Duration, Instant, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_PENDING_OUTPUT: usize = 2 * 1024 * 1024;
static NEXT_TERMINAL_ID: AtomicU64 = AtomicU64::new(1);
const SESSION_DISCOVERY_INTERVAL: Duration = Duration::from_millis(250);
const MAX_RUNTIME_EVENT_LINE: usize = 64 * 1024;
const THINKING_LEVELS: &[&str] = &[
    "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto",
];

#[derive(Default)]
pub struct TerminalState {
    processes: Mutex<HashMap<String, TerminalProcess>>,
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
    switch_pending: bool,
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtySessionEvent {
    terminal_id: String,
    session: crate::models::SessionSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyRuntimeEvent {
    terminal_id: String,
    model: Option<String>,
    model_role: Option<String>,
    thinking_level: Option<String>,
    configured_thinking_level: Option<String>,
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
        if process.switch_pending {
            return Err("Смена модели уже выполняется".to_owned());
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

    let should_spawn_runtime_watcher = {
        let mut processes = terminals
            .processes
            .lock()
            .map_err(|_| "Список терминалов заблокирован после внутренней ошибки".to_owned())?;
        let process = processes
            .get_mut(&request.terminal_id)
            .ok_or_else(|| format!("Терминал не найден: {}", request.terminal_id))?;
        if process.switch_pending {
            return Err("Смена модели уже выполняется".to_owned());
        }
        if process.exited {
            return Err("Процесс OMP уже завершён".to_owned());
        }
        let should_spawn = process.resume_path.is_none();
        process.resume_path = Some(resume_path.clone());
        process.switch_pending = true;
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
    if let Ok(mut processes) = terminals.processes.lock() {
        if let Some(process) = processes.get_mut(&request.terminal_id) {
            process.switch_pending = false;
        }
    }
    result
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
        if let Some(model) = event.model {
            self.model = Some(model);
            self.model_role = Some(event.model_role.unwrap_or_else(|| "default".to_owned()));
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
        let input = format!("\u{1b}p{}\r", request.model_selector);
        write_switch_input(&request.terminal_id, input.as_bytes(), terminals)?;
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
        write_switch_input(terminal_id, b"\x1b[Z", terminals)?;
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
    process
        .writer
        .write_all(data)
        .and_then(|()| process.writer.flush())
        .map_err(|error| format!("Не удалось отправить команду смены модели в OMP: {error}"))
}

fn ensure_terminal_alive(terminal_id: &str, terminals: &TerminalState) -> Result<(), String> {
    let processes = terminals
        .processes
        .lock()
        .map_err(|_| "Список терминалов заблокирован после внутренней ошибки".to_owned())?;
    let process = processes
        .get(terminal_id)
        .ok_or_else(|| format!("Терминал не найден: {terminal_id}"))?;
    if process.exited {
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
        switch_pending: false,
    };
    terminals
        .processes
        .lock()
        .map_err(|_| "Список терминалов заблокирован после внутренней ошибки".to_owned())?
        .insert(terminal_id.clone(), process);
    spawn_reader(app.clone(), terminal_id.clone(), reader);
    spawn_waiter(app.clone(), terminal_id.clone(), move || child.wait());
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
    thread::Builder::new()
        .name(format!("session-watcher-{terminal_id}"))
        .spawn(move || {
            while !cache_resume_path(&app, &terminal_id) {
                thread::sleep(SESSION_DISCOVERY_INTERVAL);
            }
        })
        .expect("failed to spawn OMP session watcher thread");
}

fn spawn_runtime_watcher(app: AppHandle, terminal_id: String, session_path: String) {
    thread::Builder::new()
        .name(format!("runtime-watcher-{terminal_id}"))
        .spawn(move || {
            let path = PathBuf::from(&session_path);
            let mut offset = fs::metadata(&path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            let mut line = Vec::with_capacity(1024);
            let mut line_overflow = false;

            loop {
                thread::sleep(SESSION_DISCOVERY_INTERVAL);
                let active = {
                    let state = app.state::<TerminalState>();
                    let Ok(processes) = state.processes.lock() else {
                        return;
                    };
                    processes.get(&terminal_id).is_some_and(|process| {
                        !process.exited
                            && process.resume_path.as_deref() == Some(session_path.as_str())
                    })
                };
                if !active {
                    return;
                }

                let Ok(metadata) = fs::metadata(&path) else {
                    continue;
                };
                let length = metadata.len();
                if length < offset {
                    offset = length;
                    line.clear();
                    line_overflow = false;
                    continue;
                }
                if length == offset {
                    continue;
                }

                let Ok(mut file) = fs::File::open(&path) else {
                    continue;
                };
                if file.seek(SeekFrom::Start(offset)).is_err() {
                    continue;
                }
                let mut buffer = [0_u8; 8192];
                loop {
                    let Ok(read) = file.read(&mut buffer) else {
                        break;
                    };
                    if read == 0 {
                        break;
                    }
                    offset = offset.saturating_add(read as u64);
                    feed_runtime_lines(
                        &buffer[..read],
                        &mut line,
                        &mut line_overflow,
                        |runtime_line| {
                            if let Some(event) = runtime_event_from_line(&terminal_id, runtime_line)
                            {
                                let _ = app.emit("pty-runtime", event);
                            }
                        },
                    );
                }
            }
        })
        .expect("failed to spawn OMP runtime watcher thread");
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

fn runtime_event_from_line(terminal_id: &str, line: &[u8]) -> Option<PtyRuntimeEvent> {
    let value = serde_json::from_slice::<Value>(line).ok()?;
    match value.get("type").and_then(Value::as_str)? {
        "model_change" => Some(PtyRuntimeEvent {
            terminal_id: terminal_id.to_owned(),
            model: value
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned),
            model_role: value.get("role").and_then(Value::as_str).map(str::to_owned),
            thinking_level: None,
            configured_thinking_level: None,
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
                model: None,
                model_role: None,
                thinking_level,
                configured_thinking_level,
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
    if process.switch_pending {
        return Err("OMP переключает модель".to_owned());
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
                    return;
                };
                process.exited = true;
                process.exit_code = event.exit_code;
                process.exit_success = event.success;
                process.exit_error = event.error.clone();
                let should_emit = process.attached;
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
        discover_session, feed_runtime_lines, initial_agent_args, runtime_event_from_line,
        thinking_cycle, validate_switch_request, SwitchRequest,
    };
    use std::{
        collections::HashMap,
        fs,
        time::{SystemTime, UNIX_EPOCH},
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
    fn initial_args_always_use_exact_resume_path() {
        assert_eq!(
            initial_agent_args("/tmp/project", Some("/tmp/session.jsonl")),
            vec!["--cwd", "/tmp/project", "--resume", "/tmp/session.jsonl",]
        );
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
    fn runtime_lines_report_model_role_and_configured_thinking() {
        let payload = concat!(
            "{\"type\":\"custom_message\",\"content\":\"ignored\"}\n",
            "{\"type\":\"model_change\",\"model\":\"provider/new\",\"role\":\"fallback\"}\n",
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

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].model.as_deref(), Some("provider/new"));
        assert_eq!(events[0].model_role.as_deref(), Some("fallback"));
        assert_eq!(events[1].thinking_level.as_deref(), Some("high"));
        assert_eq!(events[1].configured_thinking_level.as_deref(), Some("auto"));
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
}
