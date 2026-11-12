// Characterization of the current close contract, not native process-exit proof.
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
}
