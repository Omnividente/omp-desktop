mod native_lifecycle {
    use super::*;
    use super::super::{
        close_terminal_in_state, finalize_terminal_exit_in_state,
        native_pty_system, read_terminal_chunk, release_terminal_io_after_wait,
        stop_terminal_for_restart, terminal_child_exit_event, ChildKiller, CommandBuilder,
        PtySize, SharedTerminalOutput, PTY_EXIT_FINALIZE_TIMEOUT,
    };
    use std::time::Instant;

    const TEST: &str = "terminal::tests::native_lifecycle::native_pty_exit_stop_reclose_boundary";
    const ROOT: &str = "OMP_NATIVE_LIFECYCLE_ROOT";
    const ID: &str = "isolated-native-terminal";

    struct OwnedChild(Option<Box<dyn portable_pty::Child + Send + Sync>>);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            if let Some(child) = self.0.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    struct Fixture {
        root: PathBuf,
        session: PathBuf,
        state: Arc<TerminalState>,
        output: SharedTerminalOutput,
        killer: Box<dyn ChildKiller + Send + Sync>,
        waited: mpsc::Receiver<PtyExitEvent>,
        completed: mpsc::Receiver<()>,
        observed_exit: bool,
        workers: Vec<thread::JoinHandle<()>>,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("omp-native-lifecycle-{:032x}", rand::random::<u128>()));
            fs::create_dir(&root).unwrap();
            let session = root.join("history.jsonl");
            fs::write(&session, b"{\"type\":\"session\",\"id\":\"native-boundary\",\"cwd\":\"/synthetic\"}\n").unwrap();
            let pair = native_pty_system().openpty(PtySize {
                rows: 24, cols: 80, pixel_width: 0, pixel_height: 0,
            }).unwrap();
            let mut command = CommandBuilder::new(std::env::current_exe().unwrap());
            command.args(["--ignored", "--exact", TEST, "--nocapture"]);
            command.env(ROOT, &root);
            let mut child = OwnedChild(Some(pair.slave.spawn_command(command).unwrap()));
            drop(pair.slave);
            let native = child.0.as_ref().unwrap();
            let killer = native.clone_killer();
            let mut reader = pair.master.try_clone_reader().unwrap();
            let mut process = terminal_process(Some(session.to_string_lossy().into_owned()), None);
            process.process_id = native.process_id();
            process.killer = Some(native.clone_killer());
            #[cfg(windows)]
            process._containment.assign(native.as_raw_handle().unwrap()).unwrap();
            process.master = Some(pair.master);
            process.session_lease = Some(SessionLease::acquire(&session, SessionLeasePurpose::Resume, false).unwrap());
            let output = process.output.clone();
            let state = Arc::new(TerminalState::default());
            let (ack_sender, ack_receiver) = mpsc::sync_channel(1);
            process.exit_waiter = Some(ack_receiver);
            lock_processes(&state).insert(ID.into(), process);
            let (output_sender, output_receiver) = mpsc::sync_channel(8);
            let output_waker = output_sender.clone();
            let (exit_sender, exit_receiver) = mpsc::sync_channel(1);
            let (waited_sender, waited) = mpsc::channel();
            let (completed_sender, completed) = mpsc::channel();
            let reader_worker = thread::spawn(move || {
                let mut buffer = [0_u8; 8192];
                loop {
                    match read_terminal_chunk(reader.as_mut(), &mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(count) => {
                            if output_sender.send(buffer[..count].to_vec()).is_err() { break; }
                        }
                    }
                }
            });
            let pipeline_state = state.clone();
            let pipeline_output = output.clone();
            let pipeline_worker = thread::spawn(move || {
                // Real bytes and a real child.wait event drive the same drain/finalize
                // helpers as production. The acknowledgement is never injected by a test.
                run_output_pipeline(output_receiver, exit_receiver, PTY_EXIT_FINALIZE_TIMEOUT,
                    |bytes| { let _ = lock_terminal_output(&pipeline_output).record(bytes); },
                    |event| {
                        finalize_terminal_exit_in_state(&pipeline_state, ID, &pipeline_output, &event);
                    });
                let _ = ack_sender.send(());
                let _ = completed_sender.send(());
            });
            let waiter_state = state.clone();
            let waiter_output = output.clone();
            let mut native = child.0.take().unwrap();
            let waiter_worker = thread::spawn(move || {
                let status = native.wait();
                let failed = status.is_err();
                let event = terminal_child_exit_event(ID, status);
                let _ = waited_sender.send(event.clone());
                if !release_terminal_io_after_wait(&waiter_state, ID, &waiter_output, failed) { return; }
                let fallback = event.clone();
                if let Err(error) = exit_sender.send(event) {
                    finalize_terminal_exit_in_state(&waiter_state, ID, &waiter_output, &error.0);
                    return;
                }
                if output_waker.send(Vec::new()).is_err() {
                    finalize_terminal_exit_in_state(&waiter_state, ID, &waiter_output, &fallback);
                }
            });
            let fixture = Self { root, session, state, output, killer, waited, completed,
                observed_exit: false, workers: vec![reader_worker, pipeline_worker, waiter_worker] };
            let deadline = Instant::now() + Duration::from_secs(15);
            while !fixture.root.join("ready").is_file() {
                assert!(Instant::now() < deadline, "native child readiness watchdog");
                thread::sleep(Duration::from_millis(10));
            }
            fixture
        }

        fn wait_for_real_exit_and_drain(&mut self) -> PtyExitEvent {
            let event = self.waited.recv_timeout(Duration::from_secs(15)).expect("actual child.wait did not complete");
            self.observed_exit = true;
            assert!(event.exit_code.is_some(), "native wait failed rather than observing child exit");
            self.completed.recv_timeout(Duration::from_secs(15)).expect("actual output pipeline did not finish");
            event
        }

        fn assert_lease_available(&self) {
            drop(SessionLease::acquire(&self.session, SessionLeasePurpose::Resume, false).unwrap());
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            if !self.observed_exit && self.waited.try_recv().is_err() {
                let _ = self.killer.kill();
            }
            self.state.shutdown_all();
            // Only fixture-owned PTY/child/workers are touched. A watchdog failure is
            // not permission to kill unrelated processes or change native timeouts.
            let deadline = Instant::now() + Duration::from_secs(15);
            while self.workers.iter().any(|worker| !worker.is_finished()) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            for worker in self.workers.drain(..) {
                if worker.is_finished() { let _ = worker.join(); }
            }
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    #[ignore = "isolated actual PTY/process lifecycle matrix; Main runs on Windows and Linux"]
    fn native_pty_exit_stop_reclose_boundary() {
        if let Some(root) = std::env::var_os(ROOT) {
            let root = PathBuf::from(root);
            fs::write(root.join("ready"), b"ready").unwrap();
            let deadline = Instant::now() + Duration::from_secs(60);
            while !root.join("release").is_file() {
                assert!(Instant::now() < deadline, "native child release watchdog");
                thread::sleep(Duration::from_millis(10));
            }
            println!("NATIVE_BOUNDARY_FINAL_OUTPUT");
            std::io::stdout().flush().unwrap();
            return;
        }
        for mode in ["natural", "stop", "close"] {
            let mut fixture = Fixture::new();
            assert!(fixture.state.is_session_active(fixture.session.to_str().unwrap()));
            assert!(SessionLease::acquire(&fixture.session, SessionLeasePurpose::Resume, false).is_err());
            match mode {
                "natural" => {
                    fs::write(fixture.root.join("release"), b"release").unwrap();
                    assert!(fixture.wait_for_real_exit_and_drain().success);
                    let processes = lock_processes(&fixture.state);
                    let process = processes.get(ID).unwrap();
                    assert!(process.exited);
                    assert!(!process.exit_pending);
                    assert!(process.session_lease.is_none());
                    drop(processes);
                    let attachment = lock_terminal_output(&fixture.output).attach(&TerminalAttachmentRequest {
                        terminal_id: ID.into(), attachment_id: "native-proof".into(), generation: None, after_seq: None,
                    }).unwrap();
                    assert!(String::from_utf8_lossy(&attachment.snapshot.data).contains("NATIVE_BOUNDARY_FINAL_OUTPUT"));
                }
                "stop" => {
                    #[cfg(windows)]
                    unsafe {
                        windows_sys::Win32::Foundation::SetLastError(
                            windows_sys::Win32::Foundation::ERROR_LOCK_VIOLATION,
                        );
                    }
                    stop_terminal_for_restart(ID, &fixture.state).unwrap();
                    fixture.wait_for_real_exit_and_drain();
                    assert!(lock_processes(&fixture.state).is_empty());
                }
                "close" => {
                    close_terminal_in_state(ID, &fixture.state).unwrap();
                    fixture.wait_for_real_exit_and_drain();
                    assert!(lock_processes(&fixture.state).is_empty());
                }
                _ => unreachable!(),
            }
            fixture.assert_lease_available();
            for _ in 0..2 { close_terminal_in_state(ID, &fixture.state).unwrap(); }
            assert!(lock_processes(&fixture.state).is_empty());
            assert!(lock_terminal_output(&fixture.output).closed);
            assert_eq!(fs::read(&fixture.session).unwrap(), b"{\"type\":\"session\",\"id\":\"native-boundary\",\"cwd\":\"/synthetic\"}\n");
        }
    }
}
