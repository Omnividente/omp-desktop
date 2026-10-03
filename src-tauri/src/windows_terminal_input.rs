//! Private, console-attached control process. User input remains a byte-for-byte PTY stream.
use std::{
    env,
    fs::File,
    io::{self, Write},
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    process::{Child, Command, Stdio},
    ptr,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        DuplicateHandle, DUPLICATE_SAME_ACCESS, ERROR_BROKEN_PIPE, ERROR_GEN_FAILURE,
        ERROR_INVALID_HANDLE, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE,
        HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, PIPE_ACCESS_INBOUND,
    },
    System::{
        Console::{
            AttachConsole, FreeConsole, GetConsoleMode, GetStdHandle,
            ENABLE_VIRTUAL_TERMINAL_PROCESSING, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
        },
        Pipes::{ConnectNamedPipe, CreateNamedPipeW, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE},
        Threading::{
            CreateEventW, GetCurrentProcess, OpenProcess, ResetEvent, SetEvent,
            WaitForMultipleObjects, WaitForSingleObject, CREATE_NO_WINDOW, PROCESS_SYNCHRONIZE,
        },
        IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
    },
};

const GUARD_FLAG: &str = "--omp-vt-input-guard";
const DISABLE_WIN32_INPUT: &[u8] = b"\x1b[?9001l";
const ATTACH_TIMEOUT: Duration = Duration::from_secs(2);

fn own_handle(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        // The successful API call transfers ownership of this non-null handle.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }
}

fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle().cast()
}

fn event() -> io::Result<OwnedHandle> {
    own_handle(unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) })
}

fn process_alive(process: &OwnedHandle) -> io::Result<()> {
    match unsafe { WaitForSingleObject(raw(process), 0) } {
        WAIT_TIMEOUT => Ok(()),
        WAIT_OBJECT_0 => Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "OMP process has exited",
        )),
        _ => Err(io::Error::last_os_error()),
    }
}

fn open_process(pid: u32) -> io::Result<OwnedHandle> {
    let process = own_handle(unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) })?;
    process_alive(&process)?;
    Ok(process)
}

/// Signal the same writer close path that cancels synchronous PTY I/O.
#[derive(Clone)]
pub(crate) struct GuardCancellation(Arc<OwnedHandle>);

impl GuardCancellation {
    pub(crate) fn cancel(&self) {
        unsafe { SetEvent(raw(&self.0)) };
    }
}

struct HelperProcess(Child);

impl Drop for HelperProcess {
    fn drop(&mut self) {
        // EOF also handles abrupt parent termination. Never kill a process by PID here.
        drop(self.0.stdin.take());
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A local overlapped reply pipe permits an event wait with the existing writer deadline,
/// without an extra reader thread, queue, timer or idle polling.
fn reply_pipe() -> io::Result<(OwnedHandle, File)> {
    let name: Vec<u16> = format!(
        "\\\\.\\pipe\\omp-vt-input-{}-{:032x}",
        std::process::id(),
        rand::random::<u128>()
    )
    .encode_utf16()
    .chain(Some(0))
    .collect();
    let server = own_handle(unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_INBOUND | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            0,
            64,
            0,
            ptr::null(),
        )
    })?;
    // Opening our own client endpoint first makes ConnectNamedPipe complete with
    // ERROR_PIPE_CONNECTED; no startup read or potentially unbounded connect wait.
    let client = own_handle(unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_WRITE,
            0,
            ptr::null(),
            OPEN_EXISTING,
            0,
            ptr::null_mut(),
        )
    })?;
    let mut connection = OVERLAPPED::default();
    let connected = unsafe { ConnectNamedPipe(raw(&server), &mut connection) };
    if connected == 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_PIPE_CONNECTED as i32) {
            if error.raw_os_error() == Some(ERROR_IO_PENDING as i32) {
                let mut count = 0;
                unsafe {
                    CancelIoEx(raw(&server), &connection);
                    GetOverlappedResult(raw(&server), &connection, &mut count, 1);
                }
            }
            return Err(error);
        }
    }
    Ok((server, File::from(client)))
}

