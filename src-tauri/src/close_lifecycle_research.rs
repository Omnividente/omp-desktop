// Characterization, not Desktop native acceptance: injected killer/completion.
mod close_lifecycle_research {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Debug, Clone)]
    struct ControlledKiller {
        calls: Arc<AtomicUsize>,
        refuse: bool,
    }

    impl portable_pty::ChildKiller for ControlledKiller {
        fn kill(&mut self) -> io::Result<()> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.refuse {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "synthetic refusal",
                ))
            } else {
                Ok(())
            }
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }

    fn fixture(refuse: bool) -> (TerminalState, Arc<AtomicUsize>, mpsc::Sender<()>) {
        let state = TerminalState::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let mut process = terminal_process(None, None);
        // No OS process is spawned or assigned to the empty Windows Job Object.
        process.process_id = None;
        process.killer = Some(Box::new(ControlledKiller {
            calls: calls.clone(),
            refuse,
        }));
        let (sender, receiver) = mpsc::channel();
        process.exit_waiter = Some(receiver);
        lock_processes(&state).insert("synthetic-close".to_owned(), process);
        (state, calls, sender)
    }

    #[test]
    fn close_reports_ok_even_when_the_injected_killer_refuses() {
        let (state, calls, _completion) = fixture(true);
        assert!(super::super::close_terminal_in_state("synthetic-close", &state).is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(lock_processes(&state).is_empty());
    }

    #[test]
    fn close_does_not_wait_for_the_withheld_completion_signal() {
        let (state, calls, completion) = fixture(false);
        assert!(super::super::close_terminal_in_state("synthetic-close", &state).is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(lock_processes(&state).is_empty());
        // The signal was never sent before close. Its receiver was dropped,
        // so a later completion cannot acknowledge this removed entry.
        assert!(completion.send(()).is_err());
    }

    #[test]
    fn repeated_close_does_not_retry_a_refused_kill() {
        let (state, calls, _completion) = fixture(true);
        for _ in 0..2 {
            assert!(super::super::close_terminal_in_state("synthetic-close", &state).is_ok());
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(lock_processes(&state).is_empty());
    }

    const CHILD_ROOT: &str = "OMP_DESKTOP_CLOSE_RESEARCH_CHILD_ROOT";
    const CHILD_TEST: &str = "terminal::tests::close_lifecycle_research::native_child_entry";

    #[test]
    fn native_child_entry() {
        let Some(root) = std::env::var_os(CHILD_ROOT) else {
            return;
        };
        let root = PathBuf::from(root);
        fs::write(root.join("ready"), b"ready").expect("publish fixture readiness");
        let deadline = std::time::Instant::now() + Duration::from_secs(120);
        while !root.join("release").is_file() {
            assert!(std::time::Instant::now() < deadline, "child watchdog expired");
            thread::sleep(Duration::from_millis(10));
        }
    }

    struct OwnedChildProbe {
        child: std::process::Child,
        root: PathBuf,
    }

    impl OwnedChildProbe {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "omp-close-probe-{}-{nonce}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir(&root).expect("create private fixture directory");
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", CHILD_TEST, "--nocapture"])
                .env(CHILD_ROOT, &root)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("spawn only this test executable's fixture entry");
            let mut probe = Self { child, root };
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while !probe.root.join("ready").is_file() {
                assert!(
                    probe.child.try_wait().unwrap().is_none(),
                    "child exited early"
                );
                assert!(
                    std::time::Instant::now() < deadline,
                    "child readiness timeout"
                );
                thread::sleep(Duration::from_millis(10));
            }
            probe
        }

        fn release(&self) {
            fs::write(self.root.join("release"), b"release").expect("release owned child");
        }

        fn observe_exit(&mut self) -> std::process::ExitStatus {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                if let Some(status) = self.child.try_wait().expect("observe owned child") {
                    return status;
                }
                assert!(std::time::Instant::now() < deadline, "child exit timeout");
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    impl Drop for OwnedChildProbe {
        fn drop(&mut self) {
            if !matches!(self.child.try_wait(), Ok(Some(_))) {
                let _ = self.child.kill();
            }
            let _ = self.child.wait();
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn native_fixture(
        child: &OwnedChildProbe,
        refuse: bool,
    ) -> (TerminalState, Arc<AtomicUsize>, mpsc::Sender<()>) {
        let (state, calls, completion) = fixture(refuse);
        {
            let mut processes = lock_processes(&state);
            let process = processes.get_mut("synthetic-close").unwrap();
            process.process_id = Some(child.child.id());
            #[cfg(windows)]
            {
                use std::os::windows::io::AsRawHandle;
                process
                    ._containment
                    .assign(child.child.as_raw_handle())
                    .expect("assign owned child before exercising close/stop");
            }
        }
        (state, calls, completion)
    }

    #[test]
    fn native_close_refusal_distinguishes_windows_containment_from_linux() {
        let mut child = OwnedChildProbe::new();
        let (state, calls, _completion) = native_fixture(&child, true);
        for _ in 0..2 {
            assert!(super::super::close_terminal_in_state("synthetic-close", &state).is_ok());
        }
        assert!(lock_processes(&state).is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        #[cfg(windows)]
        {
            child.observe_exit();
        }
        #[cfg(not(windows))]
        {
            // No PTY master exists in this fixture. This does not model PTY hangup.
            assert!(child.child.try_wait().unwrap().is_none());
            child.release();
            assert!(child.observe_exit().success());
        }
    }

    #[test]
    fn native_restart_stop_refusal_retains_state_and_live_child() {
        let mut child = OwnedChildProbe::new();
        let (state, calls, _completion) = native_fixture(&child, true);
        assert!(super::super::stop_terminal_for_restart("synthetic-close", &state).is_err());
        {
            let processes = lock_processes(&state);
            let process = processes.get("synthetic-close").unwrap();
            assert!(!process.exit_pending);
            assert!(process.exit_waiter.is_some());
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(child.child.try_wait().unwrap().is_none());
        child.release();
        assert!(child.observe_exit().success());
    }

    fn start_pending_stop(
        state: Arc<TerminalState>,
    ) -> (thread::JoinHandle<()>, mpsc::Receiver<Result<(), String>>) {
        let (sender, receiver) = mpsc::channel();
        let worker_state = state.clone();
        let worker = thread::spawn(move || {
            let _ = sender.send(super::super::stop_terminal_for_restart(
                "synthetic-close",
                &worker_state,
            ));
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let pending = lock_processes(&state)
                .get("synthetic-close")
                .is_some_and(|process| process.exit_pending && process.exit_waiter.is_none());
            if pending {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "stop did not reach waiting state"
            );
            thread::sleep(Duration::from_millis(1));
        }
        (worker, receiver)
    }

    #[test]
    fn native_restart_stop_distinguishes_process_exit_from_completion() {
        let mut child = OwnedChildProbe::new();
        let (state, calls, completion) = native_fixture(&child, false);
        let state = Arc::new(state);
        let (worker, result) = start_pending_stop(state.clone());
        assert!(child.child.try_wait().unwrap().is_none());
        assert!(super::super::stop_terminal_for_restart("synthetic-close", &state).is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        child.release();
        assert!(child.observe_exit().success());
        // Real OS exit was observed above, but the output-completion signal is withheld.
        assert!(matches!(result.try_recv(), Err(mpsc::TryRecvError::Empty)));
        assert!(lock_processes(&state).contains_key("synthetic-close"));
        completion
            .send(())
            .expect("deliver controlled completion after observed OS exit");
        assert!(result.recv_timeout(Duration::from_secs(10)).unwrap().is_ok());
        worker.join().unwrap();
        assert!(lock_processes(&state).is_empty());
    }

    #[test]
    fn late_restart_completion_removes_a_forced_replacement_on_ack_or_disconnect() {
        // A forced map replacement assesses reuse of this helper in a new close design;
        // it is not evidence that production currently reuses terminal IDs this way.
        for disconnect in [false, true] {
            let mut child = OwnedChildProbe::new();
            let (state, _calls, completion) = native_fixture(&child, false);
            let state = Arc::new(state);
            let (worker, result) = start_pending_stop(state.clone());
            let replacement = terminal_process(None, None);
            let replacement_output = replacement.output.clone();
            let previous = lock_processes(&state)
                .insert("synthetic-close".to_owned(), replacement)
                .unwrap();
            // Hold old ownership/containment until this child's real exit is observed.
            child.release();
            assert!(child.observe_exit().success());
            assert!(Arc::ptr_eq(
                &lock_processes(&state).get("synthetic-close").unwrap().output,
                &replacement_output,
            ));
            if disconnect {
                drop(completion);
            } else {
                completion.send(()).unwrap();
            }
            let outcome = result.recv_timeout(Duration::from_secs(10)).unwrap();
            assert_eq!(outcome.is_err(), disconnect);
            worker.join().unwrap();
            assert!(lock_processes(&state).is_empty());
            assert!(lock_terminal_output(&replacement_output).closed);
            drop(previous);
        }
    }
}
