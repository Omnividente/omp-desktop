use super::*;
use crate::models::RuntimeInfo;
use std::time::Instant;

struct Fixture {
    root: PathBuf,
    previous_names: Option<HashMap<String, String>>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        TEST_CODEX_THREAD_NAMES.with(|names| {
            names.replace(self.previous_names.take());
        });
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn inventory(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files = BTreeMap::new();
    for entry in fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        let kind = entry.file_type().unwrap();
        if kind.is_dir() {
            files.extend(inventory(&entry.path()));
        } else {
            assert!(kind.is_file());
            files.insert(entry.path(), fs::read(entry.path()).unwrap());
        }
    }
    files
}

// Separate diagnostic passes, not instrumentation of the main scan timings.
// The cached parser includes metadata/open/read/JSON/path work; it is not CPU-only.
fn diagnose_files(library: &Path, expected_ids: &BTreeSet<String>) {
    let names = HashMap::new();
    let stamp = thread_names_stamp(&names);
    let before = inventory(library);
    for repetition in 0..3 {
        for cache in ["cold-summary", "warm-summary"] {
            if cache == "cold-summary" {
                session_summary_cache().lock().unwrap().clear();
            }
            let mut files = Vec::new();
            let mut warnings = Vec::new();
            let started = Instant::now();
            collect_jsonl_files(library, 0, 3, &mut files, &mut warnings).unwrap();
            let enumerate_us = started.elapsed().as_micros();
            assert!(warnings.is_empty());
            assert_eq!(files.len(), expected_ids.len() + 5);
            let mut groups = BTreeMap::<&str, (usize, u128)>::new();
            let mut ids = BTreeSet::new();
            let mut rejected = 0;
            for path in files {
                let stem = path.file_stem().unwrap().to_str().unwrap();
                let group = match stem.strip_prefix("session-") {
                    Some(index) => match index.parse::<usize>().unwrap() % 20 {
                        0 => "256KiB",
                        1..=3 => "32KiB",
                        _ => "2KiB",
                    },
                    None => "invalid",
                };
                let started = Instant::now();
                let result = parse_session_cached(&path, &names, stamp);
                let elapsed_ns = started.elapsed().as_nanos();
                let sample = groups.entry(group).or_default();
                sample.0 += 1;
                sample.1 += elapsed_ns;
                match result {
                    Ok(Some(session)) => {
                        assert_ne!(group, "invalid");
                        assert!(ids.insert(session.id));
                    }
                    _ => {
                        assert_eq!(group, "invalid");
                        rejected += 1;
                    }
                }
            }
            assert_eq!(&ids, expected_ids);
            assert_eq!(rejected, 5);
            assert_eq!(groups["256KiB"].0, expected_ids.len() / 20);
            assert_eq!(groups["32KiB"].0, expected_ids.len() * 3 / 20);
            assert_eq!(groups["2KiB"].0, expected_ids.len() * 16 / 20);
            assert_eq!(inventory(library), before);
            eprintln!(
                "DISCOVERY_DIAGNOSTIC {}",
                serde_json::json!({
                    "os":env::consts::OS, "sessions":expected_ids.len(),
                    "repetition":repetition, "cache":cache,
                    "enumerate_us":enumerate_us, "parser_groups_count_ns":groups,
                    "debug_assertions":cfg!(debug_assertions)
                })
            );
        }
    }
}