pub(crate) struct GuardedWriter {
    inner: Box<dyn Write + Send>,
    helper: HelperProcess,
    // Retaining this handle before reexec pins the real spawned process identity/PID.
    root: OwnedHandle,
    replies: OwnedHandle,
    reply_event: OwnedHandle,
    cancellation: GuardCancellation,
    timeout: Duration,
    ready: bool,
}

impl GuardedWriter {
    pub(crate) fn spawn(
        inner: Box<dyn Write + Send>,
        root_pid: u32,
        timeout: Duration,
    ) -> io::Result<Self> {
        let root = open_process(root_pid)?;
        let (replies, stdout) = reply_pipe()?;
        let reply_event = event()?;
        let cancellation = GuardCancellation(Arc::new(event()?));
        let mut command = Command::new(env::current_exe()?);
        command
            .arg(GUARD_FLAG)
            .arg(root_pid.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        let helper = HelperProcess(command.spawn()?);
        drop(command);
        if helper.0.stdin.is_none() {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "VT input guard has no request pipe",
            ));
        }
        Ok(Self {
            inner,
            helper,
            root,
            replies,
            reply_event,
            cancellation,
            timeout,
            ready: false,
        })
    }

    pub(crate) fn cancellation(&self) -> GuardCancellation {
        self.cancellation.clone()
    }

    fn check_open(&self) -> io::Result<()> {
        if unsafe { WaitForSingleObject(raw(&self.cancellation.0), 0) } != WAIT_TIMEOUT {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "VT input guard closed",
            ));
        }
        process_alive(&self.root)
    }

    fn reply(&mut self, expected: u8, deadline: Instant) -> io::Result<()> {
        self.check_open()?;
        let mut byte = 0;
        let mut count = 0;
        unsafe { ResetEvent(raw(&self.reply_event)) };
        let mut overlapped = OVERLAPPED {
            hEvent: raw(&self.reply_event),
            ..OVERLAPPED::default()
        };
        let started = unsafe {
            ReadFile(
                raw(&self.replies),
                &mut byte,
                1,
                &mut count,
                &mut overlapped,
            )
        };
        if started == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                return Err(error);
            }
            let handles = [
                raw(&self.cancellation.0),
                raw(&self.root),
                self.helper.0.as_raw_handle().cast(),
                raw(&self.reply_event),
            ];
            let remaining = deadline.saturating_duration_since(Instant::now());
            let millis = remaining.as_millis().min(u32::MAX as u128) as u32;
            let result = unsafe { WaitForMultipleObjects(4, handles.as_ptr(), 0, millis) };
            if result != WAIT_OBJECT_0 + 3 {
                // Drain cancellation before stack-backed OVERLAPPED/buffer leave scope.
                unsafe {
                    CancelIoEx(raw(&self.replies), &overlapped);
                    GetOverlappedResult(raw(&self.replies), &overlapped, &mut count, 1);
                }
                return Err(match result {
                    WAIT_OBJECT_0 => {
                        io::Error::new(io::ErrorKind::Interrupted, "VT input guard closed")
                    }
                    WAIT_TIMEOUT => io::Error::new(
                        io::ErrorKind::TimedOut,
                        "VT input guard did not reply within the PTY writer deadline",
                    ),
                    value if value == WAIT_OBJECT_0 + 1 || value == WAIT_OBJECT_0 + 2 => {
                        io::Error::new(io::ErrorKind::BrokenPipe, "OMP or VT input guard exited")
                    }
                    _ => io::Error::last_os_error(),
                });
            }
            if unsafe { GetOverlappedResult(raw(&self.replies), &overlapped, &mut count, 0) } == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        self.check_open()?;
        if count != 1 || byte != expected {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid VT input guard reply",
            ));
        }
        Ok(())
    }

    fn ready(&mut self, deadline: Instant) -> io::Result<()> {
        if !self.ready {
            self.reply(b'R', deadline)?;
            self.ready = true;
        }
        Ok(())
    }
}

