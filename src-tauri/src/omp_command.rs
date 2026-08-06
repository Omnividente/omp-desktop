use std::{
    collections::HashMap,
    fmt,
    io::{self, Read},
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const POLL_INTERVAL: Duration = Duration::from_millis(20);
pub(crate) const GITHUB_AUTH_ENV_KEYS: [&str; 2] = ["GITHUB_TOKEN", "GH_TOKEN"];

fn apply_omp_environment(
    command: &mut Command,
    env_map: &HashMap<String, String>,
    operation: OmpOperation,
) {
    for (key, value) in env_map {
        command.env(key, value);
    }
    if operation == OmpOperation::Update {
        for key in GITHUB_AUTH_ENV_KEYS {
            command.env_remove(key);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OmpOperation {
    Probe,
    Config,
    Models,
    Usage,
    Update,
}

impl OmpOperation {
    pub fn label(self) -> &'static str {
        match self {
            Self::Probe => "probe",
            Self::Config => "config",
            Self::Models => "models",
            Self::Usage => "usage",
            Self::Update => "update",
        }
    }

    fn limits(self) -> CommandLimits {
        match self {
            Self::Probe => CommandLimits::new(Duration::from_secs(5), 16 * 1024),
            Self::Config => CommandLimits::new(Duration::from_secs(15), 512 * 1024),
            Self::Models => CommandLimits::new(Duration::from_secs(30), 4 * 1024 * 1024),
            Self::Usage => CommandLimits::new(Duration::from_secs(45), 4 * 1024 * 1024),
            Self::Update => CommandLimits::new(Duration::from_secs(90), 512 * 1024),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct CommandLimits {
    timeout: Duration,
    stdout_limit: usize,
    stderr_limit: usize,
}

impl CommandLimits {
    const fn new(timeout: Duration, output_limit: usize) -> Self {
        Self {
            timeout,
            stdout_limit: output_limit,
            stderr_limit: output_limit,
        }
    }
}

pub struct OmpCommandOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Debug)]
pub enum OmpCommandError {
    Spawn {
        operation: &'static str,
        error: io::Error,
    },
    Pipe {
        operation: &'static str,
        stream: &'static str,
    },
    ReaderSpawn {
        operation: &'static str,
        stream: &'static str,
        error: io::Error,
    },
    Wait {
        operation: &'static str,
        error: io::Error,
    },
    Timeout {
        operation: &'static str,
        timeout: Duration,
    },
    Reader {
        operation: &'static str,
        stream: &'static str,
        error: String,
    },
    OutputLimit {
        operation: &'static str,
        stream: &'static str,
        limit: usize,
    },
}

impl OmpCommandError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Timeout { .. } => "omp_timeout",
            Self::OutputLimit { .. } => "omp_output_limit",
            Self::Spawn { .. } => "omp_spawn_failed",
            Self::Pipe { .. }
            | Self::ReaderSpawn { .. }
            | Self::Wait { .. }
            | Self::Reader { .. } => "omp_io_failed",
        }
    }
}

impl fmt::Display for OmpCommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn { operation, error } => {
                write!(formatter, "не удалось запустить OMP {operation}: {error}")
            }
            Self::Pipe { operation, stream } => {
                write!(formatter, "OMP {operation} не открыл поток {stream}")
            }
            Self::ReaderSpawn {
                operation,
                stream,
                error,
            } => write!(
                formatter,
                "не удалось запустить чтение {stream} для OMP {operation}: {error}"
            ),
            Self::Wait { operation, error } => {
                write!(formatter, "не удалось дождаться OMP {operation}: {error}")
            }
            Self::Timeout { operation, timeout } => write!(
                formatter,
                "OMP {operation} превысил таймаут {} с и был остановлен",
                timeout.as_secs()
            ),
            Self::Reader {
                operation,
                stream,
                error,
            } => write!(
                formatter,
                "не удалось прочитать {stream} OMP {operation}: {error}"
            ),
            Self::OutputLimit {
                operation,
                stream,
                limit,
            } => write!(
                formatter,
                "OMP {operation} превысил лимит {stream} ({limit} байт)"
            ),
        }
    }
}

