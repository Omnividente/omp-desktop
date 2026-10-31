use super::*;
use serde_json::json;

// A real subprocess exercises the Rust command/transaction boundary. This is
// an isolated synthetic CLI, not evidence of a native OMP or Windows UI run.

struct Fixture {
    root: PathBuf,
    executable: String,
    env: HashMap<String, String>,
}

impl Fixture {
    fn new(global: Option<Value>, project: Value, mode: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "omp-agent-scope-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        fs::create_dir(&root).unwrap();
        // Checked out before tests start, never opened for writing here. A
        // parallel fork can retain a writable executable FD until exec even
        // after its creator closes it, causing ETXTBSY in another test.
        let executable = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/fixtures/operational_config_scope_cli.py");
        if let Some(global) = global {
            // The leading whitespace is intentional: rollback restores exact bytes.
            fs::write(root.join("config.yml"), format!("  {global}\n")).unwrap();
        }
        fs::write(root.join("project.json"), project.to_string()).unwrap();
        fs::write(root.join("mode"), mode).unwrap();
        let env = HashMap::from([(
            "OMP_SCOPE_TEST_ROOT".to_owned(),
            root.to_string_lossy().into_owned(),
        )]);
        Self {
            root,
            executable: executable.to_string_lossy().into_owned(),
            env,
        }
    }

    fn transaction(&self) -> OperationalTransaction {
        OperationalTransaction::prepare(&self.executable, &self.env).unwrap()
    }

    fn save(&self, changes: Value) -> (OperationalTransaction, Result<(), String>) {
        let mut transaction = self.transaction();
        let changes = serde_json::from_value(changes).unwrap();
        let result = transaction.apply_agents(&self.executable, &self.env, &changes);
        (transaction, result)
    }

    fn global(&self) -> Value {
        parse_config(self.bytes().as_deref()).unwrap()
    }

    fn bytes(&self) -> Option<Vec<u8>> {
        read_optional(&self.root.join("config.yml")).unwrap()
    }

