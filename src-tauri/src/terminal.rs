use crate::settings::{resolve_omp, SettingsState};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    thread,
};
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_PENDING_OUTPUT: usize = 2 * 1024 * 1024;
static NEXT_TERMINAL_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct TerminalState {
    processes: Mutex<HashMap<String, TerminalProcess>>,
}

struct TerminalProcess {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pending_output: Vec<u8>,
    attached: bool,
    exited: bool,
    exit_code: Option<u32>,
    exit_success: bool,
    exit_error: Option<String>,
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
    pub cols: u16,
    pub rows: u16,
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

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: request.rows.clamp(5, 300),
            cols: request.cols.clamp(20, 500),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Не удалось создать PTY: {error}"))?;

    let mut command = CommandBuilder::new(&omp.executable);
    command.cwd(cwd);
    command.arg("--cwd");
    command.arg(cwd);
    if let Some(resume_path) = request.resume_path.as_deref() {
        command.arg("--resume");
        command.arg(resume_path);
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "OMP Desktop");

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Не удалось запустить OMP: {error}"))?;
    let process_id = child.process_id();
    let killer = child.clone_killer();
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Не удалось подключить вывод PTY: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Не удалось подключить ввод PTY: {error}"))?;
    drop(pair.slave);

    let terminal_id = format!(
        "terminal-{}-{}",
        std::process::id(),
        NEXT_TERMINAL_ID.fetch_add(1, Ordering::Relaxed)
    );
    let process = TerminalProcess {
        master: pair.master,
        writer,
        killer,
        pending_output: Vec::new(),
        attached: false,
        exited: false,
        exit_code: None,
        exit_success: false,
        exit_error: None,
    };
    terminals
        .processes
        .lock()
        .map_err(|_| "Список терминалов заблокирован после внутренней ошибки".to_owned())?
        .insert(terminal_id.clone(), process);

    spawn_reader(app.clone(), terminal_id.clone(), reader);
    spawn_waiter(app, terminal_id.clone(), move || child.wait());

    Ok(TerminalStarted {
        terminal_id,
        process_id,
        cwd: request.cwd,
    })
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
                process.attached
            };

            if should_emit {
                let _ = app.emit("pty-exit", event);
            }
        })
        .expect("failed to spawn PTY waiter thread");
}

fn route_output(app: &AppHandle, terminal_id: &str, data: &[u8]) {
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
