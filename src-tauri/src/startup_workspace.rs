use std::fs;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Warning {
    pub requested_path: String,
    pub message: String,
}

#[derive(Clone, Copy)]
pub enum Resolution {
    Retry,
    Continue,
}

#[derive(Default)]
pub struct StartupWorkspaceIntent {
    requested_path: Option<String>,
    warning: Option<Warning>,
}

impl StartupWorkspaceIntent {
    pub fn new(requested_path: Option<String>) -> Self {
        Self {
            requested_path,
            warning: None,
        }
    }

    pub fn is_pending(&self) -> bool {
        self.requested_path.is_some()
    }

    pub fn load<T>(
        &mut self,
        apply_requested: impl FnOnce(&str) -> Result<T, String>,
        load_prior: impl FnOnce() -> Result<T, String>,
    ) -> Result<(T, Option<Warning>), String> {
        let Some(path) = self.requested_path.as_deref() else {
            return load_prior().map(|value| (value, None));
        };
        if self.warning.is_none() {
            match fs::metadata(path) {
                Ok(metadata) if metadata.is_dir() => {
                    let value = apply_requested(path)?;
                    self.requested_path = None;
                    return Ok((value, None));
                }
                Ok(_) => {
                    self.warning = Some(Warning {
                        requested_path: path.to_owned(),
                        message: "Указанный путь не является папкой проекта".to_owned(),
                    });
                }
                Err(error) => {
                    self.warning = Some(Warning {
                        requested_path: path.to_owned(),
                        message: format!("Не удалось проверить папку проекта: {error}"),
                    });
                }
            }
        }
        // A refresh must not silently retry a failed intent or commit a restored path.
        // A failed fallback keeps both the intent and its diagnostic for settings recovery.
        load_prior().map(|value| (value, self.warning.clone()))
    }

    pub fn resolve<T>(
        &mut self,
        requested_path: &str,
        resolution: Resolution,
        apply_requested: impl FnOnce(&str) -> Result<T, String>,
        load_prior: impl FnOnce() -> Result<T, String>,
    ) -> Result<(T, Option<Warning>), String> {
        if self.requested_path.as_deref() != Some(requested_path) {
            return Err("Запрос запуска уже изменился; обновите данные".to_owned());
        }
        match resolution {
            Resolution::Retry => {
                self.warning = None;
                self.load(apply_requested, load_prior)
            }
            Resolution::Continue => {
                let value = load_prior()?;
                self.requested_path = None;
                self.warning = None;
                Ok((value, None))
            }
        }
    }

