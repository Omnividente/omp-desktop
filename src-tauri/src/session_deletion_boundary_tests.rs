mod boundary_tests {
    use super::*;
    use crate::models::AppSettings;

    fn pinned_settings(fixture: &Fixture) -> (PathBuf, Vec<u8>) {
        let mut settings = AppSettings::default();
        let key = crate::sessions::path_key(fixture.session.to_str().unwrap());
        settings.session_title_pins.insert(key.clone(), "Keep title".into());
        settings.primary_provider_pins.insert(key);
        let bytes = serde_json::to_vec(&settings).unwrap();
        let path = fixture.root.join("settings.json");
        atomic_write_private_file(&path, &bytes).unwrap();
        (path, bytes)
    }

    #[test]
    fn settings_are_untouched_until_deletion_commits() {
        for failure in ["prepared", "artifacts", "session"] {
            let fixture = Fixture::new();
            let (path, bytes) = pinned_settings(&fixture);
            let result = delete_with(&fixture.session, |stage| {
                if stage == failure { Err("injected failure".into()) } else { Ok(()) }
            });
            assert!(settle(result, || {
                atomic_write_private_file(&path, b"must never be written")
            }).is_err());
            assert_eq!(fs::read(path).unwrap(), bytes);
            fixture.preserved();
        }
    }

    #[test]
    fn settings_write_failure_after_commit_does_not_resurrect_history() {
        for after_publication in [false, true] {
            let fixture = Fixture::new();
            let (path, original) = pinned_settings(&fixture);
            let cleaned = serde_json::to_vec(&AppSettings::default()).unwrap();
            let result = delete(&fixture.session);
            let warning = settle(result, || {
                if after_publication {
                    atomic_write_private_file(&path, &cleaned)?;
                }
                Err("injected settings failure".into())
            }).unwrap().unwrap();
            assert!(warning.contains("injected settings failure"));
            assert!(!fixture.session.exists());
            assert!(!fixture.artifact.exists());
            assert_eq!(fs::read(&path).unwrap(), if after_publication { cleaned } else { original });
            assert!(fixture.recover().0.is_empty());
            assert!(!fixture.session.exists());
        }
    }

    #[test]
    fn unrecognized_artifact_object_is_not_silently_left_behind() {
        let fixture = Fixture::new();
        fs::remove_dir_all(fixture.session.with_extension("")).unwrap();
        fs::write(fixture.session.with_extension(""), b"unrecognized data").unwrap();
        let original = fs::read(&fixture.session).unwrap();
        assert!(delete(&fixture.session).is_err());
        assert_eq!(fs::read(&fixture.session).unwrap(), original);
        assert_eq!(fs::read(fixture.session.with_extension("")).unwrap(), b"unrecognized data");
        assert!(fixture.transactions().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn artifact_symlink_deletion_never_follows_its_target() {
        let fixture = Fixture::new();
        let outside = fixture.root.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep"), b"outside data").unwrap();
        fs::remove_dir_all(fixture.session.with_extension("")).unwrap();
        std::os::unix::fs::symlink(&outside, fixture.session.with_extension("")).unwrap();
        assert!(matches!(delete(&fixture.session), Ok(DeleteOutcome::Committed(_))));
        assert_eq!(fs::read(outside.join("keep")).unwrap(), b"outside data");
        assert!(!fixture.session.exists());
        assert!(fs::symlink_metadata(fixture.session.with_extension("")).is_err());
    }

    #[test]
    fn opaque_journal_preserves_valid_siblings_and_reserves_missing_import_names() {
        use crate::models::{ImportItemStatus, ImportMode, ImportSessionRequest};
        let fixture = Fixture::new();
        let project = fixture.root.join("project");
        fs::create_dir(&project).unwrap();
        let session_root = fixture.root.join("sessions");
        let target = crate::sessions::canonical_project_path(project.to_str().unwrap()).unwrap();
        let directory = session_root.join(crate::sessions::encode_session_dir_name(target.to_str().unwrap()));
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("history.jsonl");
        fs::copy(&fixture.session, &source).unwrap();
        drop(SessionLease::acquire(&source, SessionLeasePurpose::Delete, false).unwrap());
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _ = delete_with(&source, |stage| {
                assert_ne!(stage, "session", "interrupted deletion");
                Ok(())
            });
        }));
        let opaque = directory.join(format!("{PREFIX}{:032x}", rand::random::<u128>()));
        fs::create_dir(&opaque).unwrap();
        fs::write(opaque.join("intent.json"), b"unreadable intent").unwrap();
        let mut warnings = Vec::new();
        let mut blocked = HashSet::new();
        recover_directory(&directory, &mut warnings, &mut blocked, None);
        assert!(!warnings.is_empty());
        assert!(blocked.contains(&directory));
        assert!(!source.exists(), "valid sibling journal must remain untouched");
        for mode in [ImportMode::Skip, ImportMode::Update, ImportMode::Copy] {
            let results = crate::sessions::import_sessions(&[ImportSessionRequest {
                path: fixture.session.to_string_lossy().into_owned(),
                target_cwd: project.to_string_lossy().into_owned(), mode,
            }], &session_root, &HashSet::new());
            assert_eq!(results[0].status, ImportItemStatus::Failed);
            assert_eq!(results[0].destination_path, None);
        }
        assert!(!source.exists());
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 3);
        fixture.preserved();
    }

    #[cfg(windows)]
    #[test]
    fn duplicate_journals_with_case_aliases_block_the_real_directory_entries() {
        let fixture = Fixture::new();
        for source in ["history.jsonl", "HISTORY.JSONL"] {
            let directory = fixture.root.join(format!("{PREFIX}{:032x}", rand::random::<u128>()));
            fs::create_dir(&directory).unwrap();
            write_intent(&directory, &Intent {
                version: 1, source: source.into(), artifacts: true, phase: Phase::Prepared,
            }).unwrap();
        }
        let (warnings, blocked) = fixture.recover();
        assert_eq!(warnings.len(), 2);
        assert!(blocked.contains(&fixture.session));
        assert!(blocked.contains(&fixture.session.with_extension("")));
        fixture.preserved();
    }

    #[cfg(windows)]
    #[test]
    fn denied_jsonl_move_preserves_artifacts_through_the_actual_lease_path() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
        let fixture = Fixture::new();
        let _reader = OpenOptions::new().read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE).open(&fixture.session).unwrap();
        let lease = SessionLease::acquire(&fixture.session, SessionLeasePurpose::Delete, false).unwrap();
        let result = crate::sessions::delete_session(fixture.session.to_str().unwrap(), &fixture.root, &lease);
        assert!(result.is_err(), "denied JSONL move must roll back artifact staging");
        fixture.preserved();
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "run as an unprivileged user: exercises real filesystem permission denial"]
    fn denied_parent_preserves_artifacts_through_the_actual_lease_path() {
        use std::os::unix::fs::PermissionsExt;
        struct Restore(PathBuf);
        impl Drop for Restore {
            fn drop(&mut self) {
                let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
            }
        }
        let fixture = Fixture::new();
        let restore = Restore(fixture.root.clone());
        fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o500)).unwrap();
        assert!(fs::write(fixture.root.join("permission-probe"), b"probe").is_err(),
            "runner bypasses the required permission boundary");
        let lease = SessionLease::acquire(&fixture.session, SessionLeasePurpose::Delete, false).unwrap();
        let result = crate::sessions::delete_session(fixture.session.to_str().unwrap(), &fixture.root, &lease);
        assert!(result.is_err());
        fixture.preserved();
        drop(lease);
        drop(restore);
    }

    #[test]
    #[ignore = "isolated subprocess crash/restart matrix; Main runs explicitly"]
    fn interrupted_deletion_and_settings_restart_matrix() {
        const ROOT: &str = "OMP_DELETE_BOUNDARY_ROOT";
        const PHASE: &str = "OMP_DELETE_BOUNDARY_PHASE";
        const TEST: &str = "session_deletion::tests::boundary_tests::interrupted_deletion_and_settings_restart_matrix";
        if let Some(root) = std::env::var_os(ROOT) {
            let root = PathBuf::from(root);
            assert_eq!(fs::read(root.join("boundary-fixture")).unwrap(), b"synthetic deletion fixture");
            let session = root.join("history.jsonl");
            let lease = SessionLease::acquire(&session, SessionLeasePurpose::Delete, false).unwrap();
            let phase = std::env::var(PHASE).unwrap();
            let result = delete_with(&session, |stage| {
                if stage == phase { std::process::exit(86); }
                Ok(())
            });
            let _ = settle(result, || {
                if phase == "settings-before" { std::process::exit(86); }
                atomic_write_private_file(&root.join("settings.json"), &serde_json::to_vec(&AppSettings::default()).unwrap())?;
                if phase == "settings-after" { std::process::exit(86); }
                Ok(())
            });
            drop(lease);
            panic!("child did not reach requested boundary");
        }
        for phase in ["prepared", "artifacts", "session", "committed", "settings-before", "settings-after"] {
            let fixture = Fixture::new();
            let (settings_path, original) = pinned_settings(&fixture);
            fs::write(fixture.root.join("boundary-fixture"), b"synthetic deletion fixture").unwrap();
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", TEST, "--nocapture"])
                .env(ROOT, &fixture.root).env(PHASE, phase).status().unwrap();
            assert_eq!(status.code(), Some(86), "boundary {phase}");
            let (sessions, warnings) = crate::sessions::scan_deletion_fixture(&fixture.root).unwrap();
            assert!(warnings.is_empty(), "boundary {phase}");
            if ["prepared", "artifacts", "session"].contains(&phase) {
                fixture.preserved();
                assert_eq!(sessions.len(), 1);
            } else {
                assert!(sessions.is_empty());
                assert!(!fixture.session.exists());
                assert!(!fixture.artifact.exists());
            }
            let persisted = fs::read(&settings_path).unwrap();
            let settings: AppSettings = serde_json::from_slice(&persisted).unwrap();
            if phase == "settings-after" {
                assert!(settings.session_title_pins.is_empty());
                assert!(settings.primary_provider_pins.is_empty());
            } else {
                assert_eq!(persisted, original, "boundary {phase}: original pins survive restart");
            }
            assert!(fixture.transactions().is_empty());
        }
    }
}