    fn writes(&self) -> Vec<Value> {
        fs::read_to_string(self.root.join("calls.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|args| args[1] == "set" || args[1] == "reset")
            .collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn override_change() -> Value {
    json!({"reviewer":{"modelOverride":["synthetic/new"],"expectedModelOverride":["synthetic/old"]}})
}

#[test]
fn scoped_save_preserves_global_siblings_without_copying_inherited_names() {
    let global = json!({"unknown":{"keep":true},"task":{"agentModelOverrides":{"reviewer":"synthetic/old","unknown-plugin":["synthetic/global","@task"],"hidden":"synthetic/global-hidden"},"disabledAgents":["global-disabled"]}});
    let fixture = Fixture::new(
        Some(global.clone()),
        json!({"task.agentModelOverrides":{"project-only":"synthetic/project","overlay-only":["synthetic/overlay"],"hidden":"synthetic/project-hidden"}}),
        "scoped",
    );
    let (_, result) = fixture.save(override_change());
    result.unwrap();
    let mut expected = global;
    expected["task"]["agentModelOverrides"]["reviewer"] = json!(["synthetic/new"]);
    assert_eq!(fixture.global(), expected);
    assert_eq!(fixture.writes().len(), 1);
}

#[test]
fn scoped_disabled_save_preserves_hidden_global_members_and_unknown_entries() {
    let fixture = Fixture::new(
        Some(json!({"task":{"disabledAgents":["global-hidden",{"unknown":"keep"}]}})),
        json!({"task.disabledAgents":["project-only"]}),
        "scoped",
    );
    // Already enabled effectively, but explicitly disabling it needs a global write;
    // the project array still shadows it, so verification must report failure.
    let before = fixture.bytes();
    let (transaction, result) =
        fixture.save(json!({"reviewer":{"enabled":false,"expectedEnabled":true}}));
    assert!(result.is_err());
    assert_eq!(
        fixture.global()["task"]["disabledAgents"],
        json!(["global-hidden",{"unknown":"keep"},"reviewer"])
    );
    assert!(transaction.rollback().is_empty());
    assert_eq!(fixture.bytes(), before);
}

#[test]
fn legacy_runtimes_fail_closed_for_agents_but_generic_save_still_works() {
    for mode in ["old-parser", "legacy-wrapper", "legacy-new-help"] {
        let fixture = Fixture::new(
            Some(json!({"task":{"agentModelOverrides":{"reviewer":"synthetic/old"}}})),
            json!({}),
            mode,
        );
        let before = fixture.bytes();
        let (_, result) = fixture.save(override_change());
        assert!(result.is_err(), "accepted {mode}");
        assert_eq!(fixture.bytes(), before);
        assert!(fixture.writes().is_empty());
        let mut transaction = fixture.transaction();
        transaction
            .apply_change(
                &fixture.executable,
                &fixture.env,
                "task.batch",
                &OmpOperationalChange {
                    expected_value: json!(false),
                    value: json!(true),
                    reset: false,
                },
            )
            .unwrap();
        assert_eq!(fixture.global()["task"]["batch"], true);
    }
}

#[test]
fn runtime_replacement_is_reprobed_and_empty_agent_save_needs_no_capability() {
    let fixture = Fixture::new(
        Some(json!({"task":{"agentModelOverrides":{"reviewer":"synthetic/old"}}})),
        json!({}),
        "scoped",
    );
    fixture.save(override_change()).1.unwrap();
    fs::write(fixture.root.join("mode"), "legacy-wrapper").unwrap();
    let before = fixture.bytes();
    assert!(fixture.save(json!({"reviewer":{"modelOverride":["synthetic/later"],"expectedModelOverride":["synthetic/new"]}})).1.is_err());
    assert_eq!(fixture.bytes(), before);
    fixture.save(json!({})).1.unwrap();
}

#[test]
fn inherited_only_clear_is_an_error_without_materializing_absent_or_empty_global() {
    for global in [
        None,
        Some(json!({"task":{"agentModelOverrides":{},"disabledAgents":[]}})),
    ] {
        let fixture = Fixture::new(
            global,
            json!({"task.agentModelOverrides":{"reviewer":["synthetic/project"]},"task.disabledAgents":["reviewer"]}),
            "scoped",
        );
        let before = fixture.bytes();
        assert!(fixture.save(json!({"reviewer":{"modelOverride":null,"expectedModelOverride":["synthetic/project"]}})).1.is_err());
        assert!(fixture
            .save(json!({"reviewer":{"enabled":true,"expectedEnabled":false}}))
            .1
            .is_err());
        assert!(fixture.writes().is_empty());
        assert_eq!(fixture.bytes(), before);
    }
}

#[test]
fn null_or_malformed_raw_records_fail_without_resetting_or_normalizing_them() {
    for value in [Value::Null, json!("invalid"), json!([])] {
        let fixture = Fixture::new(
            Some(json!({"task":{"agentModelOverrides":value}})),
            json!({"task.agentModelOverrides":{"reviewer":"synthetic/old"}}),
            "scoped",
        );
        let before = fixture.bytes();
        assert!(fixture.save(override_change()).1.is_err());
        assert!(fixture.writes().is_empty());
        assert_eq!(fixture.bytes(), before);
    }
}

#[test]
fn absent_global_can_add_only_requested_names_and_rollback_to_absence() {
    let fixture = Fixture::new(
        None,
        json!({"task.agentModelOverrides":{"project-only":"synthetic/project"}}),
        "scoped",
    );
    let (transaction, result) = fixture
        .save(json!({"reviewer":{"modelOverride":["synthetic/new"],"expectedModelOverride":null}}));
    result.unwrap();
    assert_eq!(
        fixture.global(),
        json!({"task":{"agentModelOverrides":{"reviewer":["synthetic/new"]}}})
    );
    assert!(transaction.rollback().is_empty());
    assert!(fixture.bytes().is_none());
}

#[test]
fn clear_last_global_member_preserves_empty_record_and_never_resets_whole_key() {
    let fixture = Fixture::new(
        Some(
            json!({"unknown":"keep","task":{"agentModelOverrides":{"reviewer":"synthetic/old"},"disabledAgents":["reviewer"]}}),
        ),
        json!({}),
        "scoped",
    );
    fixture.save(json!({"reviewer":{"modelOverride":null,"expectedModelOverride":["synthetic/old"],"enabled":true,"expectedEnabled":false}})).1.unwrap();
    assert_eq!(
        fixture.global(),
        json!({"unknown":"keep","task":{"agentModelOverrides":{},"disabledAgents":[]}})
    );
    assert!(fixture.writes().iter().all(|args| args[1] == "set"));
}

#[test]
fn stale_effective_baseline_and_hidden_global_generation_are_rejected_without_writes() {
    let fixture = Fixture::new(
        Some(json!({"task":{"agentModelOverrides":{"reviewer":"synthetic/later"}}})),
        json!({}),
        "scoped",
    );
    assert!(fixture.save(override_change()).1.is_err());
    assert!(fixture.writes().is_empty());
    let fixture = Fixture::new(
        Some(
            json!({"task":{"agentModelOverrides":{"reviewer":"synthetic/old","hidden":"synthetic/global"}}}),
        ),
        json!({"task.agentModelOverrides":{"hidden":"synthetic/project"}}),
        "hidden-race",
    );
    assert!(fixture.save(override_change()).1.is_err());
    assert!(fixture.writes().is_empty());
    assert_eq!(
        fixture.global()["task"]["agentModelOverrides"]["hidden"],
        "synthetic/concurrent"
    );
}

#[test]
fn partial_and_postwrite_failure_restore_exact_bytes_but_never_foreign_changes() {
    for mode in ["fail-second", "fail-after-write"] {
        let fixture = Fixture::new(
            Some(
                json!({"unknown":"keep","task":{"agentModelOverrides":{"reviewer":"synthetic/old"},"disabledAgents":[]}}),
            ),
            json!({}),
            mode,
        );
        let before = fixture.bytes();
        let (transaction, result) = fixture.save(json!({"reviewer":{"modelOverride":["synthetic/new"],"expectedModelOverride":["synthetic/old"],"enabled":false,"expectedEnabled":true}}));
        assert!(result.is_err());
        assert!(!fixture.writes().is_empty());
        assert!(transaction.rollback().is_empty());
        assert_eq!(fixture.bytes(), before);
    }
    let fixture = Fixture::new(
        Some(json!({"unknown":"keep","task":{"agentModelOverrides":{"reviewer":"synthetic/old"}}})),
        json!({}),
        "foreign-during-write",
    );
    let (transaction, _) = fixture.save(override_change());
    assert!(!transaction.rollback().is_empty());
    assert_eq!(fixture.global()["unknown"], "external");
}

#[test]
fn malformed_scoped_json_is_not_accepted_as_a_raw_layer() {
    let fixture = Fixture::new(
        Some(json!({"task":{"agentModelOverrides":{"reviewer":"synthetic/old"}}})),
        json!({}),
        "invalid-list",
    );
    assert!(fixture.save(override_change()).1.is_err());
    assert!(fixture.writes().is_empty());
}

#[test]
fn unrelated_malformed_raw_key_does_not_block_a_valid_agent_field() {
    let fixture = Fixture::new(
        Some(json!({"task":{"agentModelOverrides":null,"disabledAgents":[]}})),
        json!({}),
        "scoped",
    );
    fixture
        .save(json!({"reviewer":{"enabled":false,"expectedEnabled":true}}))
        .1
        .unwrap();
    assert_eq!(fixture.global()["task"]["agentModelOverrides"], Value::Null);
    assert_eq!(
        fixture.global()["task"]["disabledAgents"],
        json!(["reviewer"])
    );
}

#[test]
fn unchanged_global_payload_still_requires_requested_effective_result() {
    let fixture = Fixture::new(
        Some(json!({"task":{"agentModelOverrides":{"reviewer":["synthetic/new"]}}})),
        json!({"task.agentModelOverrides":{"reviewer":"synthetic/old"}}),
        "scoped",
    );
    let before = fixture.bytes();
    assert!(fixture.save(override_change()).1.is_err());
    assert_eq!(fixture.bytes(), before);
    assert!(fixture.writes().is_empty());
}

#[test]
fn shared_checkout_executable_keeps_parallel_fixture_state_isolated() {
    let fixture = Fixture::new(None, json!({}), "scoped");
    let executable = PathBuf::from(&fixture.executable);
    let before = fs::read(&executable).unwrap();
    assert!(!executable.starts_with(&fixture.root));
    std::thread::scope(|scope| {
        for index in 0..8 {
            let executable = &executable;
            scope.spawn(move || {
                let fixture = Fixture::new(None, json!({}), "scoped");
                assert_eq!(Path::new(&fixture.executable), executable);
                let model = format!("synthetic/parallel-{index}");
                fixture
                    .save(
                        json!({"reviewer":{"modelOverride":[model],"expectedModelOverride":null}}),
                    )
                    .1
                    .unwrap();
                assert_eq!(
                    fixture.global(),
                    json!({"task":{"agentModelOverrides":{"reviewer":[model]}}})
                );
                assert_eq!(fixture.writes().len(), 1);
            });
        }
    });
    assert_eq!(fs::read(&executable).unwrap(), before);
}