    pub fn supersede<T>(
        &mut self,
        choose_workspace: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let value = choose_workspace()?;
        self.requested_path = None;
        self.warning = None;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::{Resolution, StartupWorkspaceIntent};
    use std::{
        cell::Cell,
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "omp-startup-test-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn path(&self, name: &str) -> String {
            self.0.join(name).to_string_lossy().into_owned()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn load(intent: &mut StartupWorkspaceIntent) -> (String, Option<super::Warning>) {
        intent
            .load(|path| Ok(path.to_owned()), || Ok("prior".to_owned()))
            .unwrap()
    }

    #[test]
    fn absent_intent_loads_prior_without_mutation() {
        let mut intent = StartupWorkspaceIntent::new(None);
        assert_eq!(load(&mut intent), ("prior".to_owned(), None));
        assert!(!intent.is_pending());
    }

    #[test]
    fn valid_absolute_path_commits_once_and_consumes_intent() {
        let fixture = Fixture::new();
        let path = fixture.0.to_string_lossy().into_owned();
        let mut intent = StartupWorkspaceIntent::new(Some(path.clone()));
        assert_eq!(load(&mut intent), (path, None));
        assert!(!intent.is_pending());
        assert_eq!(load(&mut intent), ("prior".to_owned(), None));
    }

    #[test]
    fn valid_relative_path_preserves_the_requested_spelling() {
        let mut intent = StartupWorkspaceIntent::new(Some(".".to_owned()));
        assert_eq!(load(&mut intent), (".".to_owned(), None));
        assert!(!intent.is_pending());
    }

    #[test]
    fn missing_directory_returns_prior_and_retains_requested_path() {
        let fixture = Fixture::new();
        let path = fixture.path("missing");
        let mut intent = StartupWorkspaceIntent::new(Some(path.clone()));
        let (value, warning) = load(&mut intent);
        assert_eq!(value, "prior");
        assert_eq!(warning.unwrap().requested_path, path);
        assert!(intent.is_pending());
    }

    #[cfg(unix)]
    #[test]
    fn inaccessible_parent_reports_actual_metadata_failure_without_commit() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = Fixture::new();
        let parent = fixture.0.join("private");
        fs::create_dir(&parent).unwrap();
        let path = parent.join("project");
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o0)).unwrap();
        let metadata = fs::metadata(&path);
        let result = if metadata.is_err() {
            let mut intent = StartupWorkspaceIntent::new(Some(path.to_string_lossy().into_owned()));
            Some(intent.load(|_| panic!("must not commit"), || Ok("prior")))
        } else {
            None
        };
        // Restore fixture access before assertions so unwinding never leaves inaccessible files.
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        if let Err(error) = metadata {
            assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
            let (value, warning) = result.unwrap().unwrap();
            assert_eq!(value, "prior");
            assert!(warning.unwrap().message.contains(&error.to_string()));
        } else {
            eprintln!("permission test not exercised: current identity bypasses mode restrictions");
        }
    }

    #[test]
    fn moved_directory_and_nested_missing_parent_remain_explicit_failures() {
        let fixture = Fixture::new();
        let old = fixture.path("old");
        fs::create_dir(&old).unwrap();
        fs::rename(&old, fixture.path("new")).unwrap();
        for path in [old, fixture.path("nested/missing/project")] {
            let mut intent = StartupWorkspaceIntent::new(Some(path.clone()));
            let (value, warning) = load(&mut intent);
            assert_eq!(value, "prior");
            assert_eq!(warning.unwrap().requested_path, path);
            assert!(intent.is_pending());
        }
    }

    #[test]
    fn file_and_file_used_as_parent_are_not_silently_consumed() {
        let fixture = Fixture::new();
        let file = fixture.path("file");
        fs::write(&file, "synthetic fixture").unwrap();
        for path in [file, fixture.path("file/project")] {
            let mut intent = StartupWorkspaceIntent::new(Some(path.clone()));
            assert_eq!(load(&mut intent).1.unwrap().requested_path, path);
            assert!(intent.is_pending());
        }
    }

    #[test]
    fn refresh_does_not_retry_restored_directory_but_explicit_retry_does() {
        let fixture = Fixture::new();
        let path = fixture.path("restored");
        let mut intent = StartupWorkspaceIntent::new(Some(path.clone()));
        let failed = load(&mut intent);
        fs::create_dir(&path).unwrap();
        assert_eq!(load(&mut intent), failed);
        let retried = intent
            .resolve(
                &path,
                Resolution::Retry,
                |path| Ok(path.to_owned()),
                || panic!("fallback"),
            )
            .unwrap();
        assert_eq!(retried, (path, None));
        assert!(!intent.is_pending());
    }

    #[test]
    fn repeated_failed_retry_retains_recoverable_warning() {
        let fixture = Fixture::new();
        let path = fixture.path("missing");
        let mut intent = StartupWorkspaceIntent::new(Some(path.clone()));
        let first = load(&mut intent);
        for _ in 0..2 {
            let retry = intent
                .resolve(
                    &path,
                    Resolution::Retry,
                    |_| panic!("must not commit"),
                    || Ok("prior".to_owned()),
                )
                .unwrap();
            assert_eq!(retry, first);
            assert!(intent.is_pending());
        }
    }

    #[test]
    fn continue_never_calls_workspace_mutation_and_requires_successful_fallback() {
        let fixture = Fixture::new();
        let path = fixture.path("missing");
        let mut intent = StartupWorkspaceIntent::new(Some(path.clone()));
        let first = load(&mut intent);
        let failed: Result<(String, _), _> = intent.resolve(
            &path,
            Resolution::Continue,
            |_| panic!("must not commit"),
            || Err("settings unavailable".to_owned()),
        );
        assert!(failed.is_err());
        assert_eq!(load(&mut intent), first);
        let result = intent
            .resolve(
                &path,
                Resolution::Continue,
                |_| panic!("must not commit"),
                || Ok("same prior snapshot"),
            )
            .unwrap();
        assert_eq!(result, ("same prior snapshot", None));
        assert!(!intent.is_pending());
    }

    #[test]
    fn stale_resolution_does_not_invoke_either_callback_or_clear_current_intent() {
        let fixture = Fixture::new();
        let path = fixture.path("missing");
        let mut intent = StartupWorkspaceIntent::new(Some(path));
        let expected = load(&mut intent);
        for resolution in [Resolution::Continue, Resolution::Retry] {
            let result: Result<((), _), _> = intent.resolve(
                "other",
                resolution,
                |_| panic!("stale commit"),
                || panic!("stale read"),
            );
            assert!(result.is_err());
            assert_eq!(load(&mut intent), expected);
        }
    }

    #[test]
    fn fallback_failure_retains_the_failed_intent() {
        let fixture = Fixture::new();
        let path = fixture.path("missing");
        let mut intent = StartupWorkspaceIntent::new(Some(path.clone()));
        let result: Result<((), _), _> = intent.load(
            |_| panic!("invalid path"),
            || Err("settings unavailable".to_owned()),
        );
        assert!(result.is_err());
        assert_eq!(load(&mut intent).1.unwrap().requested_path, path);
    }

    #[test]
    fn failed_valid_path_commit_retains_intent_for_settings_recovery() {
        let fixture = Fixture::new();
        let path = fixture.0.to_string_lossy().into_owned();
        let mut intent = StartupWorkspaceIntent::new(Some(path.clone()));
        let result: Result<((), _), _> = intent.load(
            |_| Err("settings write failed".to_owned()),
            || panic!("fallback"),
        );
        assert!(result.is_err());
        assert!(intent.is_pending());
        assert_eq!(load(&mut intent), (path, None));
    }

    #[test]
    fn failed_folder_choice_retains_intent_and_successful_choice_clears_it() {
        let fixture = Fixture::new();
        let path = fixture.path("missing");
        let mut intent = StartupWorkspaceIntent::new(Some(path));
        let first = load(&mut intent);
        let failed: Result<(), _> = intent.supersede(|| Err("invalid folder".to_owned()));
        assert!(failed.is_err());
        assert_eq!(load(&mut intent), first);
        let commits = Cell::new(0);
        let result = intent
            .supersede(|| {
                commits.set(commits.get() + 1);
                Ok("chosen")
            })
            .unwrap();
        assert_eq!(result, "chosen");
        assert_eq!(commits.get(), 1);
        assert!(!intent.is_pending());
    }

    #[test]
    fn process_reopen_gets_a_new_explicit_request_not_a_persisted_acknowledgement() {
        let fixture = Fixture::new();
        let path = fixture.path("missing");
        let mut first = StartupWorkspaceIntent::new(Some(path.clone()));
        load(&mut first);
        first
            .resolve(&path, Resolution::Continue, |_| panic!("commit"), || Ok(()))
            .unwrap();
        let mut reopened = StartupWorkspaceIntent::new(Some(path.clone()));
        assert_eq!(load(&mut reopened).1.unwrap().requested_path, path);
    }
}
