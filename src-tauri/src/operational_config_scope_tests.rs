use super::*;
use serde_json::json;
use std::os::unix::fs::PermissionsExt;

// A real subprocess exercises the Rust command/transaction boundary. This is
// an isolated synthetic CLI, not evidence of a native OMP or Windows UI run.
const CLI: &str = r#"#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ['OMP_SCOPE_TEST_ROOT'])
args = sys.argv[1:]
with (root / 'calls.jsonl').open('a') as log:
    log.write(json.dumps(args) + '\n')
mode = (root / 'mode').read_text()
path = root / 'config.yml'
state = json.loads(path.read_text()) if path.exists() else {}
project = json.loads((root / 'project.json').read_text())
def raw(key):
    value = state
    for part in key.split('.'):
        if not isinstance(value, dict) or part not in value: return None, False
        value = value[part]
    return value, True
def effective(key):
    value, present = raw(key)
    if key in project:
        inherited = project[key]
        if isinstance(value, dict) and isinstance(inherited, dict): return {**value, **inherited}
        return inherited
    return value if present else ([] if key == 'task.disabledAgents' else {} if key == 'task.agentModelOverrides' else False)
def listing(scoped):
    result = {}
    for key, kind in [('task.agentModelOverrides','record'), ('task.disabledAgents','array')]:
        value, present = raw(key)
        if not scoped or present:
            result[key] = {'type':kind, 'value':value if scoped else effective(key)}
    return result
def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)
if args[0:2] == ['config','path']:
    print(root)
elif '--scope' in args and mode == 'old-parser':
    fail('Unknown flag: --scope')
elif '--scope' in args and mode not in ['legacy-wrapper', 'legacy-new-help'] and args[1] != 'list':
    fail('--scope applies to `config list` only')
elif args[0:2] == ['config','list']:
    scoped = '--scope' in args and mode not in ['legacy-wrapper', 'legacy-new-help']
    result = json.loads(json.dumps(listing(scoped)))
    if scoped and mode == 'invalid-list': result = []
    if scoped and mode == 'hidden-race':
        counter = root / 'reads'
        n = int(counter.read_text()) if counter.exists() else 0
        counter.write_text(str(n + 1))
        if n == 0:
            state['task']['agentModelOverrides']['hidden'] = 'synthetic/concurrent'
            path.write_text(json.dumps(state))
    print(json.dumps(result))
elif args[0:2] == ['config','get']:
    print(json.dumps({'key':args[2], 'value':effective(args[2])}))
elif args[0:2] == ['config','set']:
    key = args[2]
    if mode == 'fail-second' and key == 'task.disabledAgents': fail('synthetic second write failure')
    parent = state
    parts = key.split('.')
    for part in parts[:-1]: parent = parent.setdefault(part,{})
    parent[parts[-1]] = json.loads(args[3])
    if mode == 'foreign-during-write': state['unknown'] = 'external'
    path.write_text(json.dumps(state))
    if mode == 'fail-after-write': fail('synthetic failure after write')
    print(json.dumps({'key':key, 'value':parent[parts[-1]]}))
else:
    fail('Unsupported synthetic command')
"#;

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
        let executable = root.join("omp-test");
        fs::write(&executable, CLI).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
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