pub fn run_omp_command(
    executable: &str,
    args: &[&str],
    env_map: &HashMap<String, String>,
    operation: OmpOperation,
) -> Result<OmpCommandOutput, OmpCommandError> {
    let mut command = Command::new(executable);
    command.args(args);
    apply_omp_environment(&mut command, env_map, operation);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    run_command(command, operation.label(), operation.limits())
}

fn run_command(
    mut command: Command,
    operation: &'static str,
    limits: CommandLimits,
) -> Result<OmpCommandOutput, OmpCommandError> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| OmpCommandError::Spawn { operation, error })?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            kill_and_wait(&mut child);
            return Err(OmpCommandError::Pipe {
                operation,
                stream: "stdout",
            });
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            kill_and_wait(&mut child);
            return Err(OmpCommandError::Pipe {
                operation,
                stream: "stderr",
            });
        }
    };

    let stdout_reader = thread::Builder::new()
        .name(format!("omp-{operation}-stdout"))
        .spawn(move || read_bounded(stdout, limits.stdout_limit))
        .map_err(|error| {
            kill_and_wait(&mut child);
            OmpCommandError::ReaderSpawn {
                operation,
                stream: "stdout",
                error,
            }
        })?;
    let stderr_reader = match thread::Builder::new()
        .name(format!("omp-{operation}-stderr"))
        .spawn(move || read_bounded(stderr, limits.stderr_limit))
    {
        Ok(reader) => reader,
        Err(error) => {
            kill_and_wait(&mut child);
            return Err(OmpCommandError::ReaderSpawn {
                operation,
                stream: "stderr",
                error,
            });
        }
    };

    let deadline = Instant::now() + limits.timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(POLL_INTERVAL),
            Ok(None) => {
                kill_and_wait(&mut child);
                return Err(OmpCommandError::Timeout {
                    operation,
                    timeout: limits.timeout,
                });
            }
            Err(error) => {
                kill_and_wait(&mut child);
                return Err(OmpCommandError::Wait { operation, error });
            }
        }
    };

    let stdout = join_reader_until(stdout_reader, operation, "stdout", deadline, limits.timeout)?;
    let stderr = join_reader_until(stderr_reader, operation, "stderr", deadline, limits.timeout)?;
    if stdout.truncated {
        return Err(OmpCommandError::OutputLimit {
            operation,
            stream: "stdout",
            limit: limits.stdout_limit,
        });
    }
    if stderr.truncated {
        return Err(OmpCommandError::OutputLimit {
            operation,
            stream: "stderr",
            limit: limits.stderr_limit,
        });
    }

    Ok(OmpCommandOutput {
        status,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
    })
}

fn kill_and_wait(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

struct BoundedRead {
    bytes: Vec<u8>,
    truncated: bool,
}

fn read_bounded(mut reader: impl Read, limit: usize) -> io::Result<BoundedRead> {
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    let mut truncated = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len());
        let keep = remaining.min(read);
        bytes.extend_from_slice(&buffer[..keep]);
        truncated |= keep < read;
    }
    Ok(BoundedRead { bytes, truncated })
}

fn join_reader_until(
    reader: thread::JoinHandle<io::Result<BoundedRead>>,
    operation: &'static str,
    stream: &'static str,
    deadline: Instant,
    timeout: Duration,
) -> Result<BoundedRead, OmpCommandError> {
    while !reader.is_finished() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(OmpCommandError::Timeout { operation, timeout });
        }
        thread::sleep(POLL_INTERVAL.min(remaining));
    }
    join_reader(reader, operation, stream)
}

