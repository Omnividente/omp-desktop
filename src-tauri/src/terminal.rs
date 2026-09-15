#[cfg(windows)]
use crate::sessions::normalize_windows_verbatim_path;
use crate::{
    diagnostics,
    omp_command::GITHUB_AUTH_ENV_KEYS,
    session_lease::{SessionLease, SessionLeasePurpose},
    sessions::{
        apply_handoff_title_pins, apply_session_primary_provider_pin, apply_session_title_pin,
        canonical_project_path, parse_session, path_key, session_title_fallback_from_line,
        transfer_session_primary_provider_pin, validated_session_file,
    },
    settings::{
        ensure_primary_provider_pin_overlay, ensure_proxy_provider_overlay, resolve_omp,
        save_settings, settings_snapshot, with_settings_transaction, SettingsState,
    },
    update,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(windows)]
use std::sync::atomic::AtomicU32;
use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
    env, fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{GetCurrentThreadId, OpenThread, THREAD_TERMINATE},
        IO::CancelSynchronousIo,
    },
};
const MAX_REPLAY_OUTPUT: usize = 2 * 1024 * 1024;
const PTY_OUTPUT_BATCH_INTERVAL: Duration = Duration::from_millis(5);
const PTY_EXIT_FINALIZE_TIMEOUT: Duration = Duration::from_secs(5);
const PTY_EXIT_TRUNCATION_ERROR: &str =
    "Вывод PTY обрезан: процесс-потомок удерживает консоль после завершения OMP";
const PTY_OUTPUT_BATCH_LIMIT: usize = 64 * 1024;
const PTY_OUTPUT_QUEUE_CAPACITY: usize = 64;
const PTY_INPUT_QUEUE_CAPACITY: usize = 64;
const PTY_INPUT_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
static NEXT_TERMINAL_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_OUTPUT_GENERATION: AtomicU64 = AtomicU64::new(1);
// Deliberate 4 Hz polling: watchers exist only while the PTY is alive, and polling avoids
// platform-specific rename/replacement gaps for OMP's append-only runtime files.
const SESSION_DISCOVERY_INTERVAL: Duration = Duration::from_millis(250);
const RUNTIME_FILE_ANCHOR: usize = 64;
const MAX_RUNTIME_EVENT_LINE: usize = 64 * 1024;
const MAX_RUNTIME_WATERMARK_KEYS: usize = 256;
const RUNTIME_TITLE_BASELINE_LINES: usize = 64;
const THINKING_LEVELS: &[&str] = &[
    "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto",
];
const MAX_SWITCH_INPUT_BUFFER: usize = 64 * 1024;

#[cfg(windows)]
struct WindowsJobObject(HANDLE);

#[cfg(windows)]
unsafe impl Send for WindowsJobObject {}

#[cfg(windows)]
impl WindowsJobObject {
    fn new() -> std::io::Result<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let job = Self(handle);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(job)
    }

    fn assign(&self, process: std::os::windows::io::RawHandle) -> std::io::Result<()> {
        if unsafe { AssignProcessToJobObject(self.0, process.cast()) } == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}
static NEXT_SWITCH_RECOVERY_TOKEN: AtomicU64 = AtomicU64::new(1);

#[cfg(windows)]
impl Drop for WindowsJobObject {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

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
struct PtyWriteRequest {
    data: Vec<u8>,
    completion: Option<mpsc::SyncSender<Result<(), String>>>,
}

#[derive(Default)]
struct PtyWriterControl {
    closed: AtomicBool,
    io_active: AtomicBool,
    error: Mutex<Option<String>>,
    #[cfg(windows)]
    thread_id: AtomicU32,
}

struct TerminalWriter {
    sender: Mutex<Option<mpsc::SyncSender<PtyWriteRequest>>>,
    control: Arc<PtyWriterControl>,
}

impl TerminalWriter {
    fn enqueue(&self, data: Vec<u8>, wait_for_completion: bool) -> Result<(), String> {
        let completion = self.enqueue_request(data, wait_for_completion)?;
        match completion {
            Some(receiver) => self.wait_for_completion(receiver),
            None => Ok(()),
        }
    }

    fn enqueue_request(
        &self,
        data: Vec<u8>,
        wait_for_completion: bool,
    ) -> Result<Option<mpsc::Receiver<Result<(), String>>>, String> {
        if self.control.closed.load(Ordering::Acquire) {
            return Err("Процесс OMP уже завершён".to_owned());
        }
        if let Some(error) = self.error() {
            return Err(error);
        }

        let (completion, completion_receiver) = if wait_for_completion {
            let (sender, receiver) = mpsc::sync_channel(1);
            (Some(sender), Some(receiver))
        } else {
            (None, None)
        };
        let sender = self
            .sender
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .cloned()
            .ok_or_else(|| "Процесс OMP уже завершён".to_owned())?;
        match sender.try_send(PtyWriteRequest { data, completion }) {
            Ok(()) => Ok(completion_receiver),
            Err(mpsc::TrySendError::Full(_)) => Err("Буфер ввода PTY заполнен".to_owned()),
            Err(mpsc::TrySendError::Disconnected(_)) => Err(self
                .error()
                .unwrap_or_else(|| "Процесс OMP уже завершён".to_owned())),
        }
    }

    fn wait_for_completion(
        &self,
        receiver: mpsc::Receiver<Result<(), String>>,
    ) -> Result<(), String> {
        match receiver.recv_timeout(PTY_INPUT_WRITE_TIMEOUT) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err("OMP не принимает ввод PTY более 5 секунд".to_owned())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(self
                .error()
                .unwrap_or_else(|| "Процесс OMP уже завершён".to_owned())),
        }
    }

    fn close(&self) {
        self.control.closed.store(true, Ordering::Release);
        self.sender
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        #[cfg(windows)]
        cancel_pending_writer_io(&self.control);
    }

    fn error(&self) -> Option<String> {
        self.control
            .error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl Drop for TerminalWriter {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(windows)]
fn cancel_pending_writer_io(control: &PtyWriterControl) {
    let deadline = Instant::now() + Duration::from_millis(250);
    while control.io_active.load(Ordering::Acquire) {
        let thread_id = control.thread_id.load(Ordering::Acquire);
        if thread_id != 0 {
            unsafe {
                let thread_handle = OpenThread(THREAD_TERMINATE, 0, thread_id);
                if !thread_handle.is_null() {
                    let _ = CancelSynchronousIo(thread_handle);
                    let _ = CloseHandle(thread_handle);
                }
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(1));
    }
}

fn spawn_terminal_writer<F>(
    terminal_id: &str,
    mut writer: Box<dyn Write + Send>,
    on_error: F,
) -> Result<Arc<TerminalWriter>, String>
where
    F: FnOnce(String) + Send + 'static,
{
    let (sender, receiver) = mpsc::sync_channel(PTY_INPUT_QUEUE_CAPACITY);
    let control = Arc::new(PtyWriterControl::default());
    let terminal_writer = Arc::new(TerminalWriter {
        sender: Mutex::new(Some(sender)),
        control: control.clone(),
    });
    let mut on_error = Some(on_error);
    thread::Builder::new()
        .name(format!("pty-writer-{terminal_id}"))
        .spawn(move || {
            #[cfg(windows)]
            control
                .thread_id
                .store(unsafe { GetCurrentThreadId() }, Ordering::Release);
            while let Ok(request) = receiver.recv() {
                let PtyWriteRequest { data, completion } = request;
                if control.closed.load(Ordering::Acquire) {
                    if let Some(completion) = completion {
                        let _ = completion.send(Err("Процесс OMP уже завершён".to_owned()));
                    }
                    break;
                }

                control.io_active.store(true, Ordering::Release);
                if control.closed.load(Ordering::Acquire) {
                    control.io_active.store(false, Ordering::Release);
                    if let Some(completion) = completion {
                        let _ = completion.send(Err("Процесс OMP уже завершён".to_owned()));
                    }
                    break;
                }
                let result = writer
                    .write_all(&data)
                    .and_then(|()| writer.flush())
                    .map_err(|error| format!("Не удалось отправить ввод в OMP: {error}"));
                control.io_active.store(false, Ordering::Release);

                match result {
                    Ok(()) => {
                        if let Some(completion) = completion {
                            let _ = completion.send(Ok(()));
                        }
                    }
                    Err(error) => {
                        let reported = if control.closed.load(Ordering::Acquire) {
                            "Процесс OMP уже завершён".to_owned()
                        } else {
                            *control
                                .error
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                                Some(error.clone());
                            if let Some(on_error) = on_error.take() {
                                on_error(error.clone());
                            }
                            error
                        };
                        if let Some(completion) = completion {
                            let _ = completion.send(Err(reported));
                        }
                        break;
                    }
                }
            }
            control.io_active.store(false, Ordering::Release);
            #[cfg(windows)]
            control.thread_id.store(0, Ordering::Release);
        })
        .map_err(|error| format!("Не удалось запустить поток ввода PTY: {error}"))?;
    Ok(terminal_writer)
}
#[derive(Clone)]
struct BufferedOutput {
    seq: u64,
    data: Vec<u8>,
    start: usize,
}

impl BufferedOutput {
    fn bytes(&self) -> &[u8] {
        &self.data[self.start..]
    }

    fn len(&self) -> usize {
        self.data.len() - self.start
    }
}

#[derive(Default)]
struct OutputReplay {
    batches: VecDeque<BufferedOutput>,
    byte_count: usize,
    dropped_bytes: u64,
    dropped_through_seq: Option<u64>,
}

struct OutputReplaySnapshot {
    data: Vec<u8>,
    first_seq: Option<u64>,
    last_seq: Option<u64>,
    truncated: bool,
    dropped_bytes: u64,
}

impl OutputReplay {
    fn push(&mut self, seq: u64, data: &[u8]) {
        if data.len() >= MAX_REPLAY_OUTPUT {
            self.dropped_bytes = self
                .dropped_bytes
                .saturating_add(self.byte_count as u64)
                .saturating_add((data.len() - MAX_REPLAY_OUTPUT) as u64);
            self.dropped_through_seq = Some(seq);
            self.batches.clear();
            self.byte_count = MAX_REPLAY_OUTPUT;
            self.batches.push_back(BufferedOutput {
                seq,
                data: data[data.len() - MAX_REPLAY_OUTPUT..].to_vec(),
                start: 0,
            });
            return;
        }

        let mut overflow = self
            .byte_count
            .saturating_add(data.len())
            .saturating_sub(MAX_REPLAY_OUTPUT);
        while overflow > 0 {
            let Some(front) = self.batches.front_mut() else {
                break;
            };
            if front.len() <= overflow {
                let removed = self.batches.pop_front().expect("front batch should exist");
                let removed_len = removed.len();
                overflow -= removed_len;
                self.byte_count -= removed_len;
                self.dropped_bytes = self.dropped_bytes.saturating_add(removed_len as u64);
                self.dropped_through_seq = Some(removed.seq);
            } else {
                front.start += overflow;
                self.byte_count -= overflow;
                self.dropped_bytes = self.dropped_bytes.saturating_add(overflow as u64);
                self.dropped_through_seq = Some(front.seq);
                overflow = 0;
            }
        }
        self.byte_count += data.len();
        self.batches.push_back(BufferedOutput {
            seq,
            data: data.to_vec(),
            start: 0,
        });
    }

    fn snapshot(&self, after_seq: Option<u64>, baseline_reset: bool) -> OutputReplaySnapshot {
        let effective_after = (!baseline_reset).then_some(after_seq).flatten();
        let data_len = self
            .batches
            .iter()
            .filter(|batch| effective_after.is_none_or(|after| batch.seq > after))
            .map(BufferedOutput::len)
            .sum();
        let mut data = Vec::with_capacity(data_len);
        let mut first_seq = None;
        let mut last_seq = None;
        for batch in self
            .batches
            .iter()
            .filter(|batch| effective_after.is_none_or(|after| batch.seq > after))
        {
            first_seq.get_or_insert(batch.seq);
            last_seq = Some(batch.seq);
            data.extend_from_slice(batch.bytes());
        }
        let truncated = match effective_after {
            Some(after) => self
                .dropped_through_seq
                .is_some_and(|dropped| after < dropped),
            None => self.dropped_bytes > 0,
        };
        OutputReplaySnapshot {
            data,
            first_seq,
            last_seq,
            truncated,
            dropped_bytes: self.dropped_bytes,
        }
    }
}

#[derive(Default)]
pub struct TerminalState {
    processes: Mutex<HashMap<String, TerminalProcess>>,
    session_files: Mutex<()>,
}

type SharedTerminalOutput = Arc<Mutex<TerminalOutputState>>;

struct TerminalProcess {
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Option<Arc<TerminalWriter>>,
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
    process_id: Option<u32>,
    cwd: String,
    resume_path: Option<String>,
    pending_resume_path: Option<String>,
    session_lease: Option<SessionLease>,
    terminal_sessions_dir: PathBuf,
    breadcrumb_snapshot: HashMap<PathBuf, u128>,
    output: SharedTerminalOutput,
    exit_pending: bool,
    exited: bool,
    exit_code: Option<u32>,
    exit_success: bool,
    exit_error: Option<String>,
    thinking: bool,
    restartable: bool,
    switch_pending: bool,
    switch_input_buffer: Vec<u8>,
    switch_input_overflow_notified: bool,
    exit_waiter: Option<mpsc::Receiver<()>>,
    switch_generation: u64,
    switch_recovery: Option<SwitchInputRecovery>,
    #[cfg(windows)]
    _containment: WindowsJobObject,
}

struct TerminalOutputState {
    replay: OutputReplay,
    attachment_id: Option<String>,
    generation: u64,
    next_seq: u64,
    closed: bool,
}

struct PreparedTerminalAttachment {
    snapshot: OutputReplaySnapshot,
    generation: u64,
    next_seq: u64,
    baseline_reset: bool,
}

impl TerminalOutputState {
    fn new(generation: u64) -> Self {
        Self {
            replay: OutputReplay::default(),
            attachment_id: None,
            generation,
            next_seq: 1,
            closed: false,
        }
    }

    fn attach(
        &mut self,
        request: &TerminalAttachmentRequest,
    ) -> Result<PreparedTerminalAttachment, String> {
        if request.attachment_id.trim().is_empty() {
            return Err("[terminal_attachment_invalid] Пустой attachment id".to_owned());
        }
        if self.closed {
            return Err("Процесс OMP уже завершён".to_owned());
        }
        let baseline_reset = request.generation != Some(self.generation);
        if !baseline_reset
            && request
                .after_seq
                .is_some_and(|after| after >= self.next_seq)
        {
            return Err(format!(
                "[terminal_sequence_invalid] Sequence baseline {} опережает terminal {}",
                request.after_seq.unwrap_or_default(),
                self.next_seq.saturating_sub(1)
            ));
        }
        self.attachment_id = Some(request.attachment_id.clone());
        Ok(PreparedTerminalAttachment {
            snapshot: self.replay.snapshot(request.after_seq, baseline_reset),
            generation: self.generation,
            next_seq: self.next_seq,
            baseline_reset,
        })
    }

    fn detach(&mut self, attachment_id: &str) {
        if self.attachment_id.as_deref() == Some(attachment_id) {
            self.attachment_id = None;
        }
    }

    fn record(&mut self, data: &[u8]) -> Option<(u64, u64, bool)> {
        if self.closed {
            return None;
        }
        let seq = self.next_seq;
        self.next_seq = self.next_seq.saturating_add(1);
        self.replay.push(seq, data);
        Some((self.generation, seq, self.attachment_id.is_some()))
    }

    fn is_current_attachment(&self, generation: u64) -> bool {
        !self.closed && self.generation == generation && self.attachment_id.is_some()
    }

    fn has_attachment(&self) -> bool {
        !self.closed && self.attachment_id.is_some()
    }

    fn close(&mut self) {
        self.closed = true;
        self.attachment_id = None;
    }
}

impl Drop for TerminalProcess {
    fn drop(&mut self) {
        lock_terminal_output(&self.output).close();
        if let Some(writer) = self.writer.as_ref() {
            writer.close();
        }
        if !self.exited && !self.exit_pending {
            if let Some(killer) = self.killer.as_mut() {
                let _ = kill_terminal_process(killer.as_mut());
            }
        }
    }
}

pub(crate) struct PreparedSessionDeletion<'a> {
    canonical: String,
    key: String,
    root: PathBuf,
    _lease: SessionLease,
    _session_file_guard: std::sync::MutexGuard<'a, ()>,
}

impl PreparedSessionDeletion<'_> {
    pub(crate) fn key(&self) -> &str {
        &self.key
    }

    pub(crate) fn commit(self) -> Result<(), String> {
        crate::sessions::delete_session(&self.canonical, &self.root)
    }
}

impl TerminalState {
    pub fn shutdown_all(&self) {
        let processes = std::mem::take(&mut *lock_processes(self));
        drop(processes);
    }

    pub fn resource_processes(&self) -> Vec<(String, u32)> {
        lock_processes(self)
            .iter()
            .filter_map(|(terminal_id, process)| {
                (!process.exited && !process.exit_pending)
                    .then_some(process.process_id)
                    .flatten()
                    .map(|process_id| (terminal_id.clone(), process_id))
            })
            .collect()
    }
    fn is_session_active(&self, path: &str) -> bool {
        let key = path_key(path);
        lock_processes(self).values().any(|process| {
            !process.exited
                && process
                    .resume_path
                    .as_deref()
                    .is_some_and(|resume| path_key(resume) == key)
        })
    }