impl Write for GuardedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let deadline = Instant::now() + self.timeout;
        self.ready(deadline)?;
        if bytes.is_empty() {
            return Ok(0);
        }
        self.check_open()?;
        // Only one outstanding byte: this pipe cannot fill under the private protocol.
        self.helper
            .0
            .stdin
            .as_mut()
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "VT input guard request pipe closed",
                )
            })?
            .write_all(b"I")?;
        self.reply(b'K', deadline)?;
        self.inner.write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.ready(Instant::now() + self.timeout)?;
        self.check_open()?;
        self.inner.flush()
    }
}

fn duplicate_std_handle(which: u32) -> io::Result<OwnedHandle> {
    let source = unsafe { GetStdHandle(which) };
    let process = unsafe { GetCurrentProcess() };
    let mut saved = ptr::null_mut();
    if unsafe {
        DuplicateHandle(
            process,
            source,
            process,
            &mut saved,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    own_handle(saved)
}

fn write_handle(handle: HANDLE, bytes: &[u8]) -> io::Result<()> {
    let mut written = 0;
    if unsafe {
        WriteFile(
            handle,
            bytes.as_ptr(),
            bytes.len() as u32,
            &mut written,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if written as usize != bytes.len() {
        return Err(io::Error::new(
            io::ErrorKind::WriteZero,
            "Short VT input guard write",
        ));
    }
    Ok(())
}

fn run_helper(root_pid: u32) -> io::Result<()> {
    // AttachConsole resets standard handles: save the control pipes BEFORE attachment.
    let input = duplicate_std_handle(STD_INPUT_HANDLE)?;
    let output = duplicate_std_handle(STD_OUTPUT_HANDLE)?;
    let root = open_process(root_pid)?;
    unsafe { FreeConsole() };
    let deadline = Instant::now() + ATTACH_TIMEOUT;
    loop {
        process_alive(&root)?;
        if unsafe { AttachConsole(root_pid) } != 0 {
            break;
        }
        let error = io::Error::last_os_error();
        if !matches!(error.raw_os_error(), Some(code) if code == ERROR_INVALID_HANDLE as i32 || code == ERROR_GEN_FAILURE as i32)
            || Instant::now() >= deadline
        {
            return Err(error);
        }
        // Only bounded startup attachment races are retried. No idle polling.
        thread::sleep(Duration::from_millis(10));
    }
    process_alive(&root)?;
    let name = [67u16, 79, 78, 79, 85, 84, 36, 0]; // CONOUT$
    let console = own_handle(unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            ptr::null(),
            OPEN_EXISTING,
            0,
            ptr::null_mut(),
        )
    })?;
    write_handle(raw(&output), b"R")?;
    loop {
        let mut request = 0;
        let mut count = 0;
        if unsafe { ReadFile(raw(&input), &mut request, 1, &mut count, ptr::null_mut()) } == 0 {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                Ok(())
            } else {
                Err(error)
            };
        }
        if count == 0 {
            return Ok(());
        }
        if request != b'I' {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid VT input guard request",
            ));
        }
        process_alive(&root)?;
        let mut mode = 0;
        if unsafe { GetConsoleMode(raw(&console), &mut mode) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // A not-yet-VT startup console cannot enable 9001 or interpret its control bytes.
        // Output-mode control, NEVER terminal stdin or a guessed key translation.
        if mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING != 0 {
            write_handle(raw(&console), DISABLE_WIN32_INPUT)?;
        }
        process_alive(&root)?;
        write_handle(raw(&output), b"K")?;
    }
}

/// Called from main before Tauri, single-instance handling, settings or logging.
/// Malformed private invocations must fail rather than accidentally opening the GUI.
pub fn run_private_cli() -> Option<i32> {
    let mut args = env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(GUARD_FLAG)) {
        return None;
    }
    let pid = args
        .next()
        .and_then(|arg| arg.to_str().and_then(|text| text.parse::<u32>().ok()));
    Some(match pid {
        Some(pid) if pid != 0 && args.next().is_none() => {
            if run_helper(pid).is_ok() {
                0
            } else {
                1
            }
        }
        _ => 2,
    })
}