fn join_reader(
    reader: thread::JoinHandle<io::Result<BoundedRead>>,
    operation: &'static str,
    stream: &'static str,
) -> Result<BoundedRead, OmpCommandError> {
    match reader.join() {
        Ok(Ok(capture)) => Ok(capture),
        Ok(Err(error)) => Err(OmpCommandError::Reader {
            operation,
            stream,
            error: error.to_string(),
        }),
        Err(_) => Err(OmpCommandError::Reader {
            operation,
            stream,
            error: "поток чтения завершился паникой".to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{ffi::OsStr, io::Cursor};

    #[test]
    fn bounded_reader_keeps_prefix_and_reports_overflow() {
        let capture = read_bounded(Cursor::new(b"abcdefgh"), 4).unwrap();
        assert_eq!(capture.bytes, b"abcd");
        assert!(capture.truncated);
    }

    #[test]
    fn operation_deadlines_are_distinct() {
        assert!(OmpOperation::Probe.limits().timeout < OmpOperation::Config.limits().timeout);
        assert!(OmpOperation::Config.limits().timeout < OmpOperation::Models.limits().timeout);
        assert!(OmpOperation::Models.limits().timeout < OmpOperation::Usage.limits().timeout);
        assert!(OmpOperation::Usage.limits().timeout < OmpOperation::Update.limits().timeout);
    }

    #[test]
    fn update_commands_drop_github_auth_without_affecting_other_operations() {
        let env_map = HashMap::from([
            ("GITHUB_TOKEN".to_owned(), "stale-token".to_owned()),
            ("GH_TOKEN".to_owned(), "stale-token".to_owned()),
        ]);
        let mut update = Command::new("omp");
        apply_omp_environment(&mut update, &env_map, OmpOperation::Update);
        for key in GITHUB_AUTH_ENV_KEYS {
            assert!(update
                .get_envs()
                .any(|(name, value)| name == OsStr::new(key) && value.is_none()));
        }

        let mut models = Command::new("omp");
        apply_omp_environment(&mut models, &env_map, OmpOperation::Models);
        for key in GITHUB_AUTH_ENV_KEYS {
            assert!(models.get_envs().any(|(name, value)| {
                name == OsStr::new(key) && value == Some(OsStr::new("stale-token"))
            }));
        }
    }

    #[test]
    fn timed_out_process_is_terminated_and_reaped() {
        #[cfg(windows)]
        let command = {
            let mut command = Command::new("cmd.exe");
            command.args(["/C", "ping -n 6 127.0.0.1 >NUL"]);
            command.creation_flags(CREATE_NO_WINDOW);
            command
        };
        #[cfg(not(windows))]
        let command = {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 2"]);
            command
        };

        let result = run_command(
            command,
            "timeout-test",
            CommandLimits::new(Duration::from_millis(50), 1024),
        );
        assert!(matches!(result, Err(OmpCommandError::Timeout { .. })));
    }

    #[test]
    fn reader_wait_is_bounded_by_command_deadline() {
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let reader = thread::spawn(move || {
            let _ = release_receiver.recv();
            Ok::<_, io::Error>(BoundedRead {
                bytes: Vec::new(),
                truncated: false,
            })
        });
        let timeout = Duration::from_millis(50);
        let started = Instant::now();
        let result = join_reader_until(
            reader,
            "reader-timeout-test",
            "stdout",
            started + timeout,
            timeout,
        );
        let elapsed = started.elapsed();
        let _ = release_sender.send(());

        assert!(matches!(result, Err(OmpCommandError::Timeout { .. })));
        assert!(elapsed < Duration::from_secs(1), "reader timeout took {elapsed:?}");
    }

    #[cfg(not(windows))]
    #[test]
    fn timeout_is_not_extended_by_descendant_holding_output_pipe() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 2 & wait"]);
        let timeout = Duration::from_millis(50);
        let started = Instant::now();
        let result = run_command(
            command,
            "inherited-pipe-timeout-test",
            CommandLimits::new(timeout, 1024),
        );
        let elapsed = started.elapsed();

        assert!(matches!(result, Err(OmpCommandError::Timeout { .. })));
        assert!(
            elapsed < Duration::from_secs(1),
            "timeout waited for an inherited pipe for {elapsed:?}"
        );
    }
}