    pub(crate) fn prepare_inactive_session_deletion<'a>(
        &'a self,
        path: &str,
        root: &Path,
        force_session_lease: bool,
    ) -> Result<PreparedSessionDeletion<'a>, String> {
        let session_file_guard = lock_session_files(self);
        let session_path = validated_session_file(path, root)?;
        let canonical = session_path.to_string_lossy().into_owned();
        let key = path_key(&canonical);
        if self.is_session_active(&canonical) {
            return Err(format!(
                "[session_active_delete] Сессия используется активным терминалом: {canonical}"
            ));
        }
        let lease = SessionLease::acquire(
            &session_path,
            SessionLeasePurpose::Delete,
            force_session_lease,
        )?;
        Ok(PreparedSessionDeletion {
            canonical,
            key,
            root: root.to_path_buf(),
            _lease: lease,
            _session_file_guard: session_file_guard,
        })
    }

    #[allow(dead_code)]
    pub fn delete_inactive_session(
        &self,
        path: &str,
        root: &Path,
        force_session_lease: bool,
    ) -> Result<String, String> {
        let deletion = self.prepare_inactive_session_deletion(path, root, force_session_lease)?;
        let key = deletion.key().to_owned();
        deletion.commit()?;
        Ok(key)
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

fn lock_terminal_output(
    output: &SharedTerminalOutput,
) -> std::sync::MutexGuard<'_, TerminalOutputState> {
    output
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_session_files(state: &TerminalState) -> std::sync::MutexGuard<'_, ()> {
    state
        .session_files
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn try_lock_session_files(state: &TerminalState) -> Option<std::sync::MutexGuard<'_, ()>> {
    match state.session_files.try_lock() {
        Ok(guard) => Some(guard),
        Err(std::sync::TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
        Err(std::sync::TryLockError::WouldBlock) => None,
    }
}

fn kill_terminal_process(killer: &mut dyn ChildKiller) -> std::io::Result<()> {
    let result = killer.kill();
    #[cfg(windows)]
    if result
        .as_ref()
        .is_err_and(|error| error.raw_os_error() == Some(0))
    {
        // portable-pty 0.9.0 checks the Win32 TerminateProcess BOOL in reverse
        // for cloned killers. Upstream main fixes this, but no fixed crate exists yet.
        return Ok(());
    }
    result
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub cwd: String,
    pub resume_path: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub force_session_lease: bool,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimaryProviderPinRequest {
    pub terminal_id: String,
    pub pinned: bool,
}

const TERMINAL_STOP_TIMEOUT: Duration = Duration::from_secs(6);
const TERMINAL_RESTART_STOPPED_ERROR_CODE: &str = "terminal_restart_stopped";

fn terminal_restart_stopped_error(error: impl std::fmt::Display) -> String {
    format!("[{TERMINAL_RESTART_STOPPED_ERROR_CODE}] {error}")
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum SwitchInputRecoveryState {
    Pending,
    Sending,
    FailedSend,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchInputRecoveryMetadata {
    terminal_id: String,
    state: SwitchInputRecoveryState,
    generation: u64,
    byte_count: usize,
    token: String,
}

struct SwitchInputRecovery {
    state: SwitchInputRecoveryState,
    generation: u64,
    token: String,
    buffer: Vec<u8>,
}

impl SwitchInputRecovery {
    fn new(terminal_id: &str, generation: u64, buffer: Vec<u8>) -> Self {
        let nonce = NEXT_SWITCH_RECOVERY_TOKEN.fetch_add(1, Ordering::Relaxed);
        Self {
            state: SwitchInputRecoveryState::Pending,
            generation,
            token: format!("{terminal_id}-{generation:016x}-{nonce:016x}"),
            buffer,
        }
    }

    fn metadata(&self, terminal_id: &str) -> SwitchInputRecoveryMetadata {
        SwitchInputRecoveryMetadata {
            terminal_id: terminal_id.to_owned(),
            state: self.state,
            generation: self.generation,
            byte_count: self.buffer.len(),
            token: self.token.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSwitchError {
    code: String,
    message: String,
    recovery: Option<SwitchInputRecoveryMetadata>,
}

impl TerminalSwitchError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            code: code.to_owned(),
            message: crate::models::sanitize_error_text(&message),
            recovery: None,
        }
    }

    fn with_recovery(
        code: &str,
        message: impl Into<String>,
        recovery: SwitchInputRecoveryMetadata,
    ) -> Self {
        let message = message.into();
        Self {
            code: code.to_owned(),
            message: crate::models::sanitize_error_text(&message),
            recovery: Some(recovery),
        }
    }
}

impl From<String> for TerminalSwitchError {
    fn from(message: String) -> Self {
        Self::new("terminal_switch_failed", message)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchInputRecoveryRequest {
    terminal_id: String,
    generation: u64,
    token: String,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachmentRequest {
    terminal_id: String,
    attachment_id: String,
    generation: Option<u64>,
    after_seq: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDetachRequest {
    terminal_id: String,
    attachment_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachment {
    pub data: String,
    pub generation: u64,
    pub first_seq: Option<u64>,
    pub last_seq: Option<u64>,
    pub next_seq: u64,
    pub truncated: bool,
    pub dropped_bytes: u64,
    pub baseline_reset: bool,
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
    generation: u64,
    seq: u64,
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
    output: SharedTerminalOutput,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtySessionEvent {
    terminal_id: String,
    session: crate::models::SessionSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtySessionTitleEvent {
    terminal_id: String,
    title: String,
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

fn validated_resume_path(path: &str, session_root: &Path, cwd: &str) -> Result<String, String> {
    let path = validated_session_file(path, session_root)?;
    let session = parse_session(&path)?
        .ok_or_else(|| format!("В файле нет session header: {}", path.display()))?;
    if session.project_key != path_key(cwd) {
        return Err("Сессия принадлежит другой папке проекта".to_owned());
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn start_terminal(
    request: LaunchRequest,
    app: AppHandle,
) -> Result<TerminalStarted, crate::models::AppError> {
    crate::run_blocking(
        "запуска OMP",
        "terminal_start_failed",
        "Не удалось запустить OMP",
        move || start_terminal_blocking(request, app),
    )
    .await
}

fn start_terminal_blocking(
    request: LaunchRequest,
    app: AppHandle,
) -> Result<TerminalStarted, String> {
    let terminals = app.state::<TerminalState>();
    let settings_state = app.state::<SettingsState>();
    let settings = settings_snapshot(&app, &settings_state)?;
    let _session_file_guard = lock_session_files(&terminals);
    let cwd = canonical_project_path(&request.cwd)?;
    let cwd = cwd.to_string_lossy().into_owned();
    let session_root = crate::settings::session_root(&app, &settings)?;
    let resume_path = request
        .resume_path
        .as_deref()
        .map(|path| validated_resume_path(path, &session_root, &cwd))
        .transpose()?;

    let omp = resolve_omp(&app, &settings);
    if omp.version.is_none() {
        return Err(format!(
            "OMP не найден. Проверьте путь к исполняемому файлу в настройках: {}",
            omp.executable
        ));
    }

    let restartable = request.args.as_ref().is_none_or(Vec::is_empty);
    let proxy_overlay = if restartable {
        ensure_proxy_provider_overlay(&app, &settings.proxy_providers)?
    } else {
        None
    };
    let pin_overlay = if restartable
        && resume_path.as_deref().is_some_and(|path| {
            settings.primary_provider_pins.contains(&path_key(path))
                || settings.primary_provider_pins.contains(path)
        }) {
        Some(ensure_primary_provider_pin_overlay(&app)?)
    } else {
        None
    };
    let config_paths = [proxy_overlay, pin_overlay]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let args = if restartable {
        initial_agent_args_with_config(&cwd, resume_path.as_deref(), &config_paths)
    } else {
        request.args.unwrap_or_default()
    };
    spawn_terminal_process(
        &app,
        &terminals,
        &omp.executable,
        &settings.provider_env,
        cwd,
        resume_path,
        args,
        PtySize {
            rows: request.rows.clamp(5, 300),
            cols: request.cols.clamp(20, 500),
            pixel_width: 0,
            pixel_height: 0,
        },
        restartable,
        request.force_session_lease,
    )
}

#[tauri::command]
pub async fn set_terminal_primary_provider_pin(
    request: PrimaryProviderPinRequest,
    app: AppHandle,
) -> Result<TerminalStarted, crate::models::AppError> {
    crate::run_blocking(
        "перезапуска сессии с фиксацией провайдера",
        "terminal_provider_pin_failed",
        "Не удалось перезапустить сессию",
        move || set_terminal_primary_provider_pin_blocking(request, app),
    )
    .await
}

fn set_terminal_primary_provider_pin_blocking(
    request: PrimaryProviderPinRequest,
    app: AppHandle,
) -> Result<TerminalStarted, String> {
    let terminals = app.state::<TerminalState>();
    let settings_state = app.state::<SettingsState>();
    let (known_resume_path, cwd, terminal_sessions_dir, breadcrumb_snapshot) = {
        let processes = lock_processes(&terminals);
        let process = processes
            .get(&request.terminal_id)
            .ok_or_else(|| format!("Терминал не найден: {}", request.terminal_id))?;
        if !process.restartable {
            return Err("Эта служебная вкладка не поддерживает фиксацию провайдера".to_owned());
        }
        if process.switch_pending {
            return Err("Сначала дождитесь завершения смены модели".to_owned());
        }
        if process.switch_recovery.is_some() {
            return Err("Сначала отправьте или удалите сохранённый ввод".to_owned());
        }
        if process.thinking {
            return Err("Дождитесь завершения текущего запроса".to_owned());
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

    with_settings_transaction(&app, &settings_state, |transaction| {
        let settings = transaction.candidate().clone();
        let session_root = crate::settings::session_root(&app, &settings)?;
        let resume_path = known_resume_path
            .clone()
            .or_else(|| {
                resolve_resume_path(
                    &request.terminal_id,
                    &cwd,
                    &terminal_sessions_dir,
                    &breadcrumb_snapshot,
                )
            })
            .ok_or_else(|| "Сессия OMP ещё не готова к перезапуску".to_owned())?;
        let resume_path = validated_resume_path(&resume_path, &session_root, &cwd)?;
        if !Path::new(&resume_path).is_file() {
            return Err(format!("Файл сессии не найден: {resume_path}"));
        }

        let omp = resolve_omp(&app, &settings);
        if omp.version.is_none() {
            return Err(format!(
                "OMP не найден. Проверьте путь к исполняемому файлу в настройках: {}",
                omp.executable
            ));
        }
        let mut config_paths = ensure_proxy_provider_overlay(&app, &settings.proxy_providers)?
            .into_iter()
            .collect::<Vec<_>>();
        if request.pinned {
            config_paths.push(ensure_primary_provider_pin_overlay(&app)?);
        }
        let args = initial_agent_args_with_config(&cwd, Some(&resume_path), &config_paths);

        let _session_file_guard = lock_session_files(&terminals);
        stop_terminal_for_restart(&request.terminal_id, &terminals)?;
        let started = spawn_terminal_process(
            &app,
            &terminals,
            &omp.executable,
            &settings.provider_env,
            cwd.clone(),
            Some(resume_path.clone()),
            args,
            PtySize {
                rows: 36,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            },
            true,
            false,
        )
        .map_err(terminal_restart_stopped_error)?;

        let mut next = settings;
        let session_key = path_key(&resume_path);
        crate::sessions::remove_session_primary_provider_pin(
            &session_key,
            &mut next.primary_provider_pins,
        );
        if request.pinned {
            next.primary_provider_pins.insert(session_key);
        }
        if let Err(error) = save_settings(&app, &next) {
            let cleanup = stop_terminal_for_restart(&started.terminal_id, &terminals).err();
            let detail = match cleanup {
                Some(cleanup) => {
                    format!("{error}; не удалось остановить незаписанный restart: {cleanup}")
                }
                None => error,
            };
            return Err(terminal_restart_stopped_error(detail));
        }
        *transaction.candidate_mut() = next;
        Ok(started)
    })
}

#[tauri::command]
pub async fn switch_terminal(
    request: SwitchRequest,
    app: AppHandle,
) -> Result<TerminalRuntime, TerminalSwitchError> {
    tauri::async_runtime::spawn_blocking(move || switch_terminal_blocking(request, app))
        .await
        .map_err(|error| {
            TerminalSwitchError::new(
                "backend_join_failed",
                format!("Не удалось дождаться переключения модели: {error}"),
            )
        })?
}

fn switch_terminal_blocking(
    request: SwitchRequest,
    app: AppHandle,
) -> Result<TerminalRuntime, TerminalSwitchError> {
    validate_switch_request(&request).map_err(TerminalSwitchError::from)?;
    let terminals = app.state::<TerminalState>();
    let (known_resume_path, cwd, terminal_sessions_dir, breadcrumb_snapshot) = {
        let processes = lock_processes(&terminals);
        let process = processes.get(&request.terminal_id).ok_or_else(|| {
            TerminalSwitchError::new(
                "terminal_switch_failed",
                format!("Терминал не найден: {}", request.terminal_id),
            )
        })?;
        if !process.restartable {
            return Err(TerminalSwitchError::new(
                "terminal_switch_failed",
                "Эта служебная вкладка не поддерживает смену модели",
            ));
        }
        if process.switch_pending {
            return Err(TerminalSwitchError::new(
                "terminal_switch_busy",
                "Смена модели уже выполняется",
            ));
        }
        if let Some(recovery) = process.switch_recovery.as_ref() {
            return Err(TerminalSwitchError::with_recovery(
                "terminal_switch_recovery_pending",
                "Сначала отправьте или удалите сохранённый ввод",
                recovery.metadata(&request.terminal_id),
            ));
        }
        if process.exited || process.exit_pending {
            return Err(TerminalSwitchError::new(
                "terminal_switch_failed",
                "Процесс OMP уже завершён",
            ));
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
        .ok_or_else(|| {
            TerminalSwitchError::new(
                "terminal_switch_failed",
                "Сессия OMP ещё не готова к переключению",
            )
        })?;
    if !Path::new(&resume_path).is_file() {
        return Err(TerminalSwitchError::new(
            "terminal_switch_failed",
            format!("Файл сессии не найден: {resume_path}"),
        ));
    }

    let should_spawn_runtime_watcher = {
        let mut processes = lock_processes(&terminals);
        let process = processes.get_mut(&request.terminal_id).ok_or_else(|| {
            TerminalSwitchError::new(
                "terminal_switch_failed",
                format!("Терминал не найден: {}", request.terminal_id),
            )
        })?;
        if process.switch_pending {
            return Err(TerminalSwitchError::new(
                "terminal_switch_busy",
                "Смена модели уже выполняется",
            ));
        }
        if let Some(recovery) = process.switch_recovery.as_ref() {
            return Err(TerminalSwitchError::with_recovery(
                "terminal_switch_recovery_pending",
                "Сначала отправьте или удалите сохранённый ввод",
                recovery.metadata(&request.terminal_id),
            ));
        }
        if process.exited || process.exit_pending {
            return Err(TerminalSwitchError::new(
                "terminal_switch_failed",
                "Процесс OMP уже завершён",
            ));
        }
        let next_generation = process.switch_generation.checked_add(1).ok_or_else(|| {
            TerminalSwitchError::new(
                "terminal_switch_failed",
                "Исчерпан счётчик поколений смены модели",
            )
        })?;
        let should_spawn = process.resume_path.is_none();
        process.resume_path = Some(resume_path.clone());
        process.switch_pending = true;
        process.switch_generation = next_generation;
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

    finalize_switch_result(
        &request.terminal_id,
        &terminals,
        perform_terminal_switch(&request, &resume_path, &terminals),
    )
}

fn finalize_switch_result<T>(
    terminal_id: &str,
    terminals: &TerminalState,
    result: Result<T, String>,
) -> Result<T, TerminalSwitchError> {
    match result {
        Ok(value) => {
            finish_successful_switch_input(terminal_id, terminals)?;
            Ok(value)
        }
        Err(error) => Err(fail_switch_input(terminal_id, terminals, error)),
    }
}

fn fail_switch_input(
    terminal_id: &str,
    terminals: &TerminalState,
    message: String,
) -> TerminalSwitchError {
    let mut processes = lock_processes(terminals);
    let Some(process) = processes.get_mut(terminal_id) else {
        return TerminalSwitchError::new("terminal_switch_failed", message);
    };
    process.switch_pending = false;
    process.switch_input_overflow_notified = false;
    let buffered = std::mem::take(&mut process.switch_input_buffer);
    if buffered.is_empty() {
        return TerminalSwitchError::new("terminal_switch_failed", message);
    }

    let recovery = SwitchInputRecovery::new(terminal_id, process.switch_generation, buffered);
    let metadata = recovery.metadata(terminal_id);
    process.switch_recovery = Some(recovery);
    TerminalSwitchError::with_recovery("terminal_switch_input_recovery", message, metadata)
}

fn finish_successful_switch_input(
    terminal_id: &str,
    terminals: &TerminalState,
) -> Result<(), TerminalSwitchError> {
    let (writer, completion, generation, token) = {
        let mut processes = lock_processes(terminals);
        let process = processes.get_mut(terminal_id).ok_or_else(|| {
            TerminalSwitchError::new(
                "terminal_switch_failed",
                format!("Терминал не найден: {terminal_id}"),
            )
        })?;
        let buffered = std::mem::take(&mut process.switch_input_buffer);
        process.switch_pending = false;
        process.switch_input_overflow_notified = false;
        if buffered.is_empty() {
            return Ok(());
        }

        let mut recovery =
            SwitchInputRecovery::new(terminal_id, process.switch_generation, buffered);
        let writer = match process.writer.clone() {
            Some(writer) => writer,
            None => {
                let metadata = recovery.metadata(terminal_id);
                process.switch_recovery = Some(recovery);
                return Err(TerminalSwitchError::with_recovery(
                    "terminal_switch_input_recovery",
                    "Процесс OMP завершился до отправки сохранённого ввода",
                    metadata,
                ));
            }
        };
        let completion = match writer.enqueue_request(recovery.buffer.clone(), true) {
            Ok(Some(completion)) => completion,
            Ok(None) => unreachable!("confirmed PTY request must return a completion receiver"),
            Err(error) => {
                let metadata = recovery.metadata(terminal_id);
                process.switch_recovery = Some(recovery);
                return Err(TerminalSwitchError::with_recovery(
                    "terminal_switch_input_recovery",
                    format!("Не удалось поставить сохранённый ввод в очередь: {error}"),
                    metadata,
                ));
            }
        };
        recovery.state = SwitchInputRecoveryState::Sending;
        let generation = recovery.generation;
        let token = recovery.token.clone();
        process.switch_recovery = Some(recovery);
        (writer, completion, generation, token)
    };

    let result = writer.wait_for_completion(completion);
    let mut processes = lock_processes(terminals);
    let process = processes.get_mut(terminal_id).ok_or_else(|| {
        TerminalSwitchError::new(
            "terminal_switch_failed",
            "Терминал был закрыт во время отправки сохранённого ввода",
        )
    })?;
    let Some(recovery) = process.switch_recovery.as_mut() else {
        return Err(TerminalSwitchError::new(
            "terminal_switch_recovery_stale",
            "Состояние сохранённого ввода уже изменилось",
        ));
    };
    if recovery.generation != generation || recovery.token != token {
        return Err(TerminalSwitchError::new(
            "terminal_switch_recovery_stale",
            "Состояние сохранённого ввода уже изменилось",
        ));
    }
    match result {
        Ok(()) => {
            process.switch_recovery = None;
            Ok(())
        }
        Err(error) => {
            recovery.state = SwitchInputRecoveryState::FailedSend;
            let metadata = recovery.metadata(terminal_id);
            Err(TerminalSwitchError::with_recovery(
                "terminal_switch_recovery_send_failed",
                format!("Не удалось отправить сохранённый ввод: {error}"),
                metadata,
            ))
        }
    }
}

#[tauri::command]
pub async fn send_switch_input_recovery(
    request: SwitchInputRecoveryRequest,
    app: AppHandle,
) -> Result<(), TerminalSwitchError> {
    tauri::async_runtime::spawn_blocking(move || {
        let terminals = app.state::<TerminalState>();
        send_switch_input_recovery_blocking(&request, &terminals)
    })
    .await
    .map_err(|error| {
        TerminalSwitchError::new(
            "backend_join_failed",
            format!("Не удалось дождаться отправки сохранённого ввода: {error}"),
        )
    })?
}

fn send_switch_input_recovery_blocking(
    request: &SwitchInputRecoveryRequest,
    terminals: &TerminalState,
) -> Result<(), TerminalSwitchError> {
    let (writer, completion) = {
        let mut processes = lock_processes(terminals);
        let process = processes.get_mut(&request.terminal_id).ok_or_else(|| {
            TerminalSwitchError::new(
                "terminal_switch_recovery_stale",
                format!("Терминал не найден: {}", request.terminal_id),
            )
        })?;
        let writer = process.writer.clone().ok_or_else(|| {
            TerminalSwitchError::new("terminal_switch_recovery_stale", "Процесс OMP уже завершён")
        })?;
        let recovery = process.switch_recovery.as_mut().ok_or_else(|| {
            TerminalSwitchError::new(
                "terminal_switch_recovery_stale",
                "Сохранённый ввод уже обработан",
            )
        })?;
        if recovery.generation != request.generation || recovery.token != request.token {
            return Err(TerminalSwitchError::with_recovery(
                "terminal_switch_recovery_stale",
                "Состояние сохранённого ввода уже изменилось",
                recovery.metadata(&request.terminal_id),
            ));
        }
        if recovery.state != SwitchInputRecoveryState::Pending {
            return Err(TerminalSwitchError::with_recovery(
                "terminal_switch_recovery_stale",
                "Повторная отправка сохранённого ввода запрещена",
                recovery.metadata(&request.terminal_id),
            ));
        }

        recovery.state = SwitchInputRecoveryState::Sending;
        let completion = match writer.enqueue_request(recovery.buffer.clone(), true) {
            Ok(Some(completion)) => completion,
            Ok(None) => unreachable!("confirmed PTY request must return a completion receiver"),
            Err(error) => {
                recovery.state = SwitchInputRecoveryState::FailedSend;
                return Err(TerminalSwitchError::with_recovery(
                    "terminal_switch_recovery_send_failed",
                    format!("Не удалось поставить сохранённый ввод в очередь: {error}"),
                    recovery.metadata(&request.terminal_id),
                ));
            }
        };
        (writer, completion)
    };

    let result = writer.wait_for_completion(completion);
    let mut processes = lock_processes(terminals);
    let process = processes.get_mut(&request.terminal_id).ok_or_else(|| {
        TerminalSwitchError::new(
            "terminal_switch_recovery_stale",
            "Терминал был закрыт во время отправки сохранённого ввода",
        )
    })?;
    let Some(recovery) = process.switch_recovery.as_mut() else {
        return Err(TerminalSwitchError::new(
            "terminal_switch_recovery_stale",
            "Сохранённый ввод уже обработан",
        ));
    };
    if recovery.generation != request.generation || recovery.token != request.token {
        return Err(TerminalSwitchError::new(
            "terminal_switch_recovery_stale",
            "Состояние сохранённого ввода уже изменилось",
        ));
    }
    match result {
        Ok(()) => {
            process.switch_recovery = None;
            Ok(())
        }
        Err(error) => {
            recovery.state = SwitchInputRecoveryState::FailedSend;
            Err(TerminalSwitchError::with_recovery(
                "terminal_switch_recovery_send_failed",
                format!("Не удалось отправить сохранённый ввод: {error}"),
                recovery.metadata(&request.terminal_id),
            ))
        }
    }
}

#[tauri::command]
pub fn discard_switch_input_recovery(
    request: SwitchInputRecoveryRequest,
    terminals: State<'_, TerminalState>,
) -> Result<(), TerminalSwitchError> {
    discard_switch_input_recovery_from_state(&request, &terminals)
}

fn discard_switch_input_recovery_from_state(
    request: &SwitchInputRecoveryRequest,
    terminals: &TerminalState,
) -> Result<(), TerminalSwitchError> {
    let mut processes = lock_processes(terminals);
    let process = processes.get_mut(&request.terminal_id).ok_or_else(|| {
        TerminalSwitchError::new(
            "terminal_switch_recovery_stale",
            format!("Терминал не найден: {}", request.terminal_id),
        )
    })?;
    let recovery = process.switch_recovery.as_ref().ok_or_else(|| {
        TerminalSwitchError::new(
            "terminal_switch_recovery_stale",
            "Сохранённый ввод уже обработан",
        )
    })?;
    if recovery.generation != request.generation || recovery.token != request.token {
        return Err(TerminalSwitchError::with_recovery(
            "terminal_switch_recovery_stale",
            "Состояние сохранённого ввода уже изменилось",
            recovery.metadata(&request.terminal_id),
        ));
    }
    if recovery.state == SwitchInputRecoveryState::Sending {
        return Err(TerminalSwitchError::with_recovery(
            "terminal_switch_recovery_busy",
            "Отправка сохранённого ввода уже выполняется",
            recovery.metadata(&request.terminal_id),
        ));
    }
    process.switch_recovery = None;
    Ok(())
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
        write_switch_input(&request.terminal_id, input, terminals)?;
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
    let current = normalize_thinking_level(current, &levels);
    let current_index = levels
        .iter()
        .position(|level| level == current)
        .ok_or_else(|| format!("Неизвестный текущий уровень рассуждений: {current}"))?;
    let steps = (target_index + levels.len() - current_index) % levels.len();

    for step in 1..=steps {
        let expected = levels[(current_index + step) % levels.len()].clone();
        write_switch_input(terminal_id, OMP_THINKING_CYCLE_ESC.to_vec(), terminals)?;
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

fn normalize_thinking_level<'a>(level: &str, levels: &'a [String]) -> &'a str {
    let normalized = if level == "inherit" { "off" } else { level };
    if let Some(exact) = levels
        .iter()
        .find(|candidate| candidate.as_str() == normalized)
    {
        return exact;
    }
    let Some(target_rank) = THINKING_LEVELS
        .iter()
        .position(|candidate| *candidate == normalized)
    else {
        return levels.first().map(String::as_str).unwrap_or("off");
    };
    levels
        .iter()
        .filter_map(|candidate| {
            let rank = THINKING_LEVELS
                .iter()
                .position(|known| *known == candidate.as_str())?;
            if matches!(candidate.as_str(), "off" | "auto") {
                return None;
            }
            Some((candidate.as_str(), rank.abs_diff(target_rank), rank))
        })
        .min_by_key(|(_, distance, rank)| (*distance, *rank))
        .map(|(candidate, _, _)| candidate)
        .unwrap_or_else(|| levels.first().map(String::as_str).unwrap_or("off"))
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
    data: Vec<u8>,
    terminals: &TerminalState,
) -> Result<(), String> {
    let writer = {
        let processes = lock_processes(terminals);
        let process = processes
            .get(terminal_id)
            .ok_or_else(|| format!("Терминал не найден: {terminal_id}"))?;
        if process.exited || process.exit_pending {
            return Err("Процесс OMP уже завершён".to_owned());
        }
        process
            .writer
            .clone()
            .ok_or_else(|| "Процесс OMP уже завершён".to_owned())?
    };
    writer
        .enqueue(data, true)
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

/// Converts native Windows paths at the OMP CLI boundary. `CommandBuilder::cwd`
/// intentionally keeps the native path because it is consumed by CreateProcess,
/// while Bun receives the forward-slash form through `--cwd`, `--config`, and `--resume`.
fn cli_path_arg(path: &str) -> String {
    #[cfg(windows)]
    {
        let normalized = normalize_windows_verbatim_path(PathBuf::from(path));
        normalized.to_string_lossy().replace('\\', "/")
    }
    #[cfg(not(windows))]
    {
        path.to_owned()
    }
}

fn initial_agent_args_with_config(
    cwd: &str,
    resume_path: Option<&str>,
    config_paths: &[PathBuf],
) -> Vec<String> {
    let mut args = vec!["--cwd".to_owned(), cli_path_arg(cwd)];
    for config_path in config_paths {
        args.push("--config".to_owned());
        args.push(cli_path_arg(&config_path.to_string_lossy()));
    }
    if let Some(resume_path) = resume_path {
        args.push("--resume".to_owned());
        args.push(cli_path_arg(resume_path));
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
    // OMP does not identify Desktop's xterm renderer automatically. Advertise
    // OSC 8 support without overriding explicit runtime hyperlink opt-outs.
    if command.get_env("PI_FORCE_HYPERLINKS").is_none() {
        command.env("PI_FORCE_HYPERLINKS", "1");
    }
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
    force_session_lease: bool,
) -> Result<TerminalStarted, String> {
    let terminal_id = format!(
        "terminal-{}-{}",
        std::process::id(),
        NEXT_TERMINAL_ID.fetch_add(1, Ordering::Relaxed)
    );
    let terminal_sessions_dir = terminal_sessions_dir(app)?;
    let breadcrumb_snapshot = snapshot_breadcrumbs(&terminal_sessions_dir);
    let session_lease = if restartable {
        resume_path
            .as_deref()
            .map(|path| {
                SessionLease::acquire(
                    Path::new(path),
                    SessionLeasePurpose::Resume,
                    force_session_lease,
                )
            })
            .transpose()?
    } else {
        None
    };
    let command = build_omp_command(executable, &cwd, &terminal_id, provider_env, &args);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|error| format!("Не удалось создать PTY: {error}"))?;
    #[cfg(windows)]
    let containment = match WindowsJobObject::new() {
        Ok(job) => job,
        Err(error) => {
            let os_code = error.raw_os_error().unwrap_or(-1);
            crate::diagnostics::warn(
                "windows_job.create",
                &format!("CreateJobObject failed (code {os_code}): {error}"),
            );
            return Err(format!(
                "Не удалось создать Windows Job Object для изоляции OMP (код {os_code}: {error}). \
                 Проверьте политики безопасности Windows, ограничения прав или настройки антивируса/EDR."
            ));
        }
    };
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Не удалось запустить OMP: {error}"))?;
    #[cfg(windows)]
    {
        let process_handle = child.as_raw_handle().ok_or_else(|| {
            "Не удалось получить Windows process handle для containment OMP".to_owned()
        })?;
        if let Err(error) = containment.assign(process_handle) {
            let os_code = error.raw_os_error().unwrap_or(-1);
            let _ = child.kill();
            crate::diagnostics::warn(
                "windows_job.assign",
                &format!("AssignProcessToJobObject failed (code {os_code}): {error}"),
            );
            let hint = if os_code == 5 {
                " (ERROR_ACCESS_DENIED: возможно, процесс уже входит в сторонний Job Object или ограничен политиками окружения)"
            } else {
                ""
            };
            return Err(format!(
                "Не удалось назначить OMP в Windows Job Object (код {os_code}: {error}){hint}. \
                 Запуск отклонён для предотвращения появления неуправляемых фоновых процессов."
            ));
        }
    }
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
    let writer_error_app = app.clone();
    let writer_error_terminal_id = terminal_id.clone();
    let writer = match spawn_terminal_writer(&terminal_id, writer, move |error| {
        emit_runtime_error(&writer_error_app, &writer_error_terminal_id, error);
    }) {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            return Err(error);
        }
    };
    let runtime_session_path = resume_path.clone();
    let (exit_sender, exit_receiver) = mpsc::sync_channel(1);
    let output = Arc::new(Mutex::new(TerminalOutputState::new(
        NEXT_OUTPUT_GENERATION.fetch_add(1, Ordering::Relaxed),
    )));

    let process = TerminalProcess {
        master: Some(pair.master),
        writer: Some(writer),
        killer: Some(killer),
        process_id,
        cwd: cwd.clone(),
        resume_path,
        pending_resume_path: None,
        session_lease,
        terminal_sessions_dir,
        breadcrumb_snapshot,
        output: output.clone(),
        exit_pending: false,
        exited: false,
        exit_code: None,
        exit_success: false,
        exit_error: None,
        thinking: false,
        restartable,
        switch_pending: false,
        switch_input_buffer: Vec::new(),
        switch_input_overflow_notified: false,
        exit_waiter: Some(exit_receiver),
        switch_generation: 0,
        switch_recovery: None,
        #[cfg(windows)]
        _containment: containment,
    };
    lock_processes(terminals).insert(terminal_id.clone(), process);
    let output_exit = match spawn_reader(
        app.clone(),
        terminal_id.clone(),
        output,
        reader,
        exit_sender,
    ) {
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
        }
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
    resolve_resume_path_for_current(terminal_id, cwd, directory, snapshot, None)
}

fn resolve_resume_path_for_current(
    terminal_id: &str,
    cwd: &str,
    directory: &Path,
    snapshot: &HashMap<PathBuf, u128>,
    current_path: Option<&str>,
) -> Option<String> {
    let direct = directory.join(format!("{BREADCRUMB_FILE_PREFIX}{terminal_id}"));
    if !breadcrumb_changed(&direct, snapshot) {
        return None;
    }
    let path = read_breadcrumb(&direct, cwd)?;
    if current_path.is_some_and(|current| path_key(current) == path_key(&path)) {
        return None;
    }
    Some(path)
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
    let fresh = lines.next().is_some_and(|marker| marker.trim() == "fresh");
    if path_key(breadcrumb_cwd) != path_key(cwd) || (!fresh && !Path::new(session_path).is_file()) {
        return None;
    }
    Some(session_path.to_owned())
}

enum SessionDiscovery {
    PendingFresh {
        resume_path: String,
    },
    Ready {
        resume_path: String,
        session: Box<crate::models::SessionSummary>,
    },
}

fn discover_session(
    terminal_id: &str,
    cwd: &str,
    directory: &Path,
    snapshot: &HashMap<PathBuf, u128>,
    current_path: Option<&str>,
) -> Option<SessionDiscovery> {
    let resume_path =
        resolve_resume_path_for_current(terminal_id, cwd, directory, snapshot, current_path)?;
    if !Path::new(&resume_path).is_file() {
        return Some(SessionDiscovery::PendingFresh { resume_path });
    }
    let session = parse_session(Path::new(&resume_path)).ok().flatten()?;
    Some(SessionDiscovery::Ready {
        resume_path,
        session: Box::new(session),
    })
}

fn apply_known_session_title_pin(app: &AppHandle, session: &mut crate::models::SessionSummary) {
    let settings_state = app.state::<SettingsState>();
    let Ok(settings) = settings_snapshot(app, &settings_state) else {
        return;
    };
    apply_session_title_pin(session, &settings.session_title_pins);
    apply_session_primary_provider_pin(session, &settings.primary_provider_pins);
}

fn apply_handoff_session_titles(
    app: &AppHandle,
    previous_path: &str,
    active_path: &str,
    active_session: &mut crate::models::SessionSummary,
) -> Result<(), String> {
    let settings_state = app.state::<SettingsState>();
    let terminals = app.state::<TerminalState>();
    with_settings_transaction(app, &settings_state, |transaction| {
        let _session_file_guard = lock_session_files(&terminals);
        let root = crate::settings::session_root(app, transaction.candidate())?;
        let previous_path = validated_session_file(previous_path, &root)?;
        let active_path = validated_session_file(active_path, &root)?;
        if path_key(previous_path.to_string_lossy().as_ref())
            == path_key(active_path.to_string_lossy().as_ref())
        {
            apply_session_title_pin(active_session, &transaction.candidate().session_title_pins);
            apply_session_primary_provider_pin(
                active_session,
                &transaction.candidate().primary_provider_pins,
            );
            return Ok(());
        }

        let mut previous_session = parse_session(&previous_path)?
            .ok_or_else(|| format!("В файле нет session header: {}", previous_path.display()))?;
        apply_session_title_pin(
            &mut previous_session,
            &transaction.candidate().session_title_pins,
        );
        let archive_label = if transaction.candidate().language == "en" {
            "archive"
        } else {
            "архив"
        };
        let previous_path_string = previous_path.to_string_lossy().into_owned();
        let active_path_string = active_path.to_string_lossy().into_owned();
        {
            let candidate = transaction.candidate_mut();
            apply_handoff_title_pins(
                &previous_path_string,
                &active_path_string,
                &previous_session.title,
                &mut candidate.session_title_pins,
                archive_label,
            )?;
            transfer_session_primary_provider_pin(
                &previous_path_string,
                &active_path_string,
                &mut candidate.primary_provider_pins,
            );
        }
        let next = transaction.candidate().clone();
        crate::settings::save_settings(app, &next)?;
        apply_session_title_pin(active_session, &next.session_title_pins);
        apply_session_primary_provider_pin(active_session, &next.primary_provider_pins);
        Ok(())
    })
}

enum ResumePathPoll {
    Stop,
    Continue,
    LeaseFailed(String),
    Discovered {
        resume_path: String,
        previous_path: Option<String>,
        previous_lease: Option<SessionLease>,
        session: Box<crate::models::SessionSummary>,
    },
}

fn cache_resume_path(app: &AppHandle, terminal_id: &str) -> bool {
    let state = app.state::<TerminalState>();
    let poll = {
        let _session_file_guard = lock_session_files(&state);
        poll_resume_path_locked(terminal_id, &state)
    };
    finish_resume_path_poll(app, terminal_id, poll)
}

fn poll_resume_path_locked(terminal_id: &str, state: &TerminalState) -> ResumePathPoll {
    let context = {
        let processes = lock_processes(state);
        let Some(process) = processes.get(terminal_id) else {
            return ResumePathPoll::Stop;
        };
        if !process.restartable || process.exited || process.exit_pending {
            return ResumePathPoll::Stop;
        }
        (
            process.cwd.clone(),
            process.terminal_sessions_dir.clone(),
            process.breadcrumb_snapshot.clone(),
            process.resume_path.clone(),
        )
    };
    let Some(discovery) = discover_session(
        terminal_id,
        &context.0,
        &context.1,
        &context.2,
        context.3.as_deref(),
    ) else {
        return ResumePathPoll::Continue;
    };
    let (resume_path, session) = match discovery {
        SessionDiscovery::PendingFresh { resume_path } => {
            let mut processes = lock_processes(state);
            let Some(process) = processes.get_mut(terminal_id) else {
                return ResumePathPoll::Stop;
            };
            if !process.restartable || process.exited || process.exit_pending {
                return ResumePathPoll::Stop;
            }
            if process.pending_resume_path.as_deref() != Some(resume_path.as_str()) {
                process.pending_resume_path = Some(resume_path);
            }
            return ResumePathPoll::Continue;
        }
        SessionDiscovery::Ready {
            resume_path,
            session,
        } => (resume_path, session),
    };
    let session_lease = match SessionLease::acquire(
        Path::new(&resume_path),
        SessionLeasePurpose::RuntimeDiscovered,
        false,
    ) {
        Ok(lease) => lease,
        Err(error) => return ResumePathPoll::LeaseFailed(error),
    };

    let (previous_path, previous_lease) = {
        let mut processes = lock_processes(state);
        let Some(process) = processes.get_mut(terminal_id) else {
            return ResumePathPoll::Stop;
        };
        if !process.restartable || process.exited || process.exit_pending {
            return ResumePathPoll::Stop;
        }
        if process
            .resume_path
            .as_deref()
            .is_some_and(|current| path_key(current) == path_key(&resume_path))
        {
            return ResumePathPoll::Continue;
        }
        process.pending_resume_path = None;
        (
            process.resume_path.replace(resume_path.clone()),
            process.session_lease.replace(session_lease),
        )
    };

    ResumePathPoll::Discovered {
        resume_path,
        previous_path,
        previous_lease,
        session,
    }
}

fn finish_resume_path_poll(app: &AppHandle, terminal_id: &str, poll: ResumePathPoll) -> bool {
    let (resume_path, previous_path, previous_lease, mut session) = match poll {
        ResumePathPoll::Stop => return true,
        ResumePathPoll::Continue => return false,
        ResumePathPoll::LeaseFailed(error) => {
            emit_runtime_error(app, terminal_id, error);
            let state = app.state::<TerminalState>();
            if let Some(process) = lock_processes(&state).get_mut(terminal_id) {
                if let Some(killer) = process.killer.as_mut() {
                    let _ = kill_terminal_process(killer.as_mut());
                }
            }
            return true;
        }
        ResumePathPoll::Discovered {
            resume_path,
            previous_path,
            previous_lease,
            session,
        } => (resume_path, previous_path, previous_lease, *session),
    };

    if let Some(previous_path) = previous_path.as_deref() {
        if let Err(error) =
            apply_handoff_session_titles(app, previous_path, &resume_path, &mut session)
        {
            apply_known_session_title_pin(app, &mut session);
            emit_runtime_error(
                app,
                terminal_id,
                format!("Не удалось сохранить названия handoff-сессий: {error}"),
            );
        }
    } else {
        apply_known_session_title_pin(app, &mut session);
    }
    drop(previous_lease);

    let _ = app.emit(
        "pty-session",
        PtySessionEvent {
            terminal_id: terminal_id.to_owned(),
            session,
        },
    );
    spawn_runtime_watcher(app.clone(), terminal_id.to_owned(), resume_path);
    false
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
    #[cfg(windows)]
    file_id: Option<(u32, u64)>,
    #[cfg(windows)]
    creation_time: u64,
    #[cfg(all(not(unix), not(windows)))]
    created_at: Option<u128>,
}

impl RuntimeFileIdentity {
    fn from_file(_file: &fs::File, metadata: &fs::Metadata) -> Self {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;

            Self {
                device: metadata.dev(),
                inode: metadata.ino(),
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            use std::{mem::MaybeUninit, os::windows::io::AsRawHandle};
            use windows_sys::Win32::Storage::FileSystem::{
                GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            };

            let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
            let file_id = if unsafe {
                GetFileInformationByHandle(_file.as_raw_handle(), information.as_mut_ptr())
            } == 0
            {
                None
            } else {
                let information = unsafe { information.assume_init() };
                Some((
                    information.dwVolumeSerialNumber,
                    (u64::from(information.nFileIndexHigh) << 32)
                        | u64::from(information.nFileIndexLow),
                ))
            };
            Self {
                file_id,
                creation_time: metadata.creation_time(),
            }
        }
        #[cfg(all(not(unix), not(windows)))]
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

impl RuntimeLineCheckpoint {
    fn matches(&self, other: &Self) -> bool {
        self.timestamp_nanos == other.timestamp_nanos && self.key.matches(&other.key)
    }
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
    initialized: bool,
    offset: u64,
    identity: Option<RuntimeFileIdentity>,
    anchor: Vec<u8>,
    line: Vec<u8>,
    line_overflow: bool,
    checkpoint: Option<RuntimeLineCheckpoint>,
    watermark: RuntimeEventWatermark,
    baseline_session_title: Option<String>,
    baseline_fallback_title: Option<String>,
}

struct RuntimeFileScan {
    file: fs::File,
    scanned_length: u64,
    current_length: u64,
}

#[derive(Clone)]
enum RuntimeRecoveryFilter {
    Watermark(RuntimeEventWatermark),
    Checkpoint(RuntimeEventWatermark),
}

impl RuntimeRecoveryFilter {
    fn should_emit(&self, candidate: Option<&RuntimeLineCheckpoint>) -> bool {
        match (self, candidate) {
            (Self::Watermark(previous), Some(next)) => previous.is_unseen_after(next),
            (Self::Watermark(_), None) => false,
            (Self::Checkpoint(previous), Some(next)) => {
                previous.timestamp_nanos.is_none()
                    || next.timestamp_nanos.is_none()
                    || previous.is_unseen_after(next)
            }
            (Self::Checkpoint(_), None) => true,
        }
    }
}

struct RuntimeRecovery {
    file: fs::File,
    length: u64,
    cursor: RuntimeWatchCursor,
    filter: Option<RuntimeRecoveryFilter>,
}

impl RuntimeWatchCursor {
    fn at_end(path: &Path) -> Self {
        let Ok(file) = fs::File::open(path) else {
            return Self::default();
        };
        Self::baseline(file).unwrap_or_default()
    }

    fn take_baseline_session_title(&mut self) -> (Option<String>, bool) {
        let generated = self.baseline_session_title.take();
        let generated_seen = generated.is_some();
        let fallback = self.baseline_fallback_title.take();
        (generated.or(fallback), generated_seen)
    }

    fn baseline(file: fs::File) -> Option<Self> {
        let mut checkpoint = None;
        let mut watermark = RuntimeEventWatermark::default();
        let mut baseline_lines_remaining = RUNTIME_TITLE_BASELINE_LINES;
        let mut baseline_session_title = None;
        let mut baseline_fallback_title = None;
        let mut scanned = scan_runtime_file(file, |_, _, line| {
            observe_runtime_line(&mut checkpoint, &mut watermark, line);
            if baseline_lines_remaining == 0 {
                return;
            }
            baseline_lines_remaining -= 1;
            if let Some(title) = session_title_from_line(line) {
                baseline_session_title = Some(title);
            }
            if baseline_fallback_title.is_none() {
                baseline_fallback_title = session_title_fallback_from_line(line);
            }
        })?;
        let mut cursor = Self::at_offset(&mut scanned.file, scanned.scanned_length)?;
        cursor.checkpoint = checkpoint;
        cursor.watermark = watermark;
        cursor.baseline_session_title = baseline_session_title;
        cursor.baseline_fallback_title = baseline_fallback_title;
        Some(cursor)
    }

    fn at_offset(file: &mut fs::File, offset: u64) -> Option<Self> {
        let metadata = file.metadata().ok()?;
        if metadata.len() < offset {
            return None;
        }
        Some(Self {
            initialized: true,
            offset,
            identity: Some(RuntimeFileIdentity::from_file(file, &metadata)),
            anchor: read_runtime_anchor(file, offset)?,
            line: Vec::with_capacity(1024),
            line_overflow: false,
            checkpoint: None,
            watermark: RuntimeEventWatermark::default(),
            baseline_session_title: None,
            baseline_fallback_title: None,
        })
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
        record_runtime_anchor(&mut self.anchor, data);
    }
}

fn read_runtime_anchor(file: &mut fs::File, offset: u64) -> Option<Vec<u8>> {
    let anchor_start = offset.saturating_sub(RUNTIME_FILE_ANCHOR as u64);
    let anchor_length = usize::try_from(offset - anchor_start).ok()?;
    let mut anchor = vec![0_u8; anchor_length];
    if anchor_length > 0 {
        file.seek(SeekFrom::Start(anchor_start)).ok()?;
        file.read_exact(&mut anchor).ok()?;
    }
    Some(anchor)
}

fn record_runtime_anchor(anchor: &mut Vec<u8>, data: &[u8]) {
    if data.len() >= RUNTIME_FILE_ANCHOR {
        anchor.clear();
        anchor.extend_from_slice(&data[data.len() - RUNTIME_FILE_ANCHOR..]);
        return;
    }
    let overflow = anchor
        .len()
        .saturating_add(data.len())
        .saturating_sub(RUNTIME_FILE_ANCHOR);
    if overflow > 0 {
        anchor.drain(..overflow);
    }
    anchor.extend_from_slice(data);
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

fn scan_runtime_file<F>(mut file: fs::File, mut on_line: F) -> Option<RuntimeFileScan>
where
    F: FnMut(u64, u64, &[u8]),
{
    let metadata = file.metadata().ok()?;
    let identity = RuntimeFileIdentity::from_file(&file, &metadata);
    let length = metadata.len();
    file.seek(SeekFrom::Start(0)).ok()?;

    let mut remaining = length;
    let mut absolute = 0_u64;
    let mut line_start = 0_u64;
    let mut line = Vec::with_capacity(1024);
    let mut line_overflow = false;
    let mut end_anchor = Vec::with_capacity(RUNTIME_FILE_ANCHOR);
    let mut buffer = [0_u8; 8192];
    while remaining > 0 {
        let chunk = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
        let read = file.read(&mut buffer[..chunk]).ok()?;
        if read == 0 {
            return None;
        }
        let data = &buffer[..read];
        record_runtime_anchor(&mut end_anchor, data);
        remaining = remaining.saturating_sub(read as u64);
        for byte in data {
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

    let current_metadata = file.metadata().ok()?;
    if RuntimeFileIdentity::from_file(&file, &current_metadata) != identity
        || current_metadata.len() < length
        || read_runtime_anchor(&mut file, length)? != end_anchor
    {
        return None;
    }
    Some(RuntimeFileScan {
        file,
        scanned_length: length,
        current_length: current_metadata.len(),
    })
}

fn recover_runtime_cursor(file: fs::File, cursor: &RuntimeWatchCursor) -> Option<RuntimeRecovery> {
    let previous_checkpoint = cursor.checkpoint.clone();
    let previous_watermark = cursor.watermark.clone();
    // An exact, unique prior checkpoint is the strongest boundary. If it disappeared, is
    // ambiguous, or appears after a timestamped unseen event, filter every candidate against the
    // previous high-water mark. Unordered legacy rows cannot be classified and stay baseline-only.
    let mut matching_checkpoint_end = None;
    let mut checkpoint_matches = 0_usize;
    let mut first_unseen_start = None;
    let mut baseline_checkpoint = None;
    let mut baseline_watermark = RuntimeEventWatermark::default();
    let mut scanned = scan_runtime_file(file, |start, end, line| {
        let Some(candidate) = runtime_line_checkpoint(line) else {
            return;
        };
        if previous_checkpoint
            .as_ref()
            .is_some_and(|checkpoint| checkpoint.matches(&candidate))
        {
            checkpoint_matches = checkpoint_matches.saturating_add(1);
            matching_checkpoint_end = Some(end);
        }
        if first_unseen_start.is_none() && previous_watermark.is_unseen_after(&candidate) {
            first_unseen_start = Some(start);
        }
        baseline_watermark.observe(&candidate);
        baseline_checkpoint = Some(candidate);
    })?;

    let exact_checkpoint_end = (checkpoint_matches == 1)
        .then_some(matching_checkpoint_end)
        .flatten();
    let use_watermark = match (first_unseen_start, exact_checkpoint_end) {
        (Some(unseen), Some(checkpoint_end)) => unseen < checkpoint_end,
        (Some(_), None) => true,
        _ => false,
    };
    let (resume_offset, filter) = if use_watermark {
        (
            first_unseen_start.unwrap_or(scanned.scanned_length),
            Some(RuntimeRecoveryFilter::Watermark(previous_watermark.clone())),
        )
    } else if let Some(checkpoint_end) = exact_checkpoint_end {
        (
            checkpoint_end,
            Some(RuntimeRecoveryFilter::Checkpoint(
                previous_watermark.clone(),
            )),
        )
    } else {
        (scanned.scanned_length, None)
    };

    let has_scanned_tail = resume_offset < scanned.scanned_length;
    let mut next = RuntimeWatchCursor::at_offset(&mut scanned.file, resume_offset)?;
    if has_scanned_tail {
        next.checkpoint = previous_checkpoint;
        next.watermark = previous_watermark;
    } else {
        next.checkpoint = baseline_checkpoint.or(previous_checkpoint);
        next.watermark = previous_watermark;
        next.watermark.merge(&baseline_watermark);
    }
    let length = scanned.file.metadata().ok()?.len();
    if length < scanned.current_length || length < next.offset {
        return None;
    }
    Some(RuntimeRecovery {
        file: scanned.file,
        length,
        cursor: next,
        filter,
    })
}

fn process_runtime_line<F>(
    checkpoint: &mut Option<RuntimeLineCheckpoint>,
    watermark: &mut RuntimeEventWatermark,
    recovery_filter: Option<&RuntimeRecoveryFilter>,
    line: &[u8],
    on_line: &mut F,
) where
    F: FnMut(&[u8]),
{
    let candidate = runtime_line_checkpoint(line);
    let should_emit = recovery_filter
        .map(|filter| filter.should_emit(candidate.as_ref()))
        .unwrap_or(true);
    if let Some(next) = candidate {
        watermark.observe(&next);
        *checkpoint = Some(next);
    }
    if should_emit {
        on_line(line);
    }
}

fn read_runtime_tail<F>(
    file: &mut fs::File,
    length: u64,
    cursor: &mut RuntimeWatchCursor,
    recovery_filter: Option<&RuntimeRecoveryFilter>,
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
            process_runtime_line(
                checkpoint,
                watermark,
                recovery_filter,
                runtime_line,
                on_line,
            );
        });
    }

    if !cursor.line_overflow
        && !cursor.line.is_empty()
        && serde_json::from_slice::<Value>(&cursor.line).is_ok()
    {
        let mut completed = Vec::with_capacity(cursor.line.capacity());
        std::mem::swap(&mut completed, &mut cursor.line);
        process_runtime_line(
            &mut cursor.checkpoint,
            &mut cursor.watermark,
            recovery_filter,
            &completed,
            on_line,
        );
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
    if !cursor.initialized {
        if let Some(next) = RuntimeWatchCursor::baseline(file) {
            *cursor = next;
        }
        return;
    }

    let Ok(metadata) = file.metadata() else {
        return;
    };
    let identity = RuntimeFileIdentity::from_file(&file, &metadata);
    let length = metadata.len();
    let reset = cursor.identity.is_some_and(|known| known != identity)
        || length < cursor.offset
        || !cursor.anchor_matches(&mut file);
    if reset {
        on_reset();
        let Some(recovery) = recover_runtime_cursor(file, cursor) else {
            return;
        };
        let RuntimeRecovery {
            mut file,
            length,
            cursor: next,
            filter,
        } = recovery;
        *cursor = next;
        read_runtime_tail(&mut file, length, cursor, filter.as_ref(), &mut on_line);
        return;
    }
    read_runtime_tail(&mut file, length, cursor, None, &mut on_line);
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
            let (initial_title, mut generated_title_seen) = cursor.take_baseline_session_title();
            let mut fallback_title_seen = initial_title.is_some() && !generated_title_seen;
            let mut emitted_title = initial_title;
            if let Some(title) = emitted_title.as_ref() {
                let _ = app.emit(
                    "pty-session-title",
                    PtySessionTitleEvent {
                        terminal_id: terminal_id.clone(),
                        title: title.clone(),
                    },
                );
            }

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
                        if let Some(title) = session_title_for_emit(
                            &mut generated_title_seen,
                            &mut fallback_title_seen,
                            runtime_line,
                        ) {
                            if emitted_title.as_deref() != Some(title.as_str()) {
                                let _ = app.emit(
                                    "pty-session-title",
                                    PtySessionTitleEvent {
                                        terminal_id: terminal_id.clone(),
                                        title: title.clone(),
                                    },
                                );
                            }
                            emitted_title = Some(title);
                        }
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

fn session_title_from_line(line: &[u8]) -> Option<String> {
    let value = serde_json::from_slice::<Value>(line).ok()?;
    if !matches!(
        value.get("type").and_then(Value::as_str),
        Some("title" | "title_change")
    ) {
        return None;
    }
    value
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_owned)
}

fn session_title_for_emit(
    generated_title_seen: &mut bool,
    fallback_title_seen: &mut bool,
    line: &[u8],
) -> Option<String> {
    if let Some(title) = session_title_from_line(line) {
        *generated_title_seen = true;
        return Some(title);
    }
    if *generated_title_seen || *fallback_title_seen {
        return None;
    }
    let fallback = session_title_fallback_from_line(line)?;
    *fallback_title_seen = true;
    Some(fallback)
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
                .map(strip_thinking_suffix),
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
    request: TerminalAttachmentRequest,
    terminals: State<'_, TerminalState>,
) -> Result<TerminalAttachment, String> {
    let output = {
        let processes = lock_processes(&terminals);
        processes
            .get(&request.terminal_id)
            .ok_or_else(|| format!("Терминал не найден: {}", request.terminal_id))?
            .output
            .clone()
    };
    let prepared = lock_terminal_output(&output).attach(&request)?;
    let (exited, exit_code, success, error) = {
        let processes = lock_processes(&terminals);
        let process = processes
            .get(&request.terminal_id)
            .filter(|process| Arc::ptr_eq(&process.output, &output))
            .ok_or_else(|| format!("Терминал не найден: {}", request.terminal_id))?;
        (
            process.exited,
            process.exit_code,
            process.exit_success,
            process.exit_error.clone(),
        )
    };
    Ok(TerminalAttachment {
        data: BASE64.encode(prepared.snapshot.data),
        generation: prepared.generation,
        first_seq: prepared.snapshot.first_seq,
        last_seq: prepared.snapshot.last_seq,
        next_seq: prepared.next_seq,
        truncated: prepared.snapshot.truncated,
        dropped_bytes: prepared.snapshot.dropped_bytes,
        baseline_reset: prepared.baseline_reset,
        exited,
        exit_code,
        success,
        error,
    })
}

#[tauri::command]
pub fn detach_terminal(
    request: TerminalDetachRequest,
    terminals: State<'_, TerminalState>,
) -> Result<(), String> {
    let output = {
        let processes = lock_processes(&terminals);
        processes
            .get(&request.terminal_id)
            .ok_or_else(|| format!("Терминал не найден: {}", request.terminal_id))?
            .output
            .clone()
    };
    lock_terminal_output(&output).detach(&request.attachment_id);
    Ok(())
}

#[tauri::command]
pub fn write_terminal(
    terminal_id: String,
    data: String,
    terminals: State<'_, TerminalState>,
) -> Result<(), String> {
    write_bytes(&terminal_id, data.into_bytes(), &terminals)
}

#[tauri::command]
pub fn write_terminal_binary(
    terminal_id: String,
    data: String,
    terminals: State<'_, TerminalState>,
) -> Result<(), String> {
    let bytes = decode_terminal_binary(&data)?;
    write_bytes(&terminal_id, bytes, &terminals)
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

fn stop_terminal_for_restart(terminal_id: &str, terminals: &TerminalState) -> Result<(), String> {
    let (exit_waiter, writer) = {
        let mut processes = lock_processes(terminals);
        let process = processes
            .get_mut(terminal_id)
            .ok_or_else(|| format!("Терминал не найден: {terminal_id}"))?;
        if !process.exited && !process.exit_pending {
            let killer = process
                .killer
                .as_mut()
                .ok_or_else(|| "Процесс OMP нельзя остановить".to_owned())?;
            kill_terminal_process(killer.as_mut())
                .map_err(|error| format!("Не удалось остановить процесс OMP: {error}"))?;
            process.exit_pending = true;
        }
        let exit_waiter = process
            .exit_waiter
            .take()
            .ok_or_else(|| "Остановка процесса OMP уже выполняется".to_owned())?;
        (exit_waiter, process.writer.clone())
    };
    if let Some(writer) = writer {
        writer.close();
    }

    if let Err(error) = exit_waiter.recv_timeout(TERMINAL_STOP_TIMEOUT) {
        drop(lock_processes(terminals).remove(terminal_id));
        return Err(terminal_restart_stopped_error(format!(
            "Процесс OMP не завершился после остановки: {error}"
        )));
    }
    drop(lock_processes(terminals).remove(terminal_id));
    Ok(())
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
    if *overflow_notified {
        return Ok(());
    }
    let available = MAX_SWITCH_INPUT_BUFFER.saturating_sub(buffer.len());
    if data.len() > available {
        if !*overflow_notified {
            *overflow_notified = true;
            return Err(format!(
                "Буфер ввода во время смены модели ограничен {} KiB; текущие {} байт не приняты, дальнейший ввод до завершения переключения игнорируется",
                MAX_SWITCH_INPUT_BUFFER / 1024,
                data.len()
            ));
        }
        return Ok(());
    }
    buffer.extend_from_slice(data);
    Ok(())
}

fn write_bytes(terminal_id: &str, data: Vec<u8>, terminals: &TerminalState) -> Result<(), String> {
    let writer = {
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
                &data,
            );
        }
        process
            .writer
            .clone()
            .ok_or_else(|| "Процесс OMP уже завершён".to_owned())?
    };
    writer.enqueue(data, false)
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

fn receive_timed_output_batch(
    receiver: &mpsc::Receiver<Vec<u8>>,
    mut batch: Vec<u8>,
    batch_interval: Duration,
) -> Vec<u8> {
    let deadline = Instant::now() + batch_interval;
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
    batch_interval: Duration,
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
            let first = match output_receiver.recv_timeout(batch_interval) {
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
            let batch = receive_timed_output_batch(output_receiver, first, batch_interval);
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
    let event = match drain_output_batches(
        &output_receiver,
        &exit_receiver,
        PTY_OUTPUT_BATCH_INTERVAL,
        |batch| output(batch),
    ) {
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

fn finalize_terminal_exit(
    app: &AppHandle,
    terminal_id: &str,
    output: &SharedTerminalOutput,
    event: PtyExitEvent,
) {
    let runtime_error = event
        .output_truncated
        .then(|| event.error.clone())
        .flatten();
    let session_lease = {
        let state = app.state::<TerminalState>();
        let mut processes = lock_processes(&state);
        let Some(process) = processes
            .get_mut(terminal_id)
            .filter(|process| Arc::ptr_eq(&process.output, output))
        else {
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
        process.switch_pending = false;
        process.switch_input_buffer.clear();
        process.switch_input_overflow_notified = false;
        process.switch_recovery = None;
        process.session_lease.take()
    };
    drop(session_lease);

    if lock_terminal_output(output).has_attachment() {
        if let Some(error) = runtime_error {
            emit_runtime_error(app, terminal_id, error);
        }
        let _ = app.emit("pty-exit", event);
    }
}

fn forward_output_batches(
    app: AppHandle,
    terminal_id: String,
    output: SharedTerminalOutput,
    output_receiver: mpsc::Receiver<Vec<u8>>,
    exit_receiver: mpsc::Receiver<PtyExitEvent>,
    finalized_sender: mpsc::SyncSender<()>,
) {
    let update_detector = RefCell::new(UpdateDetector::new());
    let transient_backend_detector = RefCell::new(TransientBackendErrorDetector::default());
    run_output_pipeline(
        output_receiver,
        exit_receiver,
        PTY_EXIT_FINALIZE_TIMEOUT,
        |batch| {
            route_output(
                &app,
                &terminal_id,
                &output,
                batch,
                &mut update_detector.borrow_mut(),
                &mut transient_backend_detector.borrow_mut(),
            )
        },
        |event| {
            if update_detector.borrow_mut().flush() {
                let _ = app.emit(
                    "omp-update-notice",
                    PtyUpdateEvent {
                        terminal_id: terminal_id.clone(),
                    },
                );
            }
            finalize_terminal_exit(&app, &terminal_id, &output, event)
        },
    );
    let _ = finalized_sender.send(());
}

fn spawn_reader(
    app: AppHandle,
    terminal_id: String,
    output: SharedTerminalOutput,
    mut reader: Box<dyn Read + Send>,
    finalized_sender: mpsc::SyncSender<()>,
) -> Result<PtyExitSignal, String> {
    let (output_sender, output_receiver) = mpsc::sync_channel(PTY_OUTPUT_QUEUE_CAPACITY);
    let output_waker = output_sender.clone();
    let (exit_sender, exit_receiver) = mpsc::sync_channel(1);
    let output_app = app.clone();
    let output_terminal_id = terminal_id.clone();
    let output_for_thread = output.clone();

    thread::Builder::new()
        .name(format!("pty-output-{terminal_id}"))
        .spawn(move || {
            forward_output_batches(
                output_app,
                output_terminal_id,
                output_for_thread,
                output_receiver,
                exit_receiver,
                finalized_sender,
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
        output,
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

            // Preserve the last breadcrumb for very short-lived sessions without
            // putting filesystem work back into the PTY output hot path. A pin
            // restart already owns this guard and already has an exact resume path.
            {
                let state = app.state::<TerminalState>();
                let poll = try_lock_session_files(&state).map(|session_file_guard| {
                    let poll = poll_resume_path_locked(&terminal_id, &state);
                    drop(session_file_guard);
                    poll
                });
                if let Some(poll) = poll {
                    let _ = finish_resume_path_poll(&app, &terminal_id, poll);
                }
            }

            let (master, writer, mut killer) = {
                let state = app.state::<TerminalState>();
                let mut processes = lock_processes(&state);
                let Some(process) = processes
                    .get_mut(&terminal_id)
                    .filter(|process| Arc::ptr_eq(&process.output, &exit_signal.output))
                else {
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
                    let _ = kill_terminal_process(killer.as_mut());
                }
            }
            if let Some(writer) = writer.as_ref() {
                writer.close();
            }
            drop(writer);
            drop(master);
            drop(killer);

            let fallback_event = event.clone();
            if let Err(error) = exit_signal.event_sender.send(event) {
                finalize_terminal_exit(&app, &terminal_id, &exit_signal.output, error.0);
                return;
            }
            if exit_signal.output_waker.send(Vec::new()).is_err() {
                finalize_terminal_exit(&app, &terminal_id, &exit_signal.output, fallback_event);
            }
        })
        .map(|_| ())
        .map_err(|error| format!("Не удалось запустить поток ожидания PTY: {error}"))
}

fn output_event_name(terminal_id: &str) -> String {
    format!("pty-output:{terminal_id}")
}

fn route_output(
    app: &AppHandle,
    terminal_id: &str,
    output: &SharedTerminalOutput,
    data: &[u8],
    update_detector: &mut UpdateDetector,
    transient_backend_detector: &mut TransientBackendErrorDetector,
) {
    let Some((generation, seq, should_emit)) = lock_terminal_output(output).record(data) else {
        return;
    };
    let emit_update = update_detector.observe(data);
    for category in transient_backend_detector
        .observe(data)
        .into_iter()
        .flatten()
    {
        diagnostics::warn(
            "pty.transient_backend",
            &format!("terminal_id={terminal_id}; category={category}"),
        );
    }

    if should_emit {
        let encoded = BASE64.encode(data);
        if lock_terminal_output(output).is_current_attachment(generation) {
            let event_name = output_event_name(terminal_id);
            let _ = app.emit(
                &event_name,
                PtyOutputEvent {
                    terminal_id: terminal_id.to_owned(),
                    data: encoded,
                    generation,
                    seq,
                },
            );
        }
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
const UPDATE_DETECTOR_VOLUME_THRESHOLD: usize = 2048;
const MAX_UPDATE_NOTICE_SPAN: usize = 512;
const _: () =
    assert!(UPDATE_DETECTOR_VOLUME_THRESHOLD <= MAX_UPDATE_BUFFER - MAX_UPDATE_NOTICE_SPAN);

#[derive(Default)]
struct UpdateDetector {
    buffer: Vec<u8>,
    uninspected_bytes: usize,
    notified: bool,
}

impl UpdateDetector {
    fn new() -> Self {
        Self::default()
    }

    /// Feeds output bytes into the rolling buffer.
    ///
    /// Volume throttling triggers scanning only when at least
    /// `UPDATE_DETECTOR_VOLUME_THRESHOLD` (2048) new bytes have accumulated since the
    /// last check.
    ///
    /// Invariant: the supported OMP update-notice span is bounded to
    /// `MAX_UPDATE_NOTICE_SPAN` (512) bytes. The retained overlap is
    /// `MAX_UPDATE_BUFFER - UPDATE_DETECTOR_VOLUME_THRESHOLD = 2048` bytes, so a
    /// notice split across detector runs remains fully present for the next scan.
    fn observe(&mut self, data: &[u8]) -> bool {
        if self.notified {
            return false;
        }
        append_update_buffer(&mut self.buffer, data);
        self.uninspected_bytes = self.uninspected_bytes.saturating_add(data.len());
        if self.uninspected_bytes >= UPDATE_DETECTOR_VOLUME_THRESHOLD {
            self.scan()
        } else {
            false
        }
    }

    fn flush(&mut self) -> bool {
        if self.notified || self.uninspected_bytes == 0 {
            return false;
        }
        self.scan()
    }

    fn scan(&mut self) -> bool {
        self.uninspected_bytes = 0;
        if detect_update_notice_in_buffer(&self.buffer) {
            self.notified = true;
            true
        } else {
            false
        }
    }
}

const MAX_TRANSIENT_BACKEND_PATTERN_SPAN: usize = 64;
const TRANSIENT_BACKEND_CATEGORIES: [&str; 4] = [
    "stale_response_owner",
    "websocket_service_restart",
    "provider_overloaded",
    "network_unavailable",
];
const TRANSIENT_BACKEND_PATTERNS: [(&[u8], usize); 6] = [
    (b"previous response owner account is unavailable", 0),
    (b"1012 (service restart)", 1),
    (b"overloaded_error", 2),
    (b"ENETUNREACH", 3),
    (b"EHOSTUNREACH", 3),
    (b"EAI_AGAIN", 3),
];
const _: () = {
    assert!(TRANSIENT_BACKEND_CATEGORIES.len() <= u8::BITS as usize);
    let mut index = 0;
    while index < TRANSIENT_BACKEND_PATTERNS.len() {
        let (pattern, category) = TRANSIENT_BACKEND_PATTERNS[index];
        assert!(!pattern.is_empty());
        assert!(pattern.len() <= MAX_TRANSIENT_BACKEND_PATTERN_SPAN);
        assert!(category < TRANSIENT_BACKEND_CATEGORIES.len());
        index += 1;
    }
};

#[derive(Default)]
struct TransientBackendErrorDetector {
    tail: Vec<u8>,
    notified: u8,
}

impl TransientBackendErrorDetector {
    fn observe(
        &mut self,
        data: &[u8],
    ) -> [Option<&'static str>; TRANSIENT_BACKEND_CATEGORIES.len()] {
        let mut events = [None; TRANSIENT_BACKEND_CATEGORIES.len()];
        for (pattern, category) in TRANSIENT_BACKEND_PATTERNS {
            let bit = 1 << category;
            if self.notified & bit != 0 {
                continue;
            }
            if contains_ascii_case_insensitive(data, pattern)
                || pattern_crosses_output_boundary(&self.tail, data, pattern)
            {
                self.notified |= bit;
                events[category] = Some(TRANSIENT_BACKEND_CATEGORIES[category]);
            }
        }
        append_transient_backend_tail(&mut self.tail, data);
        events
    }
}

fn contains_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle))
}

fn pattern_crosses_output_boundary(tail: &[u8], data: &[u8], pattern: &[u8]) -> bool {
    (1..pattern.len()).any(|tail_len| {
        tail.get(tail.len().saturating_sub(tail_len)..)
            .is_some_and(|suffix| {
                suffix.len() == tail_len && suffix.eq_ignore_ascii_case(&pattern[..tail_len])
            })
            && data
                .get(..pattern.len() - tail_len)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(&pattern[tail_len..]))
    })
}

fn append_transient_backend_tail(tail: &mut Vec<u8>, data: &[u8]) {
    if data.len() >= MAX_TRANSIENT_BACKEND_PATTERN_SPAN {
        tail.clear();
        tail.extend_from_slice(&data[data.len() - MAX_TRANSIENT_BACKEND_PATTERN_SPAN..]);
        return;
    }
    let overflow = tail
        .len()
        .saturating_add(data.len())
        .saturating_sub(MAX_TRANSIENT_BACKEND_PATTERN_SPAN);
    if overflow > 0 {
        tail.drain(..overflow);
    }
    tail.extend_from_slice(data);
}

fn append_update_buffer(buffer: &mut Vec<u8>, data: &[u8]) {
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
}

#[cfg(test)]
fn detect_update_notice(buffer: &mut Vec<u8>, data: &[u8]) -> bool {
    append_update_buffer(buffer, data);
    detect_update_notice_in_buffer(buffer)
}

fn detect_update_notice_in_buffer(buffer: &[u8]) -> bool {
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

#[cfg(test)]
mod tests {
    use super::{
        append_switch_input, breadcrumb_modified, build_omp_command, cli_path_arg,
        decode_terminal_binary, discard_switch_input_recovery_from_state, discover_session,
        drain_output_batches, feed_runtime_lines, finalize_switch_result,
        initial_agent_args_with_config, lock_processes, lock_terminal_output, model_switch_input,
        normalize_thinking_level, output_event_name, poll_runtime_file, read_runtime_tail,
        receive_ready_output_batch, receive_timed_output_batch, recover_runtime_cursor,
        resolve_resume_path_for_current, run_output_pipeline, runtime_event_for_emit,
        runtime_event_from_line, send_switch_input_recovery_blocking, session_title_for_emit,
        session_title_from_line, spawn_terminal_writer, thinking_cycle, validate_switch_request,
        validated_resume_path, write_bytes, PtyExitEvent, PtyRuntimeEventKind, RuntimeRecovery,
        RuntimeWatchCursor, SessionDiscovery, SessionLease, SessionLeasePurpose,
        SwitchInputRecoveryRequest, SwitchInputRecoveryState, SwitchRequest,
        TerminalAttachmentRequest, TerminalOutputState, TerminalProcess, TerminalState,
        MAX_REPLAY_OUTPUT, MAX_RUNTIME_EVENT_LINE, MAX_SWITCH_INPUT_BUFFER, OMP_THINKING_CYCLE_ESC,
        PTY_EXIT_TRUNCATION_ERROR, PTY_OUTPUT_BATCH_INTERVAL, PTY_OUTPUT_BATCH_LIMIT,
    };
    #[cfg(windows)]
    use super::{
        kill_terminal_process, native_pty_system, CommandBuilder, PtySize, RuntimeFileIdentity,
        WindowsJobObject,
    };
    #[cfg(windows)]
    use std::time::Instant;
    use std::{
        cell::RefCell,
        collections::HashMap,
        ffi::OsStr,
        fs,
        io::{self, Write},
        path::PathBuf,
        sync::{mpsc, Arc, Mutex},
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    #[cfg(windows)]
    struct ProcessFixture {
        child: Option<std::process::Child>,
    }

    #[cfg(windows)]
    impl ProcessFixture {
        fn new(child: std::process::Child) -> Self {
            Self { child: Some(child) }
        }

        fn id(&self) -> u32 {
            self.child
                .as_ref()
                .expect("fixture child should exist")
                .id()
        }

        fn raw_handle(&self) -> std::os::windows::io::RawHandle {
            use std::os::windows::io::AsRawHandle;
            self.child
                .as_ref()
                .expect("fixture child should exist")
                .as_raw_handle()
        }

        fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
            self.child
                .as_mut()
                .expect("fixture child should exist")
                .try_wait()
        }

        fn wait(&mut self) -> io::Result<std::process::ExitStatus> {
            let result = self
                .child
                .as_mut()
                .expect("fixture child should exist")
                .wait();
            if result.is_ok() {
                self.child = None;
            }
            result
        }
    }

    #[cfg(windows)]
    impl Drop for ProcessFixture {
        fn drop(&mut self) {
            let Some(mut child) = self.child.take() else {
                return;
            };
            if !matches!(child.try_wait(), Ok(Some(_))) {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }

    #[cfg(windows)]
    struct PtyChildFixture {
        child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
        killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    }

    #[cfg(windows)]
    impl PtyChildFixture {
        fn new(child: Box<dyn portable_pty::Child + Send + Sync>) -> Self {
            let killer = child.clone_killer();
            Self {
                child: Some(child),
                killer,
            }
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            self.child
                .as_ref()
                .expect("fixture child should exist")
                .clone_killer()
        }

        fn try_wait(&mut self) -> io::Result<Option<portable_pty::ExitStatus>> {
            self.child
                .as_mut()
                .expect("fixture child should exist")
                .try_wait()
        }

        fn wait(&mut self) -> io::Result<portable_pty::ExitStatus> {
            let result = self
                .child
                .as_mut()
                .expect("fixture child should exist")
                .wait();
            if result.is_ok() {
                self.child = None;
            }
            result
        }
    }

    #[cfg(windows)]
    impl Drop for PtyChildFixture {
        fn drop(&mut self) {
            let Some(mut child) = self.child.take() else {
                return;
            };
            if !matches!(child.try_wait(), Ok(Some(_))) {
                let _ = kill_terminal_process(self.killer.as_mut());
            }
            let _ = child.wait();
        }
    }

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

    fn terminal_process(
        resume_path: Option<String>,
        writer: Option<Box<dyn Write + Send>>,
    ) -> TerminalProcess {
        TerminalProcess {
            master: None,
            writer: writer.map(|writer| {
                spawn_terminal_writer("test", writer, |_| {}).expect("test PTY writer should start")
            }),
            killer: None,
            process_id: Some(7),
            cwd: "/tmp/project".to_owned(),
            resume_path,
            pending_resume_path: None,
            session_lease: None,
            terminal_sessions_dir: PathBuf::new(),
            breadcrumb_snapshot: HashMap::new(),
            output: Arc::new(Mutex::new(TerminalOutputState::new(7))),
            exit_pending: false,
            exited: false,
            exit_code: None,
            exit_success: false,
            exit_error: None,
            thinking: false,
            restartable: true,
            switch_pending: false,
            switch_input_buffer: Vec::new(),
            switch_input_overflow_notified: false,
            exit_waiter: None,
            switch_generation: 0,
            switch_recovery: None,

            #[cfg(windows)]
            _containment: super::WindowsJobObject::new()
                .expect("test Windows Job Object should initialize"),
        }
    }
    #[test]
    fn attach_detach_reattach_replays_only_unseen_output_and_exit_state() {
        let mut process = terminal_process(None, None);
        let first = {
            let mut output = lock_terminal_output(&process.output);
            assert_eq!(output.record(b"first"), Some((7, 1, false)));
            output
                .attach(&TerminalAttachmentRequest {
                    terminal_id: "terminal-1".to_owned(),
                    attachment_id: "view-1".to_owned(),
                    generation: None,
                    after_seq: None,
                })
                .expect("first view should attach")
        };
        assert!(first.baseline_reset);
        assert_eq!(first.snapshot.data, b"first");
        assert_eq!(first.snapshot.first_seq, Some(1));
        assert_eq!(first.snapshot.last_seq, Some(1));

        {
            let mut output = lock_terminal_output(&process.output);
            output.detach("view-1");
            assert!(output.attachment_id.is_none());
            assert_eq!(output.record(b"second"), Some((7, 2, false)));
        }
        process.exited = true;
        process.exit_code = Some(0);
        process.exit_success = true;
        let second = lock_terminal_output(&process.output)
            .attach(&TerminalAttachmentRequest {
                terminal_id: "terminal-1".to_owned(),
                attachment_id: "view-2".to_owned(),
                generation: Some(7),
                after_seq: Some(1),
            })
            .expect("replacement view should reattach");
        assert!(!second.baseline_reset);
        assert_eq!(second.snapshot.data, b"second");
        assert_eq!(second.snapshot.first_seq, Some(2));
        assert_eq!(second.snapshot.last_seq, Some(2));
        assert!(process.exited);
        assert_eq!(process.exit_code, Some(0));
        assert!(process.exit_success);
    }

    #[test]
    fn stale_detach_cannot_disconnect_newer_attachment() {
        let process = terminal_process(None, None);
        let mut output = lock_terminal_output(&process.output);
        output
            .attach(&TerminalAttachmentRequest {
                terminal_id: "terminal-1".to_owned(),
                attachment_id: "old-view".to_owned(),
                generation: None,
                after_seq: None,
            })
            .expect("old view should attach");
        output
            .attach(&TerminalAttachmentRequest {
                terminal_id: "terminal-1".to_owned(),
                attachment_id: "new-view".to_owned(),
                generation: Some(7),
                after_seq: Some(0),
            })
            .expect("new view should atomically replace old view");
        output.detach("old-view");
        assert_eq!(output.attachment_id.as_deref(), Some("new-view"));
        output.detach("new-view");
        assert!(output.attachment_id.is_none());
    }

    #[test]
    fn bounded_replay_marks_partial_batch_truncation() {
        let process = terminal_process(None, None);
        let oversized = vec![b'x'; MAX_REPLAY_OUTPUT + 37];
        let mut output = lock_terminal_output(&process.output);
        assert_eq!(output.record(&oversized), Some((7, 1, false)));
        let attachment = output
            .attach(&TerminalAttachmentRequest {
                terminal_id: "terminal-1".to_owned(),
                attachment_id: "view".to_owned(),
                generation: Some(7),
                after_seq: Some(0),
            })
            .expect("view should attach after overflow");
        assert_eq!(attachment.snapshot.data.len(), MAX_REPLAY_OUTPUT);
        assert!(attachment.snapshot.truncated);
        assert_eq!(attachment.snapshot.dropped_bytes, 37);
        assert_eq!(attachment.snapshot.first_seq, Some(1));
        assert_eq!(attachment.snapshot.last_seq, Some(1));
    }

    #[test]
    fn attachment_rejects_future_sequence_baseline() {
        let process = terminal_process(None, None);
        let error = lock_terminal_output(&process.output)
            .attach(&TerminalAttachmentRequest {
                terminal_id: "terminal-1".to_owned(),
                attachment_id: "view".to_owned(),
                generation: Some(7),
                after_seq: Some(1),
            })
            .err()
            .expect("future sequence must be rejected");
        assert!(error.starts_with("[terminal_sequence_invalid] "));
    }

    struct BlockingWriter {
        started: Option<mpsc::SyncSender<()>>,
        release: mpsc::Receiver<()>,
    }

    impl Write for BlockingWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            if let Some(started) = self.started.take() {
                let _ = started.send(());
            }
            self.release
                .recv()
                .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "writer released"))?;
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct RecordingWriter {
        bytes: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for RecordingWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.bytes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct FailingWriter;

    impl Write for FailingWriter {
        fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "injected writer failure",
            ))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn switching_state(writer: Box<dyn Write + Send>, buffered: &[u8]) -> TerminalState {
        let state = TerminalState::default();
        let mut process = terminal_process(None, Some(writer));
        process.switch_pending = true;
        process.switch_generation = 1;
        process.switch_input_buffer = buffered.to_vec();
        lock_processes(&state).insert("terminal-1".to_owned(), process);
        state
    }

    fn recovery_request(state: &TerminalState) -> SwitchInputRecoveryRequest {
        let processes = lock_processes(state);
        let recovery = processes
            .get("terminal-1")
            .and_then(|process| process.switch_recovery.as_ref())
            .expect("recovery should exist");
        SwitchInputRecoveryRequest {
            terminal_id: "terminal-1".to_owned(),
            generation: recovery.generation,
            token: recovery.token.clone(),
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

        let batch =
            receive_timed_output_batch(&receiver, vec![0; chunk_size], PTY_OUTPUT_BATCH_INTERVAL);
        assert_eq!(batch.len(), PTY_OUTPUT_BATCH_LIMIT);
        assert_eq!(batch[0], 0);
        assert_eq!(batch[chunk_size], 1);
        assert_eq!(batch[PTY_OUTPUT_BATCH_LIMIT - 1], 7);
    }

    #[test]
    fn output_pipeline_forwards_leading_chunk_before_batch_window() {
        let (output_sender, output_receiver) = mpsc::sync_channel(1);
        let (_exit_sender, exit_receiver) = mpsc::sync_channel(1);
        let (forwarded_sender, forwarded_receiver) = mpsc::sync_channel(1);

        let pipeline = thread::spawn(move || {
            let _ = drain_output_batches(
                &output_receiver,
                &exit_receiver,
                Duration::from_secs(30),
                |batch| {
                    forwarded_sender
                        .send(batch.to_vec())
                        .expect("forward leading output")
                },
            );
        });

        output_sender
            .send(b"leading".to_vec())
            .expect("queue leading output");
        assert_eq!(
            forwarded_receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("leading output must not wait for the trailing batch window"),
            b"leading"
        );

        drop(output_sender);
        pipeline.join().expect("join output pipeline");
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
    fn blocked_terminal_writer_does_not_block_ipc_or_process_registry() {
        let state = Arc::new(TerminalState::default());
        let (started_sender, started_receiver) = mpsc::sync_channel(1);
        let (release_sender, release_receiver) = mpsc::sync_channel(1);
        lock_processes(&state).insert(
            "terminal-1".to_owned(),
            terminal_process(
                None,
                Some(Box::new(BlockingWriter {
                    started: Some(started_sender),
                    release: release_receiver,
                })),
            ),
        );

        let writer_state = state.clone();
        let (write_result_sender, write_result_receiver) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let _ = write_result_sender.send(write_bytes(
                "terminal-1",
                b"input".to_vec(),
                &writer_state,
            ));
        });
        started_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("writer should receive queued input");
        write_result_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("IPC write should return after queueing")
            .expect("input should be queued");

        let probe_state = state.clone();
        let (probe_sender, probe_receiver) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let _ = probe_sender.send(probe_state.resource_processes());
        });
        assert_eq!(
            probe_receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("another terminal operation must not wait for the blocked writer"),
            vec![("terminal-1".to_owned(), 7)]
        );

        release_sender.send(()).expect("release blocked writer");
    }

    #[cfg(windows)]
    #[test]
    fn conpty_close_cancels_a_blocked_writer_after_kill() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("ConPTY fixture should open");
        let mut command = CommandBuilder::new("powershell.exe");
        command.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]);
        let child = pair
            .slave
            .spawn_command(command)
            .expect("sleeping child should start");
        let mut child = PtyChildFixture::new(child);
        let mut killer = child.clone_killer();
        let raw_writer = pair.master.take_writer().expect("PTY writer should open");
        drop(pair.slave);
        let writer = spawn_terminal_writer("conpty-cancel-test", raw_writer, |_| {})
            .expect("ConPTY writer thread should start");

        let write_writer = writer.clone();
        let (finished_sender, finished_receiver) = mpsc::sync_channel(1);
        let writer_thread = thread::spawn(move || {
            let result = write_writer.enqueue(vec![b'x'; 8 * 1024 * 1024], true);
            let _ = finished_sender.send(result);
        });
        let deadline = Instant::now() + Duration::from_secs(1);
        while !writer
            .control
            .io_active
            .load(std::sync::atomic::Ordering::Acquire)
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(1));
        }
        assert!(
            writer
                .control
                .io_active
                .load(std::sync::atomic::Ordering::Acquire),
            "writer fixture should fill the ConPTY input buffer"
        );

        kill_terminal_process(killer.as_mut()).expect("sleeping child should be killable");
        writer.close();
        finished_receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("closing the writer must cancel its synchronous ConPTY write")
            .expect_err("canceled ConPTY input should report terminal closure");
        writer_thread.join().expect("writer caller should finish");
        child.wait().expect("killed child should be waitable");
        drop(pair.master);
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_object_kills_direct_child_and_descendant_on_owner_drop() {
        use std::process::{Command, Stdio};
        use windows_sys::Win32::{
            Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::{
                OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
                PROCESS_SYNCHRONIZE,
            },
        };

        fn wait_until_terminated(process_id: u32, deadline: Instant) -> bool {
            loop {
                let handle = unsafe {
                    OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                        0,
                        process_id,
                    )
                };
                if handle.is_null() {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() == Some(87) {
                        return true;
                    }
                    panic!("process {process_id} could not be inspected: {error}");
                }
                let status = unsafe { WaitForSingleObject(handle, 0) };
                unsafe {
                    CloseHandle(handle);
                }
                if status == WAIT_OBJECT_0 {
                    return true;
                }
                assert_eq!(status, WAIT_TIMEOUT, "unexpected process wait status");
                if Instant::now() >= deadline {
                    return false;
                }
                thread::sleep(Duration::from_millis(10));
            }
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-windows-job-tree-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("fixture directory should be writable");
        let script = root.join("tree.ps1");
        let gate = root.join("assigned.gate");
        let pid_file = root.join("pids.txt");
        fs::write(
            &script,
            r#"param([string]$Gate, [string]$PidFile)
while (-not [System.IO.File]::Exists($Gate)) { Start-Sleep -Milliseconds 10 }
$child = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList '/d', '/c', 'ping -n 120 127.0.0.1 > nul' -PassThru
[System.IO.File]::WriteAllText($PidFile, "$PID`n$($child.Id)")
$child.WaitForExit()
"#,
        )
        .expect("PowerShell fixture should be writable");

        let child = Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
            ])
            .arg("-File")
            .arg(&script)
            .arg(&gate)
            .arg(&pid_file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("PowerShell tree fixture should start");
        let mut child = ProcessFixture::new(child);
        let job = WindowsJobObject::new().expect("kill-on-close Job Object should initialize");
        job.assign(child.raw_handle())
            .expect("fixture root should join Job Object before descendant launch");
        fs::write(&gate, b"assigned").expect("fixture gate should open");

        let discovery_deadline = Instant::now() + Duration::from_secs(10);
        let process_ids = loop {
            if let Ok(contents) = fs::read_to_string(&pid_file) {
                let ids = contents
                    .lines()
                    .filter_map(|line| line.trim().parse::<u32>().ok())
                    .collect::<Vec<_>>();
                if ids.len() == 2 {
                    break ids;
                }
            }
            if let Some(status) = child
                .try_wait()
                .expect("fixture root status should be readable")
            {
                panic!("fixture root exited before publishing descendant PID: {status}");
            }
            assert!(
                Instant::now() < discovery_deadline,
                "fixture did not publish process tree PIDs"
            );
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(process_ids[0], child.id());

        drop(job);
        let termination_deadline = Instant::now() + Duration::from_secs(5);
        assert!(
            wait_until_terminated(process_ids[0], termination_deadline),
            "direct child survived Job Object owner close"
        );
        assert!(
            wait_until_terminated(process_ids[1], termination_deadline),
            "descendant survived Job Object owner close"
        );
        child
            .wait()
            .expect("terminated fixture root should be waitable");
        fs::remove_dir_all(root).expect("fixture directory should be removable");
    }
    #[cfg(windows)]
    #[test]
    fn windows_job_object_assign_returns_os_error_code_on_invalid_handle() {
        let job = WindowsJobObject::new().expect("Job Object should initialize");
        let invalid_handle = std::ptr::null_mut();
        let error = job
            .assign(invalid_handle)
            .expect_err("invalid handle should fail");
        assert!(error.raw_os_error().is_some());
    }
    #[cfg(windows)]
    #[test]
    fn failed_switch_actual_conpty_keeps_input_until_explicit_send() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("omp-switch-conpty-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).expect("fixture directory should be writable");
        let ready = root.join("ready.txt");
        let received = root.join("received.txt");

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("ConPTY fixture should open");
        let mut reader = pair
            .master
            .try_clone_reader()
            .expect("ConPTY reader should clone");
        let mut raw_writer = pair
            .master
            .take_writer()
            .expect("ConPTY writer should open");
        let mut command = CommandBuilder::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[IO.File]::WriteAllText($env:OMP_SWITCH_READY, 'ready'); $line = [Console]::In.ReadLine(); [IO.File]::WriteAllText($env:OMP_SWITCH_RECEIVED, $line)",
        ]);
        command.env("OMP_SWITCH_READY", &ready);
        command.env("OMP_SWITCH_RECEIVED", &received);
        let child = pair
            .slave
            .spawn_command(command)
            .expect("PowerShell input fixture should start");
        let mut child = PtyChildFixture::new(child);
        drop(pair.slave);

        let mut cursor_query = [0_u8; 4];
        reader
            .read_exact(&mut cursor_query)
            .expect("read ConPTY cursor-position query");
        assert_eq!(&cursor_query, b"\x1b[6n");
        raw_writer
            .write_all(b"\x1b[1;1R")
            .expect("answer ConPTY cursor-position query");
        raw_writer
            .flush()
            .expect("flush ConPTY cursor-position response");

        let ready_deadline = Instant::now() + Duration::from_secs(10);
        while !ready.is_file() {
            if let Some(status) = child
                .try_wait()
                .expect("fixture process status should be readable")
            {
                panic!("input fixture exited before becoming ready: {status}");
            }
            assert!(
                Instant::now() < ready_deadline,
                "input fixture did not become ready"
            );
            thread::sleep(Duration::from_millis(10));
        }

        let state = switching_state(raw_writer, b"sensitive-input\r");
        let _ = finalize_switch_result::<()>(
            "terminal-1",
            &state,
            Err("injected switch failure".to_owned()),
        );
        thread::sleep(Duration::from_millis(300));
        assert!(
            !received.exists(),
            "failed switch must not send buffered user input automatically"
        );

        let request = recovery_request(&state);
        send_switch_input_recovery_blocking(&request, &state)
            .expect("explicit send should reach the live ConPTY");
        let received_deadline = Instant::now() + Duration::from_secs(10);
        while !received.is_file() {
            assert!(
                Instant::now() < received_deadline,
                "explicitly sent input did not reach ConPTY fixture"
            );
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            fs::read_to_string(&received).expect("received input should be readable"),
            "sensitive-input"
        );

        drop(lock_processes(&state).remove("terminal-1"));
        drop(pair.master);
        drop(reader);
        child
            .wait()
            .expect("input fixture should exit after one line");
        fs::remove_dir_all(root).expect("fixture directory should be removable");
    }

    #[test]
    fn active_session_cannot_be_deleted_by_backend_command() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-active-session-delete-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("session root should be writable");
        let session = root.join("session.jsonl");
        fs::write(&session, b"{}\n").expect("session fixture should be writable");

        let state = TerminalState::default();
        let session_path = session.to_string_lossy().into_owned();
        lock_processes(&state).insert(
            "terminal-1".to_owned(),
            terminal_process(Some(session_path.clone()), None),
        );

        let error = state
            .delete_inactive_session(&session_path, &root, false)
            .expect_err("active session deletion must fail");
        assert!(error.starts_with("[session_active_delete] "));
        assert!(session.is_file());

        lock_processes(&state)
            .get_mut("terminal-1")
            .expect("terminal fixture")
            .exited = true;
        let external_lease = SessionLease::acquire(&session, SessionLeasePurpose::Resume, false)
            .expect("external owner should acquire the session lease");
        let lease_error = state
            .delete_inactive_session(&session_path, &root, false)
            .expect_err("OS-leased session deletion must fail");
        assert!(lease_error.starts_with("[session_lease_active] "));
        assert!(session.is_file());
        drop(external_lease);
        state
            .delete_inactive_session(&session_path, &root, false)
            .expect("exited session should be deletable");
        assert!(!session.exists());
        fs::remove_dir_all(root).expect("session fixture should be removable");
    }

    #[test]
    fn stale_session_deletion_requires_explicit_reclaim() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-stale-session-delete-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("session root should be writable");
        let session = root.join("session.jsonl");
        fs::write(&session, b"{}\n").expect("session fixture should be writable");
        let session_path = session.to_string_lossy().into_owned();
        let lock_path = root.join("session.jsonl.omp-desktop.lock");
        fs::write(
            &lock_path,
            serde_json::to_vec(&serde_json::json!({
                "ownerToken": "crashed-owner",
                "desktopPid": std::process::id(),
                "desktopStartedAt": "old-start",
                "acquiredAt": "old-acquisition",
                "sessionPath": session_path,
                "purpose": "resume"
            }))
            .expect("stale metadata should serialize"),
        )
        .expect("stale metadata should be writable");

        let state = TerminalState::default();
        let error = state
            .delete_inactive_session(&session_path, &root, false)
            .expect_err("stale metadata should require confirmation before deletion");
        assert!(error.starts_with("[session_lease_stale] "));
        assert!(session.is_file());

        state
            .delete_inactive_session(&session_path, &root, true)
            .expect("confirmed stale metadata reclaim should permit deletion");
        assert!(!session.exists());
        assert_eq!(
            fs::read_dir(&root)
                .expect("fixture directory should be readable")
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().contains(".stale-"))
                .count(),
            1
        );
        fs::remove_dir_all(root).expect("session fixture should be removable");
    }

    #[test]
    fn initial_args_always_use_exact_resume_path() {
        assert_eq!(
            initial_agent_args_with_config("/tmp/project", Some("/tmp/session.jsonl"), &[]),
            vec!["--cwd", "/tmp/project", "--resume", "/tmp/session.jsonl",]
        );
    }

    #[test]
    fn cli_path_arg_preserves_posix_paths() {
        assert_eq!(
            cli_path_arg("/home/user/project with spaces"),
            "/home/user/project with spaces"
        );
    }

    #[cfg(windows)]
    #[test]
    fn cli_path_arg_normalizes_windows_drive_verbatim_and_unc_paths() {
        assert_eq!(
            cli_path_arg(r"C:\Users\Omniv\.omp\sessions\a.jsonl"),
            "C:/Users/Omniv/.omp/sessions/a.jsonl"
        );
        assert_eq!(
            cli_path_arg(r"\\?\C:\Users\x\a.jsonl"),
            "C:/Users/x/a.jsonl"
        );
        assert_eq!(
            cli_path_arg(r"\\server\share\a.jsonl"),
            "//server/share/a.jsonl"
        );
        assert_eq!(
            cli_path_arg(r"\\?\UNC\server\share\a.jsonl"),
            "//server/share/a.jsonl"
        );
        assert_eq!(
            cli_path_arg(r"C:\Users\Name With Spaces\a.jsonl"),
            "C:/Users/Name With Spaces/a.jsonl"
        );
    }

    #[test]
    fn proxy_and_pin_overlays_precede_exact_session_path() {
        assert_eq!(
            initial_agent_args_with_config(
                "/tmp/project",
                Some("/tmp/session.jsonl"),
                &[
                    PathBuf::from("/tmp/proxy-providers.yml"),
                    PathBuf::from("/tmp/primary-provider-pin.yml"),
                ],
            ),
            vec![
                "--cwd",
                "/tmp/project",
                "--config",
                "/tmp/proxy-providers.yml",
                "--config",
                "/tmp/primary-provider-pin.yml",
                "--resume",
                "/tmp/session.jsonl",
            ]
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
        assert_eq!(buffer.len(), MAX_SWITCH_INPUT_BUFFER - 1);
        assert_eq!(buffer.last(), Some(&1));
        assert!(overflow_notified);

        assert!(append_switch_input(&mut buffer, &mut overflow_notified, &[4]).is_ok());
        assert_eq!(buffer.len(), MAX_SWITCH_INPUT_BUFFER - 1);
    }

    #[test]
    fn failed_switch_preserves_input_without_writing_any_user_byte() {
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let state = switching_state(
            Box::new(RecordingWriter {
                bytes: recorded.clone(),
            }),
            b"private draft",
        );

        let error = finalize_switch_result::<()>(
            "terminal-1",
            &state,
            Err("injected switch failure".to_owned()),
        )
        .expect_err("failed switch should return recovery metadata");
        assert!(recorded
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_empty());
        let serialized = serde_json::to_value(error).expect("switch error should serialize");
        assert_eq!(
            serialized.pointer("/recovery/byteCount"),
            Some(&serde_json::json!(13))
        );
        assert!(!serialized.to_string().contains("private draft"));

        let processes = lock_processes(&state);
        let process = processes.get("terminal-1").expect("terminal should remain");
        assert!(!process.switch_pending);
        let recovery = process
            .switch_recovery
            .as_ref()
            .expect("input should remain");
        assert_eq!(recovery.state, SwitchInputRecoveryState::Pending);
        assert_eq!(recovery.buffer, b"private draft");
    }

    #[test]
    fn successful_switch_flushes_buffer_exactly_once() {
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let state = switching_state(
            Box::new(RecordingWriter {
                bytes: recorded.clone(),
            }),
            b"ordered input",
        );

        finalize_switch_result("terminal-1", &state, Ok(()))
            .expect("successful switch should flush input");
        assert_eq!(
            *recorded
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            b"ordered input"
        );
        let processes = lock_processes(&state);
        let process = processes.get("terminal-1").expect("terminal should remain");
        assert!(!process.switch_pending);
        assert!(process.switch_recovery.is_none());
    }

    #[test]
    fn recovery_token_is_one_shot_and_duplicate_send_writes_nothing_more() {
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let state = switching_state(
            Box::new(RecordingWriter {
                bytes: recorded.clone(),
            }),
            b"one shot",
        );
        let _ = finalize_switch_result::<()>(
            "terminal-1",
            &state,
            Err("injected switch failure".to_owned()),
        );
        let request = recovery_request(&state);

        send_switch_input_recovery_blocking(&request, &state)
            .expect("first explicit send should succeed");
        assert!(send_switch_input_recovery_blocking(&request, &state).is_err());
        assert_eq!(
            *recorded
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            b"one shot"
        );
    }

    #[test]
    fn stale_recovery_identity_does_not_change_private_buffer() {
        let state = switching_state(Box::new(io::sink()), b"keep me");
        let _ = finalize_switch_result::<()>(
            "terminal-1",
            &state,
            Err("injected switch failure".to_owned()),
        );
        let request = recovery_request(&state);
        let stale = SwitchInputRecoveryRequest {
            terminal_id: request.terminal_id.clone(),
            generation: request.generation + 1,
            token: request.token.clone(),
        };

        assert!(send_switch_input_recovery_blocking(&stale, &state).is_err());
        assert!(discard_switch_input_recovery_from_state(&stale, &state).is_err());
        {
            let processes = lock_processes(&state);
            let recovery = processes
                .get("terminal-1")
                .and_then(|process| process.switch_recovery.as_ref())
                .expect("stale requests must preserve recovery");
            assert_eq!(recovery.buffer, b"keep me");
            assert_eq!(recovery.state, SwitchInputRecoveryState::Pending);
        }
        discard_switch_input_recovery_from_state(&request, &state)
            .expect("current recovery identity should discard");
        assert!(lock_processes(&state)
            .get("terminal-1")
            .expect("terminal should remain")
            .switch_recovery
            .is_none());
    }

    #[test]
    fn writer_failure_becomes_terminal_failed_send_until_discard() {
        let state = switching_state(Box::new(FailingWriter), b"uncertain write");
        let _ = finalize_switch_result::<()>(
            "terminal-1",
            &state,
            Err("injected switch failure".to_owned()),
        );
        let request = recovery_request(&state);

        let error = send_switch_input_recovery_blocking(&request, &state)
            .expect_err("writer failure must be reported");
        let serialized = serde_json::to_value(error).expect("send error should serialize");
        assert_eq!(
            serialized.pointer("/recovery/state"),
            Some(&serde_json::json!("failedSend"))
        );
        assert!(send_switch_input_recovery_blocking(&request, &state).is_err());
        {
            let processes = lock_processes(&state);
            let recovery = processes
                .get("terminal-1")
                .and_then(|process| process.switch_recovery.as_ref())
                .expect("failed send should remain until discard");
            assert_eq!(recovery.state, SwitchInputRecoveryState::FailedSend);
            assert_eq!(recovery.buffer, b"uncertain write");
        }
        discard_switch_input_recovery_from_state(&request, &state)
            .expect("failed send should permit safe discard");
    }

    #[test]
    fn automatic_flush_failure_keeps_metadata_and_disables_retry() {
        let state = switching_state(Box::new(FailingWriter), b"automatic write");

        let error = finalize_switch_result("terminal-1", &state, Ok(()))
            .expect_err("failed automatic flush should be recoverable only by discard");
        let serialized = serde_json::to_value(error).expect("flush error should serialize");
        assert_eq!(
            serialized.pointer("/recovery/state"),
            Some(&serde_json::json!("failedSend"))
        );
        let request = recovery_request(&state);
        assert!(send_switch_input_recovery_blocking(&request, &state).is_err());
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
    fn model_change_model_strips_only_a_known_final_thinking_suffix() {
        for (selector, expected_model) in [
            ("openai/gpt-5.6:high", "openai/gpt-5.6"),
            ("ollama/llama3.1:8b", "ollama/llama3.1:8b"),
            ("ollama/llama3.1:8b:HIGH", "ollama/llama3.1:8b"),
            ("ollama/llama3.1:8b:internal", "ollama/llama3.1:8b:internal"),
        ] {
            let line = serde_json::json!({
                "type": "model_change",
                "model": selector,
                "role": "default",
            })
            .to_string();
            let event = runtime_event_from_line("terminal-1", line.as_bytes())
                .expect("model change should parse");

            assert_eq!(event.model.as_deref(), Some(expected_model), "{selector}");
        }
    }

    #[test]
    fn session_title_parser_accepts_only_non_empty_title_entries() {
        assert_eq!(
            session_title_from_line(
                br#"{"type":"title_change","title":"  Automatic session title  "}"#,
            )
            .as_deref(),
            Some("Automatic session title"),
        );
        assert!(session_title_from_line(br#"{"type":"title_change","title":"   "}"#).is_none());
        assert!(session_title_from_line(br#"{"type":"message","title":"ignored"}"#).is_none());
    }

    #[test]
    fn runtime_title_uses_baseline_prompt_then_generated_title() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "omp-desktop-runtime-title-{}-{nonce}.jsonl",
            std::process::id()
        ));
        fs::write(
            &path,
            concat!(
                "{\"type\":\"title\",\"title\":\"\"}\n",
                "{\"type\":\"session\",\"id\":\"session-1\",\"cwd\":\"/tmp/project\"}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Investigate stale session title\"}]}}\n",
            ),
        )
        .expect("runtime title fixture should be writable");

        let mut cursor = RuntimeWatchCursor::at_end(&path);
        let (initial_title, mut generated_title_seen) = cursor.take_baseline_session_title();
        let mut fallback_title_seen = initial_title.is_some() && !generated_title_seen;
        assert_eq!(
            initial_title.as_deref(),
            Some("Investigate stale session title")
        );
        assert!(!generated_title_seen);
        assert!(fallback_title_seen);

        assert!(session_title_for_emit(
            &mut generated_title_seen,
            &mut fallback_title_seen,
            br#"{"type":"message","message":{"role":"user","content":"Do not retitle again"}}"#,
        )
        .is_none());
        assert_eq!(
            session_title_for_emit(
                &mut generated_title_seen,
                &mut fallback_title_seen,
                br#"{"type":"title_change","title":"Automatic session title"}"#,
            )
            .as_deref(),
            Some("Automatic session title"),
        );
        assert!(generated_title_seen);

        fs::remove_file(path).expect("runtime title fixture should be removable");
    }

    #[test]
    fn legacy_primary_provider_pin_entry_is_not_a_runtime_control() {
        assert!(runtime_event_from_line(
            "terminal-1",
            br#"{"type":"custom","customType":"primary_provider_pin","data":{"pinned":true}}"#,
        )
        .is_none());
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
    fn runtime_watcher_baselines_history_after_transient_absence() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "omp-desktop-runtime-absent-{}-{nonce}.jsonl",
            std::process::id()
        ));
        let mut cursor = RuntimeWatchCursor::at_end(&path);
        let mut events = Vec::new();

        fs::write(
            &path,
            b"{\"type\":\"message\",\"id\":\"error-1\",\"timestamp\":\"2026-08-09T10:00:00Z\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"error\",\"errorMessage\":\"historical\"}}\n",
        )
        .expect("late historical fixture should be writable");
        poll_runtime_file(&path, &mut cursor, || {}, |line| events.push(line.to_vec()));
        assert!(events.is_empty());

        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("late historical fixture should be appendable");
        file.write_all(
            b"{\"type\":\"message\",\"id\":\"user-2\",\"timestamp\":\"2026-08-09T10:00:01Z\",\"message\":{\"role\":\"user\"}}\n",
        )
        .expect("live activity should be appendable");
        poll_runtime_file(&path, &mut cursor, || {}, |line| events.push(line.to_vec()));
        fs::remove_file(&path).expect("late historical fixture should be removable");

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
    fn runtime_watcher_filters_timestamped_history_after_exact_checkpoint() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "omp-desktop-runtime-exact-filter-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("exact filter directory should be writable");
        let path = directory.join("session.jsonl");
        let checkpoint = "{\"type\":\"message\",\"id\":\"checkpoint\",\"timestamp\":\"2026-08-09T10:00:03Z\",\"message\":{\"role\":\"user\"}}\n";
        fs::write(&path, checkpoint).expect("exact filter baseline should be writable");
        let mut cursor = RuntimeWatchCursor::at_end(&path);
        fs::write(
            &path,
            format!(
                "{{\"type\":\"title_change\",\"id\":\"title\",\"timestamp\":\"2026-08-09T10:00:00Z\",\"title\":\"rewritten\"}}\n{checkpoint}{{\"type\":\"message\",\"id\":\"historical-error\",\"timestamp\":\"2026-08-09T10:00:02Z\",\"message\":{{\"role\":\"assistant\",\"stopReason\":\"error\",\"errorMessage\":\"historical\"}}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\"}}}}\n{{\"type\":\"retry_fallback_applied\",\"id\":\"live-fallback\",\"timestamp\":\"2026-08-09T10:00:04Z\",\"from\":\"provider/primary\",\"to\":\"provider/fallback\",\"role\":\"default\"}}\n"
            ),
        )
        .expect("exact filter replacement should be writable");
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
        fs::remove_dir_all(&directory).expect("exact filter directory should be removable");

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, PtyRuntimeEventKind::Activity);
        assert_eq!(events[0].activity.as_deref(), Some("thinking"));
        assert_eq!(events[1].kind, PtyRuntimeEventKind::RetryFallbackApplied);
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
    fn runtime_watcher_filters_every_watermark_recovery_line() {
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
                "{\"type\":\"message\",\"id\":\"historical-before\",\"timestamp\":\"2026-08-09T10:00:01Z\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"error\",\"errorMessage\":\"historical before\"}}\n",
                "{\"type\":\"message\",\"id\":\"live-error\",\"timestamp\":\"2026-08-09T10:00:04Z\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"error\",\"errorMessage\":\"live failure\"}}\n",
                "{\"type\":\"retry_fallback_applied\",\"id\":\"historical-after\",\"timestamp\":\"2026-08-09T10:00:02Z\",\"from\":\"provider/primary\",\"to\":\"provider/fallback\",\"role\":\"default\"}\n"
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
    fn runtime_watcher_distinguishes_reused_ids_by_timestamp() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "omp-desktop-runtime-reused-id-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("reused id directory should be writable");
        let path = directory.join("session.jsonl");
        fs::write(
            &path,
            b"{\"type\":\"message\",\"id\":\"shared\",\"timestamp\":\"2026-08-09T10:00:03Z\",\"message\":{\"role\":\"user\"}}\n",
        )
        .expect("reused id baseline should be writable");
        let mut cursor = RuntimeWatchCursor::at_end(&path);
        fs::rename(&path, directory.join("baseline.jsonl"))
            .expect("reused id baseline should be rotatable");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"retry_fallback_applied\",\"id\":\"shared\",\"timestamp\":\"2026-08-09T10:00:04Z\",\"from\":\"provider/primary\",\"to\":\"provider/fallback\",\"role\":\"default\"}\n",
                "{\"type\":\"message\",\"id\":\"shared\",\"timestamp\":\"2026-08-09T10:00:03Z\",\"message\":{\"role\":\"user\"}}\n"
            ),
        )
        .expect("reused id replacement should be writable");
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
        fs::remove_dir_all(&directory).expect("reused id directory should be removable");

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, PtyRuntimeEventKind::RetryFallbackApplied);
    }

    #[test]
    fn runtime_watcher_uses_watermark_for_ambiguous_legacy_checkpoints() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "omp-desktop-runtime-ambiguous-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("ambiguous checkpoint directory should be writable");
        let path = directory.join("session.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"message\",\"id\":\"old-user\",\"timestamp\":\"2026-08-09T10:00:03Z\",\"message\":{\"role\":\"user\"}}\n",
                "{\"type\":\"custom\",\"customType\":\"tool_execution_end\"}\n"
            ),
        )
        .expect("ambiguous checkpoint baseline should be writable");
        let mut cursor = RuntimeWatchCursor::at_end(&path);
        fs::rename(&path, directory.join("baseline.jsonl"))
            .expect("ambiguous checkpoint baseline should be rotatable");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"message\",\"id\":\"live-error\",\"timestamp\":\"2026-08-09T10:00:04Z\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"error\",\"errorMessage\":\"live failure\"}}\n",
                "{\"type\":\"custom\",\"customType\":\"tool_execution_end\"}\n",
                "{\"type\":\"custom\",\"customType\":\"tool_execution_end\"}\n"
            ),
        )
        .expect("ambiguous checkpoint replacement should be writable");
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
        fs::remove_dir_all(&directory).expect("ambiguous checkpoint directory should be removable");

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, PtyRuntimeEventKind::ModelError);
        assert_eq!(events[0].error_message.as_deref(), Some("live failure"));
    }

    #[test]
    fn runtime_recovery_keeps_one_open_snapshot_across_a_second_rotation() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "omp-desktop-runtime-double-rotation-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("double rotation directory should be writable");
        let path = directory.join("session.jsonl");
        fs::write(
            &path,
            b"{\"type\":\"message\",\"id\":\"old-user\",\"timestamp\":\"2026-08-09T10:00:00Z\",\"message\":{\"role\":\"user\"}}\n",
        )
        .expect("double rotation baseline should be writable");
        let mut cursor = RuntimeWatchCursor::at_end(&path);
        fs::rename(&path, directory.join("baseline.jsonl"))
            .expect("double rotation baseline should be rotatable");
        fs::write(
            &path,
            b"{\"type\":\"retry_fallback_applied\",\"id\":\"segment-1\",\"timestamp\":\"2026-08-09T10:00:01Z\",\"from\":\"provider/primary\",\"to\":\"provider/fallback\",\"role\":\"default\"}\n",
        )
        .expect("first replacement should be writable");
        let held_file = fs::File::open(&path).expect("first replacement should be openable");

        fs::rename(&path, directory.join("segment-1.jsonl"))
            .expect("first replacement should remain rotatable while open");
        fs::write(
            &path,
            b"{\"type\":\"model_change\",\"id\":\"segment-2\",\"timestamp\":\"2026-08-09T10:00:02Z\",\"model\":\"provider/fallback\",\"role\":\"fallback\"}\n",
        )
        .expect("second replacement should be writable");

        let RuntimeRecovery {
            mut file,
            length,
            cursor: next,
            filter,
        } = recover_runtime_cursor(held_file, &cursor)
            .expect("held replacement should recover as one snapshot");
        cursor = next;
        let mut ids = Vec::new();
        read_runtime_tail(
            &mut file,
            length,
            &mut cursor,
            filter.as_ref(),
            &mut |line| {
                let value = serde_json::from_slice::<serde_json::Value>(line)
                    .expect("recovered line should stay valid JSON");
                ids.push(
                    value["id"]
                        .as_str()
                        .expect("recovered id should exist")
                        .to_owned(),
                );
            },
        );
        poll_runtime_file(
            &path,
            &mut cursor,
            || {},
            |line| {
                let value = serde_json::from_slice::<serde_json::Value>(line)
                    .expect("next rotation line should stay valid JSON");
                ids.push(
                    value["id"]
                        .as_str()
                        .expect("next rotation id should exist")
                        .to_owned(),
                );
            },
        );
        fs::remove_dir_all(&directory).expect("double rotation directory should be removable");

        assert_eq!(ids, ["segment-1", "segment-2"]);
    }
    #[cfg(windows)]
    #[test]
    fn runtime_file_identity_changes_across_a_windows_replacement() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "omp-desktop-runtime-windows-identity-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("identity directory should be writable");
        let path = directory.join("session.jsonl");
        fs::write(&path, b"old\n").expect("old identity fixture should be writable");
        let old_file = fs::File::open(&path).expect("old identity fixture should be openable");
        let old_metadata = old_file
            .metadata()
            .expect("old identity metadata should be readable");
        let old_identity = RuntimeFileIdentity::from_file(&old_file, &old_metadata);

        fs::rename(&path, directory.join("old.jsonl"))
            .expect("old identity fixture should remain rotatable while open");
        fs::write(&path, b"new\n").expect("new identity fixture should be writable");
        let new_file = fs::File::open(&path).expect("new identity fixture should be openable");
        let new_metadata = new_file
            .metadata()
            .expect("new identity metadata should be readable");
        let new_identity = RuntimeFileIdentity::from_file(&new_file, &new_metadata);
        fs::remove_dir_all(&directory).expect("identity directory should be removable");

        assert!(old_identity.file_id.is_some());
        assert!(new_identity.file_id.is_some());
        assert_ne!(old_identity, new_identity);
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

        let levels = thinking_cycle(&["low".to_owned(), "high".to_owned()]);
        assert_eq!(normalize_thinking_level("xhigh", &levels), "high");
        assert_eq!(normalize_thinking_level("medium", &levels), "low");
        assert_eq!(normalize_thinking_level("inherit", &levels), "off");
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

        assert!(discover_session(
            "terminal-1",
            "/tmp/project",
            &directory,
            &HashMap::new(),
            None,
        )
        .is_none());
        fs::write(
            &session_path,
            "{\"type\":\"session\",\"id\":\"new-session\",\"timestamp\":\"2026-07-20T12:00:00Z\",\"cwd\":\"/tmp/project\",\"title\":\"New session\"}\n",
        )
        .expect("session header should be writable");

        let Some(SessionDiscovery::Ready {
            resume_path: resolved,
            session,
        }) = discover_session(
            "terminal-1",
            "/tmp/project",
            &directory,
            &HashMap::new(),
            None,
        )
        else {
            panic!("parseable session should be discovered");
        };
        fs::remove_dir_all(&directory).expect("fixture directory should be removable");

        assert_eq!(resolved, session_path.to_string_lossy());
        assert_eq!(session.id, "new-session");
    }

    #[test]
    fn fresh_terminal_breadcrumb_tracks_lazy_session_until_materialized() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "omp-desktop-fresh-breadcrumb-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("fixture directory should be writable");
        let session_path = directory.join("lazy-session.jsonl");
        fs::write(
            directory.join("apple-terminal-1"),
            format!("/tmp/project\n{}\nfresh\n", session_path.display()),
        )
        .expect("fresh breadcrumb should be writable");

        let Some(SessionDiscovery::PendingFresh { resume_path }) = discover_session(
            "terminal-1",
            "/tmp/project",
            &directory,
            &HashMap::new(),
            None,
        ) else {
            panic!("fresh breadcrumb should preserve the lazy session path");
        };
        assert_eq!(resume_path, session_path.to_string_lossy());

        fs::write(
            &session_path,
            "{\"type\":\"session\",\"id\":\"lazy-session\",\"timestamp\":\"2026-07-20T12:00:00Z\",\"cwd\":\"/tmp/project\"}\n",
        )
        .expect("lazy session should materialize");
        assert!(matches!(
            discover_session(
                "terminal-1",
                "/tmp/project",
                &directory,
                &HashMap::new(),
                None,
            ),
            Some(SessionDiscovery::Ready { .. })
        ));

        fs::remove_dir_all(&directory).expect("fixture directory should be removable");
    }

    #[test]
    fn terminal_breadcrumb_discovers_handoff_path_after_initial_session() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "omp-desktop-breadcrumb-handoff-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("fixture directory should be writable");

        let old_path = directory.join("old-session.jsonl");
        let new_path = directory.join("new-session.jsonl");
        fs::write(
            &old_path,
            "{\"type\":\"session\",\"id\":\"old-session\",\"timestamp\":\"2026-07-20T12:00:00Z\",\"cwd\":\"/tmp/project\"}\n",
        )
        .expect("old session should be writable");
        fs::write(
            &new_path,
            "{\"type\":\"session\",\"id\":\"handoff-session\",\"timestamp\":\"2026-07-20T12:01:00Z\",\"cwd\":\"/tmp/project\"}\n",
        )
        .expect("handoff session should be writable");

        let breadcrumb = directory.join("apple-terminal-1");
        fs::write(
            &breadcrumb,
            format!("/tmp/project\n{}\n", old_path.display()),
        )
        .expect("initial breadcrumb should be writable");

        let Some(SessionDiscovery::Ready {
            resume_path: resolved_old,
            session: old_session,
        }) = discover_session(
            "terminal-1",
            "/tmp/project",
            &directory,
            &HashMap::new(),
            None,
        )
        else {
            panic!("initial session should be discovered");
        };
        assert_eq!(resolved_old, old_path.to_string_lossy());
        assert_eq!(old_session.id, "old-session");

        fs::write(
            &breadcrumb,
            format!("/tmp/project\n{}\n", new_path.display()),
        )
        .expect("handoff breadcrumb should be writable");

        let old_path_string = old_path.to_string_lossy().into_owned();
        let Some(SessionDiscovery::Ready {
            resume_path: resolved_new,
            session: new_session,
        }) = discover_session(
            "terminal-1",
            "/tmp/project",
            &directory,
            &HashMap::new(),
            Some(&old_path_string),
        )
        else {
            panic!("handoff session should be discovered");
        };
        assert_eq!(resolved_new, new_path.to_string_lossy());
        assert_eq!(new_session.id, "handoff-session");

        let new_path_string = new_path.to_string_lossy().into_owned();
        assert!(discover_session(
            "terminal-1",
            "/tmp/project",
            &directory,
            &HashMap::new(),
            Some(&new_path_string),
        )
        .is_none());

        fs::remove_dir_all(&directory).expect("fixture directory should be removable");
    }

    #[test]
    fn tracked_terminal_ignores_other_terminal_breadcrumb_changes() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "omp-desktop-breadcrumb-isolation-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("fixture directory should be writable");

        let current_session = directory.join("current.jsonl");
        let other_session = directory.join("other.jsonl");
        fs::write(
            &current_session,
            "{\"type\":\"session\",\"id\":\"current\",\"cwd\":\"/tmp/project\"}\n",
        )
        .expect("current session should be writable");
        fs::write(
            &other_session,
            "{\"type\":\"session\",\"id\":\"other\",\"cwd\":\"/tmp/project\"}\n",
        )
        .expect("other session should be writable");

        let direct = directory.join("apple-terminal-2");
        let other = directory.join("apple-terminal-1");
        fs::write(
            &direct,
            format!("/tmp/project\n{}\n", current_session.display()),
        )
        .expect("direct breadcrumb should be writable");
        fs::write(
            &other,
            format!("/tmp/project\n{}\n", other_session.display()),
        )
        .expect("other breadcrumb should be writable");

        let snapshot = HashMap::from([
            (
                direct.clone(),
                breadcrumb_modified(&direct).expect("direct breadcrumb timestamp"),
            ),
            (other.clone(), 0),
        ]);
        let current_path = current_session.to_string_lossy().into_owned();
        let resolved = resolve_resume_path_for_current(
            "terminal-2",
            "/tmp/project",
            &directory,
            &snapshot,
            Some(&current_path),
        );
        let new_terminal_resolved = resolve_resume_path_for_current(
            "terminal-3",
            "/tmp/project",
            &directory,
            &snapshot,
            None,
        );
        fs::remove_dir_all(&directory).expect("fixture directory should be removable");

        assert!(
            resolved.is_none(),
            "another terminal breadcrumb must not rebind the tracked terminal: {resolved:?}"
        );
        assert!(
            new_terminal_resolved.is_none(),
            "another terminal breadcrumb must not bind a new terminal: {new_terminal_resolved:?}"
        );
    }
    #[test]
    fn resume_path_must_be_internal_and_match_the_project() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-desktop-resume-guard-{}-{nonce}",
            std::process::id()
        ));
        let session_root = root.join("sessions");
        let project = root.join("project");
        let other_project = root.join("other-project");
        fs::create_dir_all(&session_root).expect("session root should be writable");
        fs::create_dir_all(&project).expect("project should be writable");
        fs::create_dir_all(&other_project).expect("other project should be writable");
        let project_path = project.to_string_lossy().into_owned();
        let body = format!(
            "{{\"type\":\"session\",\"id\":\"resume-test\",\"cwd\":{}}}\n",
            serde_json::to_string(&project_path).expect("project path should serialize")
        );
        let internal = session_root.join("session.jsonl");
        let external = root.join("external.jsonl");
        fs::write(&internal, &body).expect("internal fixture should be writable");
        fs::write(&external, body).expect("external fixture should be writable");

        assert!(validated_resume_path(
            internal.to_string_lossy().as_ref(),
            &session_root,
            &project_path,
        )
        .is_ok());
        assert!(validated_resume_path(
            external.to_string_lossy().as_ref(),
            &session_root,
            &project_path,
        )
        .is_err());
        assert!(validated_resume_path(
            internal.to_string_lossy().as_ref(),
            &session_root,
            other_project.to_string_lossy().as_ref(),
        )
        .is_err());

        fs::remove_dir_all(root).expect("fixture should be removable");
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

    #[test]
    fn update_detector_preserves_split_notice_across_throttled_scans() {
        use super::{UpdateDetector, UPDATE_DETECTOR_VOLUME_THRESHOLD};

        let mut detector = UpdateDetector::new();
        let prefix = b"\x1b[32mNew vers";
        let filler = vec![b'x'; UPDATE_DETECTOR_VOLUME_THRESHOLD - prefix.len()];
        assert!(!detector.observe(&filler));
        assert!(!detector.observe(prefix));
        assert!(!detector.observe(b"ion 17.1.0 is available.\x1b[0m Run: omp update\n"));
        assert!(detector.flush());
        assert!(!detector.flush(), "one notice must emit only once");

        let mut localized = "Доступна новая версия OMP 17.2.0. Запустите omp update\n"
            .as_bytes()
            .to_vec();
        localized.resize(UPDATE_DETECTOR_VOLUME_THRESHOLD, b' ');
        let mut localized_detector = UpdateDetector::new();
        assert!(localized_detector.observe(&localized));
        assert!(!localized_detector.observe(&localized));
    }

    #[test]
    fn transient_backend_detector_handles_split_output_and_deduplicates_categories() {
        use super::TransientBackendErrorDetector;

        let mut detector = TransientBackendErrorDetector::default();
        assert!(detector
            .observe(b"Previous response owner account is unavail")
            .into_iter()
            .flatten()
            .next()
            .is_none());
        assert_eq!(
            detector
                .observe(b"able; retry later. (code=upstream_unavailable)")
                .into_iter()
                .flatten()
                .collect::<Vec<_>>(),
            vec!["stale_response_owner"]
        );
        assert!(detector
            .observe(b"PREVIOUS RESPONSE OWNER ACCOUNT IS UNAVAILABLE")
            .into_iter()
            .flatten()
            .next()
            .is_none());

        assert_eq!(
            detector
                .observe(b"transport failed: EHOSTUNREACH; EAI_AGAIN")
                .into_iter()
                .flatten()
                .collect::<Vec<_>>(),
            vec!["network_unavailable"]
        );
    }
}