#[test]
#[ignore = "bounded synthetic discovery phase benchmark; run alone with nocapture"]
fn synthetic_bootstrap_phases() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!(
        "omp-discovery-profile-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir(&root).unwrap();
    let _fixture = Fixture {
        root: root.clone(),
        previous_names: TEST_CODEX_THREAD_NAMES.with(|names| names.replace(Some(HashMap::new()))),
    };
    for count in [100_usize, 1_000] {
        let library = root.join(format!("library-{count}"));
        let projects = root.join(format!("projects-{count}"));
        fs::create_dir_all(&library).unwrap();
        fs::create_dir_all(&projects).unwrap();
        let project_count = count / 10;
        let mut settings = AppSettings::default();
        let mut bytes = 0_usize;
        let mut expected_ids = BTreeSet::new();
        let mut expected_projects = BTreeSet::new();
        for index in 0..count {
            let project = projects.join(format!("project-{}", index % project_count));
            let directory = library.join(format!("project-{}", index % project_count));
            fs::create_dir_all(&project).unwrap();
            expected_projects.insert(path_key(&project.to_string_lossy()));
            fs::create_dir_all(&directory).unwrap();
            let path = directory.join(format!("session-{index}.jsonl"));
            let id = format!("synthetic-{index}");
            expected_ids.insert(id.clone());
            let size = match index % 20 {
                0 => 256 * 1024,
                1..=3 => 32 * 1024,
                _ => 2 * 1024,
            };
            let header = serde_json::json!({"type":"session", "id":id, "cwd":project});
            let message = serde_json::json!({
                "type":"message", "id":format!("message-{index}"),
                "message":{"role":"user", "content":format!("Synthetic request {index} {}", "x".repeat(size))}
            });
            let contents = format!("{header}\n{message}\n");
            bytes += contents.len();
            fs::write(&path, contents).unwrap();
            if index < 10 {
                settings
                    .session_title_pins
                    .insert(path_key(&path.to_string_lossy()), format!("Pinned {index}"));
            }
            if index == 0 {
                settings
                    .primary_provider_pins
                    .insert(path_key(&path.to_string_lossy()));
                let sidecar = path.with_extension("");
                fs::create_dir(&sidecar).unwrap();
                fs::write(sidecar.join("excluded.jsonl"), format!("{header}\n")).unwrap();
            }
        }
        for index in 0..5 {
            fs::write(
                library.join(format!("invalid-{index}.jsonl")),
                b"not a session\n",
            )
            .unwrap();
        }
        let expected_inventory = inventory(&library);
        for repetition in 0..3 {
            for cache in ["cold-summary", "warm-summary"] {
                if cache == "cold-summary" {
                    session_summary_cache().lock().unwrap().clear();
                }
                let total_start = Instant::now();
                let scan_start = Instant::now();
                let mut scan = scan_sessions(&library).unwrap();
                let scan_us = scan_start.elapsed().as_micros();
                let compose_start = Instant::now();
                for session in &mut scan.sessions {
                    apply_session_title_pin(session, &settings.session_title_pins);
                    apply_session_primary_provider_pin(session, &settings.primary_provider_pins);
                }
                let pins_us = compose_start.elapsed().as_micros();
                let group_start = Instant::now();
                scan.sessions
                    .sort_by_key(|session| std::cmp::Reverse(session.updated_at));
                let workspaces = build_workspaces(&scan.sessions, &settings);
                let group_us = group_start.elapsed().as_micros();
                let payload = BootstrapPayload {
                    settings: settings.clone(),
                    runtime: RuntimeInfo {
                        platform: env::consts::OS.to_owned(),
                        arch: env::consts::ARCH.to_owned(),
                        omp_available: false,
                        omp_executable: "synthetic-not-launched".to_owned(),
                        omp_version: None,
                        omp_probe_failures: Vec::new(),
                        session_root: library.to_string_lossy().into_owned(),
                        language: "en".to_owned(),
                    },
                    workspaces,
                    sessions: scan.sessions,
                    session_warnings: scan.warnings,
                    startup_workspace_warning: None,
                };
                let compose_us = compose_start.elapsed().as_micros();
                let serialize_start = Instant::now();
                let serialized = serde_json::to_vec(&payload).unwrap();
                let serialize_us = serialize_start.elapsed().as_micros();
                let total_us = total_start.elapsed().as_micros();
                // Controls are outside the measured interval and run for every sample.
                assert_eq!(payload.sessions.len(), count);
                assert_eq!(
                    payload
                        .sessions
                        .iter()
                        .map(|s| s.id.clone())
                        .collect::<BTreeSet<_>>(),
                    expected_ids
                );
                assert_eq!(payload.session_warnings.len(), 5);
                assert!(payload.session_warnings.iter().all(|warning| {
                    Path::new(&warning.path)
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("invalid-")
                }));
                assert_eq!(payload.workspaces.len(), project_count);
                assert_eq!(
                    payload
                        .workspaces
                        .iter()
                        .map(|w| w.key.clone())
                        .collect::<BTreeSet<_>>(),
                    expected_projects
                );
                assert!(payload.workspaces.iter().all(|w| w.session_count == 10));
                assert_eq!(
                    payload
                        .sessions
                        .iter()
                        .filter(|s| s.primary_provider_pinned)
                        .map(|s| s.id.as_str())
                        .collect::<Vec<_>>(),
                    ["synthetic-0"]
                );
                assert_eq!(
                    payload
                        .sessions
                        .iter()
                        .filter(|s| s.pinned_title.is_some())
                        .count(),
                    10
                );
                for index in 0..10 {
                    let session = payload
                        .sessions
                        .iter()
                        .find(|s| s.id == format!("synthetic-{index}"))
                        .unwrap();
                    assert_eq!(session.pinned_title, Some(format!("Pinned {index}")));
                    assert_eq!(session.title, format!("Pinned {index}"));
                }
                assert_eq!(
                    serde_json::from_slice::<Value>(&serialized).unwrap()["sessions"]
                        .as_array()
                        .unwrap()
                        .len(),
                    count
                );
                assert_eq!(inventory(&library), expected_inventory);
                eprintln!(
                    "DISCOVERY_BENCH {}",
                    serde_json::json!({
                    "os":env::consts::OS, "arch":env::consts::ARCH,
                    "sessions":count, "projects":project_count, "session_jsonl_bytes":bytes,
                    "repetition":repetition, "cache":cache,
                    "scan_us":scan_us, "compose_us":compose_us,
                    "pins_us":pins_us, "group_us":group_us,
                    "serialize_us":serialize_us, "total_us":total_us,
                    "payload_bytes":serialized.len(), "warnings":payload.session_warnings.len(),
                    "debug_assertions":cfg!(debug_assertions)
                    })
                );
            }
        }
        diagnose_files(&library, &expected_ids);
    }
}
