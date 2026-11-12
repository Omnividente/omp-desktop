use super::*;
use std::time::Instant;

struct Fixture(PathBuf);

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture(count: usize) -> (Fixture, Vec<SessionSummary>) {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!("omp-empty-pins-{}-{nonce}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let guard = Fixture(root.clone());
    let mut sessions = Vec::new();
    for index in 0..count {
        let path = root.join(".").join(format!("session-{index}.jsonl"));
        let header = serde_json::json!({"type":"session", "id":index.to_string(), "cwd":root});
        fs::write(&path, format!("{header}\n")).unwrap();
        sessions.push(
            parse_session_with_names(&path, &HashMap::new())
                .unwrap()
                .unwrap(),
        );
    }
    (guard, sessions)
}

fn apply_pins(session: &mut SessionSummary, settings: &AppSettings) {
    apply_session_title_pin(session, &settings.session_title_pins);
    apply_session_primary_provider_pin(session, &settings.primary_provider_pins);
}

// Baseline helpers at main dba7f41, retained only for differential measurement.
fn baseline_pins(session: &mut SessionSummary, settings: &AppSettings) {
    session.pinned_title = settings
        .session_title_pins
        .get(&path_key(&session.file_path))
        .or_else(|| settings.session_title_pins.get(&lexical_path_key(&session.file_path)))
        .cloned();
    if let Some(title) = session.pinned_title.as_ref() {
        session.title.clone_from(title);
    }
    session.primary_provider_pinned = settings
        .primary_provider_pins
        .contains(&path_key(&session.file_path))
        || settings
            .primary_provider_pins
            .contains(&lexical_path_key(&session.file_path));
}

#[test]
fn empty_pins_clear_stale_flags_without_changing_other_fields() {
    let (_guard, mut sessions) = fixture(1);
    let mut session = sessions.pop().unwrap();
    session.title = "Previously displayed title".to_owned();
    let expected = serde_json::to_value(&session).unwrap();
    for remove in [false, true] {
        if remove {
            fs::remove_file(&session.file_path).unwrap();
        }
        session.pinned_title = Some("stale".to_owned());
        session.primary_provider_pinned = true;
        apply_pins(&mut session, &AppSettings::default());
        assert_eq!(serde_json::to_value(&session).unwrap(), expected);
    }
}

#[test]
fn empty_collection_does_not_skip_the_other_pin_lookup() {
    let (_guard, sessions) = fixture(1);
    let source = &sessions[0];
    let canonical = path_key(&source.file_path);
    let lexical = lexical_path_key(&source.file_path);
    assert_ne!(canonical, lexical);
    for title_pinned in [false, true] {
        let mut settings = AppSettings::default();
        if title_pinned {
            settings
                .session_title_pins
                .insert(canonical.clone(), "Pinned".to_owned());
        } else {
            settings.primary_provider_pins.insert(canonical.clone());
        }
        let mut current = source.clone();
        current.pinned_title = Some("stale".to_owned());
        current.primary_provider_pinned = true;
        let mut baseline = current.clone();
        baseline_pins(&mut baseline, &settings);
        apply_pins(&mut current, &settings);
        assert_eq!(
            current.pinned_title.as_deref(),
            title_pinned.then_some("Pinned")
        );
        assert_eq!(current.primary_provider_pinned, !title_pinned);
        assert_eq!(
            serde_json::to_value(current).unwrap(),
            serde_json::to_value(baseline).unwrap()
        );
    }
}

#[test]
fn nonempty_pins_still_resolve_again_after_file_removal() {
    let (_guard, mut sessions) = fixture(1);
    let mut session = sessions.pop().unwrap();
    let canonical = path_key(&session.file_path);
    let lexical = lexical_path_key(&session.file_path);
    assert_ne!(canonical, lexical);
    let titles = BTreeMap::from([(canonical.clone(), "Pinned".to_owned())]);
    let providers = BTreeSet::from([canonical]);
    apply_session_title_pin(&mut session, &titles);
    fs::remove_file(&session.file_path).unwrap();
    apply_session_primary_provider_pin(&mut session, &providers);
    assert_eq!(session.pinned_title.as_deref(), Some("Pinned"));
    assert!(!session.primary_provider_pinned);
    let providers = BTreeSet::from([lexical]);
    apply_session_primary_provider_pin(&mut session, &providers);
    assert!(session.primary_provider_pinned);
}

fn timed(
    source: &[SessionSummary],
    settings: &AppSettings,
    apply: fn(&mut SessionSummary, &AppSettings),
) -> (u128, Vec<SessionSummary>) {
    let mut result = source.to_vec();
    let started = Instant::now();
    for session in &mut result {
        apply(session, settings);
    }
    (started.elapsed().as_nanos(), result)
}

#[test]
#[ignore = "synthetic release measurement of empty pin collections"]
fn empty_pin_benchmark() {
    for count in [100, 1_000, 10_000] {
        let (_guard, source) = fixture(count);
        let before: Vec<_> = source
            .iter()
            .map(|s| fs::read(&s.file_path).unwrap())
            .collect();
        let settings = AppSettings::default();
        for repetition in 0..6 {
            let ((baseline_ns, baseline), (current_ns, current)) = if repetition % 2 == 0 {
                (
                    timed(&source, &settings, baseline_pins),
                    timed(&source, &settings, apply_pins),
                )
            } else {
                let current = timed(&source, &settings, apply_pins);
                let baseline = timed(&source, &settings, baseline_pins);
                (baseline, current)
            };
            assert_eq!(
                serde_json::to_value(&current).unwrap(),
                serde_json::to_value(&baseline).unwrap()
            );
            for (session, bytes) in source.iter().zip(&before) {
                assert_eq!(&fs::read(&session.file_path).unwrap(), bytes);
            }
            eprintln!(
                "EMPTY_PINS_BENCH {}",
                serde_json::json!({
                    "os":env::consts::OS, "sessions":count, "repetition":repetition,
                    "baseline_first":repetition % 2 == 0, "baseline_ns":baseline_ns,
                    "current_ns":current_ns, "debug_assertions":cfg!(debug_assertions)
                })
            );
        }
    }
}
