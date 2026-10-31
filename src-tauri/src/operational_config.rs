use crate::{
    models::{OmpAgentChange, OmpOperationalChange, OmpOperationalSetting, SettingsPatch},
    omp_bridge::{model_patterns, run_omp_json, run_omp_text},
    omp_command::{run_omp_command, OmpOperation},
    sessions::atomic_write_private_file,
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

// Only these operational namespaces and scalar types cross the generic UI boundary.
// Credentials, endpoints, arbitrary strings, records and arrays stay in their dedicated editors.
fn category(key: &str) -> Option<&'static str> {
    if matches!(key, "advisor.enabled" | "retry.modelFallback") {
        return None;
    }
    let groups: &[(&str, &[&str], &[&str])] = &[
        (
            "agent",
            &["advisor.", "prewalk.", "model.", "magicKeywords."],
            &[
                "git.enabled",
                "hideThinkingBlock",
                "proseOnlyThinking",
                "omitThinking",
                "externalThinking",
                "inlineToolDescriptors",
                "includeModelInPrompt",
                "includeWorkspaceTree",
                "skillful",
                "personality",
                "temperature",
                "topP",
                "topK",
                "minP",
                "presencePenalty",
                "repetitionPenalty",
                "textVerbosity",
                "steeringMode",
                "followUpMode",
                "interruptMode",
            ],
        ),
        (
            "context",
            &[
                "compaction.",
                "contextPromotion.",
                "branchSummary.",
                "snapcompact.",
            ],
            &["extendedContext"],
        ),
        ("retry", &["retry."], &[]),
        (
            "tools",
            &[
                "tools.",
                "read.",
                "edit.",
                "lsp.",
                "bash.",
                "bashInterceptor.",
                "python.",
                "jupyter.",
                "web.",
            ],
            &[],
        ),
        (
            "terminal",
            &[
                "terminal.",
                "tui.",
                "display.",
                "images.",
                "spelling.",
                "paste.",
            ],
            &[
                "readLineNumbers",
                "showHardwareCursor",
                "autocompleteMaxVisible",
                "emojiAutocomplete",
                "doubleEscapeAction",
                "treeFilterMode",
            ],
        ),
        (
            "tasks",
            &[
                "task.",
                "async.",
                "loop.",
                "ask.",
                "completion.",
                "error.",
                "recap.",
                "startup.",
                "autolearn.",
                "memories.",
                "ttsr.",
            ],
            &["power.sleepPrevention"],
        ),
    ];
    groups.iter().find_map(|(group, prefixes, keys)| {
        (prefixes.iter().any(|prefix| key.starts_with(prefix)) || keys.contains(&key))
            .then_some(*group)
    })
}

pub(crate) fn load_catalog(
    executable: &str,
    env: &HashMap<String, String>,
    raw: &Value,
) -> Result<Vec<OmpOperationalSetting>, String> {
    // The public JSON CLI supplies type/value/description, while its human form
    // supplies the schema's enum alternatives. Never send the human dump to the UI.
    let mut plain_env = env.clone();
    plain_env.insert("NO_COLOR".to_owned(), "1".to_owned());
    plain_env.insert("FORCE_COLOR".to_owned(), "0".to_owned());
    let listing = run_omp_text(
        executable,
        &["config", "list"],
        &plain_env,
        OmpOperation::Config,
    )?;
    Ok(build_catalog(raw, &listing))
}

fn build_catalog(raw: &Value, listing: &str) -> Vec<OmpOperationalSetting> {
    let enum_choices: HashMap<&str, Vec<String>> = listing
        .lines()
        .filter_map(|line| {
            let (key, rest) = line.trim().split_once(" = ")?;
            let (_, alternatives) = rest.rsplit_once(" (")?;
            let alternatives = alternatives.strip_suffix(')')?;
            Some((key, alternatives.split('|').map(str::to_owned).collect()))
        })
        .collect();
    let Some(entries) = raw.as_object() else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|(key, entry)| {
            let group = category(key)?;
            if entry.get("redacted").and_then(Value::as_bool) == Some(true) {
                return None;
            }
            let kind = entry.get("type")?.as_str()?;
            let value = entry.get("value").cloned().unwrap_or(Value::Null);
            let choices = if kind == "enum" {
                enum_choices.get(key.as_str())?.clone()
            } else {
                Vec::new()
            };
            let valid = match kind {
                "boolean" => value.is_boolean() || value.is_null(),
                "number" => value.is_number() || value.is_null(),
                "enum" => value
                    .as_str()
                    .is_some_and(|value| choices.iter().any(|choice| choice == value)),
                _ => false,
            };
            valid.then(|| OmpOperationalSetting {
                key: key.clone(),
                category: group.to_owned(),
                r#type: kind.to_owned(),
                description: entry
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                value,
                choices,
            })
        })
        .collect()
}

pub(crate) fn validate_changes(
    catalog: &[OmpOperationalSetting],
    changes: &BTreeMap<String, OmpOperationalChange>,
) -> Result<(), String> {
    for (key, change) in changes {
        let setting = catalog.iter().find(|setting| &setting.key == key)
            .ok_or_else(|| format!("Параметр `{key}` не поддерживается графическими настройками установленного OMP"))?;
        if setting.value != change.expected_value {
            return Err(format!(
                "Параметр `{key}` изменён вне этого окна; обновите настройки перед сохранением"
            ));
        }
        if change.reset {
            continue;
        }
        let valid = match setting.r#type.as_str() {
            "boolean" => change.value.is_boolean(),
            "number" => change.value.as_f64().is_some_and(f64::is_finite),
            "enum" => change
                .value
                .as_str()
                .is_some_and(|value| setting.choices.iter().any(|choice| choice == value)),
            _ => false,
        };
        if !valid {
            return Err(format!("Некорректное значение параметра `{key}`"));
        }
    }
    Ok(())
}

struct ConfigWrite {
    key: String,
    owned_roles: Option<Vec<String>>,
    before: Option<Vec<u8>>,
    after: Option<Vec<u8>>,
}

// A failed multi-setting save restores exact bytes (including absent values and
// comments), but only when no unrelated or subsequent writer would be overwritten.
// Successful writes always use the runtime's public CLI, locking and merge rules.
pub(crate) struct OperationalTransaction {
    path: PathBuf,
    writes: Vec<ConfigWrite>,
    expected: BTreeMap<String, Value>,
}

impl OperationalTransaction {
    pub(crate) fn prepare(executable: &str, env: &HashMap<String, String>) -> Result<Self, String> {
        let directory = run_omp_text(executable, &["config", "path"], env, OmpOperation::Config)?;
        let directory = PathBuf::from(directory.trim());
        if !directory.is_absolute() {
            return Err("OMP вернул некорректный путь конфигурации".to_owned());
        }
        let mut path = directory.join("config.yml");
        if !path
            .try_exists()
            .map_err(|_| "Не удалось проверить config.yml")?
        {
            let legacy = directory.join("config.yaml");
            if legacy
                .try_exists()
                .map_err(|_| "Не удалось проверить config.yaml")?
            {
                path = legacy;
            }
        }
        // Resolve existing symlinks so rollback never replaces the user's link.
        if fs::symlink_metadata(&path).is_ok() {
            path =
                fs::canonicalize(path).map_err(|_| "Не удалось разрешить путь конфигурации OMP")?;
        }
        Ok(Self {
            path,
            writes: Vec::new(),
            expected: BTreeMap::new(),
        })
    }

    pub(crate) fn apply(
        &mut self,
        executable: &str,
        env: &HashMap<String, String>,
        changes: &BTreeMap<String, OmpOperationalChange>,
    ) -> Result<(), String> {
        for (key, change) in changes {
            let value = self.apply_change(executable, env, key, change)?;
            self.expected.insert(key.clone(), value);
        }
        Ok(())
    }

    pub(crate) fn apply_change(
        &mut self,
        executable: &str,
        env: &HashMap<String, String>,
        key: &str,
        change: &OmpOperationalChange,
    ) -> Result<Value, String> {
        self.apply_checked(executable, env, key, change, None)
    }

    pub(crate) fn apply_roles(
        &mut self,
        executable: &str,
        env: &HashMap<String, String>,
        changes: &BTreeMap<String, String>,
        previous: &[crate::models::OmpRoleInfo],
    ) -> Result<BTreeMap<String, String>, String> {
        let result = run_omp_json(
            executable,
            &["config", "get", "modelRoles", "--json"],
            env,
            OmpOperation::Config,
        )?;
        let current = result.get("value").cloned().unwrap_or(Value::Null);
        let mut roles = current
            .as_object()
            .cloned()
            .ok_or("OMP вернул некорректные роли моделей")?;
        for (role, selector) in changes {
            let baseline = previous
                .iter()
                .find(|value| &value.role == role)
                .map(|value| value.selector.trim())
                .unwrap_or_default();
            if roles
                .get(role)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                != baseline
            {
                return Err(format!(
                    "Роль `{role}` изменена во время сохранения; обновите настройки"
                ));
            }
            if selector.is_empty() {
                roles.remove(role);
            } else {
                roles.insert(role.clone(), Value::String(selector.clone()));
            }
        }
        let value = self.apply_checked(
            executable,
            env,
            "modelRoles",
            &OmpOperationalChange {
                expected_value: current,
                value: Value::Object(roles),
                reset: false,
            },
            Some(changes.keys().cloned().collect()),
        )?;
        serde_json::from_value(value)
            .map_err(|_| "OMP вернул некорректные роли после сохранения".to_owned())
    }

    pub(crate) fn apply_agents(
        &mut self,
        executable: &str,
        env: &HashMap<String, String>,
        changes: &BTreeMap<String, OmpAgentChange>,
    ) -> Result<(), String> {
        if changes.is_empty() {
            return Ok(());
        }
        // Probe this executable on every save; a cached version/capability can
        // outlive a runtime replacement, and legacy wrappers may ignore --scope.
        require_agent_scope(executable, env)?;
        for key in ["task.agentModelOverrides", "task.disabledAgents"] {
            let relevant = changes
                .iter()
                .filter(|(_, change)| {
                    if key == "task.disabledAgents" {
                        change.enabled.is_some()
                    } else {
                        !matches!(&change.model_override, SettingsPatch::Missing)
                    }
                })
                .map(|(name, _)| name.clone())
                .collect::<Vec<_>>();
            if relevant.is_empty() {
                continue;
            }
            let result = run_omp_json(
                executable,
                &["config", "get", key, "--json"],
                env,
                OmpOperation::Config,
            )?;
            let current = result.get("value").cloned().unwrap_or(Value::Null);
            // User baselines describe effective settings, never the global layer.
            merge_agent_changes(key, &current, changes)?;
            let global = read_agent_global(executable, env, key)?;
            let value = merge_global_agent_changes(key, global.as_ref(), changes)?;
            self.apply_agent_write(
                executable,
                env,
                AgentWrite {
                    key,
                    effective: current,
                    global,
                    value,
                    names: relevant,
                },
            )?;
            // A project/overlay can still shadow a successful global write (or
            // an inherited-only clear). Do not report that as an applied edit.
            let effective = run_omp_json(
                executable,
                &["config", "get", key, "--json"],
                env,
                OmpOperation::Config,
            )?;
            verify_agent_value(key, effective.get("value").unwrap_or(&Value::Null), changes)?;
        }
        Ok(())
    }

    fn apply_agent_write(
        &mut self,
        executable: &str,
        env: &HashMap<String, String>,
        write: AgentWrite,
    ) -> Result<(), String> {
        let current = run_omp_json(
            executable,
            &["config", "get", write.key, "--json"],
            env,
            OmpOperation::Config,
        )?;
        // Recheck both layers: a hidden global sibling can change without any
        // effective change. This is a stale-read guard, not cross-process CAS;
        // the public CLI still has a read/set window before acquiring its lock.
        if current.get("value") != Some(&write.effective)
            || read_agent_global(executable, env, write.key)? != write.global
        {
            return Err(format!(
                "Параметр `{}` изменён во время сохранения; обновите настройки",
                write.key
            ));
        }
        if write.global == write.value {
            return Ok(());
        }
        let value = write.value.ok_or("Нельзя сбросить весь параметр агентов")?;
        let before = read_optional(&self.path)?;
        let rendered = value.to_string();
        let result = run_omp_json(
            executable,
            &["config", "set", write.key, &rendered, "--json"],
            env,
            OmpOperation::Config,
        );
        let after = read_optional(&self.path)?;
        if before != after {
            self.writes.push(ConfigWrite {
                key: write.key.to_owned(),
                owned_roles: Some(write.names),
                before,
                after,
            });
        }
        // The scoped CLI contract returns the saved global value. Read it back
        // as well; comparing the entire effective record with this payload
        // would incorrectly reject preserved project/overlay siblings.
        if result?.get("value") != Some(&value)
            || read_agent_global(executable, env, write.key)?.as_ref() != Some(&value)
        {
            return Err(format!(
                "OMP не применил значение параметра `{}`",
                write.key
            ));
        }
        Ok(())
    }

    fn apply_checked(
        &mut self,
        executable: &str,
        env: &HashMap<String, String>,
        key: &str,
        change: &OmpOperationalChange,
        owned_roles: Option<Vec<String>>,
    ) -> Result<Value, String> {
        let current = run_omp_json(
            executable,
            &["config", "get", key, "--json"],
            env,
            OmpOperation::Config,
        )?;
        let current = current.get("value").unwrap_or(&Value::Null);
        if current != &change.expected_value {
            return Err(format!(
                "Параметр `{key}` изменён во время сохранения; обновите настройки"
            ));
        }
        if !change.reset && current == &change.value {
            return Ok(current.clone());
        }
        let before = read_optional(&self.path)?;
        let rendered = change
            .value
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| change.value.to_string());
        let args = if change.reset {
            vec!["config", "reset", key, "--json"]
        } else {
            vec!["config", "set", key, rendered.as_str(), "--json"]
        };
        let result = run_omp_json(executable, &args, env, OmpOperation::Config);
        let after = read_optional(&self.path)?;
        if before != after {
            self.writes.push(ConfigWrite {
                key: key.to_owned(),
                owned_roles,
                before,
                after,
            });
        }
        let value = result?.get("value").cloned().unwrap_or(Value::Null);
        if !change.reset && value != change.value {
            return Err(format!("OMP не применил значение параметра `{key}`"));
        }
        Ok(value)
    }

    pub(crate) fn verify(&self, catalog: &[OmpOperationalSetting]) -> Result<(), String> {
        for (key, value) in &self.expected {
            if !catalog
                .iter()
                .any(|setting| &setting.key == key && &setting.value == value)
            {
                return Err(format!("OMP не подтвердил сохранённое значение `{key}`"));
            }
        }
        Ok(())
    }

    pub(crate) fn rollback(&self) -> Vec<String> {
        let mut errors = Vec::new();
        for write in self.writes.iter().rev() {
            if let Err(error) = rollback_write(&self.path, write) {
                errors.push(error);
                // Earlier snapshots predate this write and cannot safely replace it.
                break;
            }
        }
        errors
    }
}

struct AgentWrite {
    key: &'static str,
    effective: Value,
    global: Option<Value>,
    value: Option<Value>,
    names: Vec<String>,
}

fn require_agent_scope(executable: &str, env: &HashMap<String, String>) -> Result<(), String> {
    let mut plain_env = env.clone();
    plain_env.insert("NO_COLOR".to_owned(), "1".to_owned());
    plain_env.insert("FORCE_COLOR".to_owned(), "0".to_owned());
    // A successful JSON response alone is unsafe: old parseConfigArgs wrappers
    // silently ignore --scope. The current handler rejects this read-only use
    // before Settings.init, proving that the selected CLI forwards the flag.
    let output = run_omp_command(
        executable,
        &[
            "config",
            "get",
            "task.disabledAgents",
            "--scope",
            "global",
            "--json",
        ],
        &plain_env,
        OmpOperation::Config,
    );
    if output.is_ok_and(|output| {
        !output.status.success()
            && output.stdout.iter().all(u8::is_ascii_whitespace)
            && String::from_utf8_lossy(&output.stderr).trim()
                == "--scope applies to `config list` only"
    }) {
        Ok(())
    } else {
        Err("Выбранный OMP не подтвердил поддержку `config list --scope global`, необходимую для безопасного сохранения агентов. Остальные настройки можно сохранить отдельно".to_owned())
    }
}

fn read_agent_global(
    executable: &str,
    env: &HashMap<String, String>,
    key: &str,
) -> Result<Option<Value>, String> {
    let raw = run_omp_json(
        executable,
        &["config", "list", "--scope", "global", "--json"],
        env,
        OmpOperation::Config,
    )?;
    let invalid = || format!("OMP вернул некорректный global-параметр `{key}`");
    let entries = raw.as_object().ok_or_else(invalid)?;
    let Some(entry) = entries.get(key) else {
        return Ok(None);
    };
    let kind = if key == "task.disabledAgents" {
        "array"
    } else {
        "record"
    };
    if entry.get("type").and_then(Value::as_str) != Some(kind)
        || entry.get("redacted").and_then(Value::as_bool) == Some(true)
    {
        return Err(invalid());
    }
    entry.get("value").cloned().map(Some).ok_or_else(invalid)
}

fn merge_global_agent_changes(
    key: &str,
    global: Option<&Value>,
    changes: &BTreeMap<String, OmpAgentChange>,
) -> Result<Option<Value>, String> {
    // Absence is not null or an empty container. Never normalize an invalid raw
    // value, and never reconstruct YAML or a whole layer from config list.
    let invalid = || {
        format!(
            "Нельзя безопасно изменить global-параметр `{key}`: ожидается {}",
            if key == "task.disabledAgents" {
                "массив"
            } else {
                "объект"
            }
        )
    };
    let value = if key == "task.disabledAgents" {
        let mut disabled = match global {
            Some(value) => value.as_array().cloned().ok_or_else(invalid)?,
            None => Vec::new(),
        };
        for (name, change) in changes {
            match change.enabled {
                Some(true) => disabled.retain(|value| value.as_str() != Some(name.as_str())),
                Some(false) if !disabled.iter().any(|value| value.as_str() == Some(name)) => {
                    disabled.push(Value::String(name.clone()));
                }
                _ => {}
            }
        }
        Value::Array(disabled)
    } else {
        let mut overrides = match global {
            Some(value) => value.as_object().cloned().ok_or_else(invalid)?,
            None => serde_json::Map::new(),
        };
        for (name, change) in changes {
            match &change.model_override {
                SettingsPatch::Set(Some(patterns)) => {
                    overrides.insert(
                        name.clone(),
                        serde_json::to_value(patterns).map_err(|_| "Некорректные модели агента")?,
                    );
                }
                SettingsPatch::Set(None) => {
                    overrides.remove(name);
                }
                SettingsPatch::Missing => {}
            }
        }
        Value::Object(overrides)
    };
    if global.is_none()
        && (value.as_object().is_some_and(|value| value.is_empty())
            || value.as_array().is_some_and(|value| value.is_empty()))
    {
        Ok(None)
    } else {
        Ok(Some(value))
    }
}

fn verify_agent_value(
    key: &str,
    effective: &Value,
    changes: &BTreeMap<String, OmpAgentChange>,
) -> Result<(), String> {
    for (name, change) in changes {
        let applied = if key == "task.disabledAgents" {
            change.enabled.is_none_or(|enabled| {
                effective.as_array().is_some_and(|disabled| {
                    enabled != disabled.iter().any(|value| value.as_str() == Some(name))
                })
            })
        } else {
            match &change.model_override {
                SettingsPatch::Missing => true,
                SettingsPatch::Set(expected) => effective.as_object().is_some_and(|overrides| {
                    overrides.get(name).and_then(model_patterns) == *expected
                }),
            }
        };
        if !applied {
            return Err(format!("OMP не применил настройки агента `{name}`; проверьте переопределения проекта или overlay"));
        }
    }
    Ok(())
}

fn merge_agent_changes(
    key: &str,
    current: &Value,
    changes: &BTreeMap<String, OmpAgentChange>,
) -> Result<Value, String> {
    let conflict = |name: &str| {
        format!("Настройки агента `{name}` изменены во время сохранения; обновите настройки")
    };
    if key == "task.disabledAgents" {
        let mut disabled = current
            .as_array()
            .cloned()
            .ok_or("OMP вернул некорректный task.disabledAgents")?;
        for (name, change) in changes {
            let Some(enabled) = change.enabled else {
                continue;
            };
            let actual = !disabled
                .iter()
                .any(|value| value.as_str() == Some(name.as_str()));
            if change.expected_enabled != Some(actual) {
                return Err(conflict(name));
            }
            if enabled {
                disabled.retain(|value| value.as_str() != Some(name.as_str()));
            } else if actual {
                disabled.push(Value::String(name.clone()));
            }
        }
        return Ok(Value::Array(disabled));
    }
    let mut overrides = current
        .as_object()
        .cloned()
        .ok_or("OMP вернул некорректный task.agentModelOverrides")?;
    for (name, change) in changes {
        let SettingsPatch::Set(requested) = &change.model_override else {
            continue;
        };
        let SettingsPatch::Set(expected) = &change.expected_model_override else {
            return Err(conflict(name));
        };
        let actual = overrides.get(name).and_then(model_patterns);
        if &actual != expected {
            return Err(conflict(name));
        }
        if let Some(patterns) = requested {
            overrides.insert(
                name.clone(),
                serde_json::to_value(patterns).map_err(|_| "Некорректные модели агента")?,
            );
        } else {
            overrides.remove(name);
        }
    }
    Ok(Value::Object(overrides))
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(_) => {
            Err("Не удалось прочитать конфигурацию OMP для безопасного сохранения".to_owned())
        }
    }
}

fn parse_config(bytes: Option<&[u8]>) -> Result<Value, String> {
    let Some(bytes) = bytes.filter(|bytes| !bytes.is_empty()) else {
        return Ok(serde_json::json!({}));
    };
    let text = std::str::from_utf8(bytes).map_err(|_| "Конфигурация OMP не является UTF-8")?;
    let value: Value =
        serde_saphyr::from_str(text).map_err(|_| "Не удалось проверить YAML конфигурации OMP")?;
    if value.is_null() {
        Ok(serde_json::json!({}))
    } else {
        Ok(value)
    }
}

fn remove_path(value: &mut Value, segments: &[&str]) {
    let Some((key, rest)) = segments.split_first() else {
        return;
    };
    let Some(object) = value.as_object_mut() else {
        return;
    };
    if rest.is_empty() {
        object.remove(*key);
    } else if let Some(child) = object.get_mut(*key) {
        remove_path(child, rest);
        if child.as_object().is_some_and(|object| object.is_empty()) {
            object.remove(*key);
        }
    }
}

fn mask_owned_entries(config: &mut Value, key: &str, names: &[String]) {
    let pointer = format!("/{}", key.replace('.', "/"));
    if let Some(value) = config.pointer_mut(&pointer) {
        if key == "task.disabledAgents" {
            if let Some(entries) = value.as_array_mut() {
                entries.retain(|entry| {
                    !entry
                        .as_str()
                        .is_some_and(|name| names.iter().any(|owned| owned == name))
                });
                if entries.is_empty() {
                    remove_path(config, &key.split('.').collect::<Vec<_>>());
                }
            }
        } else if let Some(record) = value.as_object_mut() {
            for name in names {
                record.remove(name);
            }
            if record.is_empty() {
                remove_path(config, &key.split('.').collect::<Vec<_>>());
            }
        }
    }
}

fn rollback_write(path: &Path, write: &ConfigWrite) -> Result<(), String> {
    let conflict = || {
        format!("Конфигурация OMP изменилась извне; откат `{}` не перезаписал чужие изменения. Обновите настройки", write.key)
    };
    if read_optional(path)? != write.after {
        return Err(conflict());
    }
    let mut before = parse_config(write.before.as_deref())?;
    let mut after = parse_config(write.after.as_deref())?;
    if let Some(names) = &write.owned_roles {
        for config in [&mut before, &mut after] {
            mask_owned_entries(config, &write.key, names);
        }
    } else {
        let segments: Vec<_> = write.key.split('.').collect();
        remove_path(&mut before, &segments);
        remove_path(&mut after, &segments);
    }
    if before != after {
        return Err(conflict());
    }
    // Recheck after parsing, immediately before the same private atomic writer used
    // by the existing provider-file transaction. Non-cooperating writers still win
    // the conflict check rather than being silently rolled back.
    if read_optional(path)? != write.after {
        return Err(conflict());
    }
    match &write.before {
        Some(bytes) => atomic_write_private_file(path, bytes)
            .map_err(|_| "Не удалось восстановить конфигурацию OMP".to_owned()),
        None => fs::remove_file(path)
            .map_err(|_| "Не удалось отменить создание конфигурации OMP".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn agent_updates_preserve_other_agents_arrays_and_check_only_requested_fields() {
        let changes: BTreeMap<String, OmpAgentChange> = serde_json::from_value(json!({
            "reviewer": {"modelOverride":["@slow","synthetic/*:high"], "expectedModelOverride":["synthetic/old"]}
        })).unwrap();
        let current = json!({"reviewer":"synthetic/old", "security-reviewer":["synthetic/external", "@task"], "plugin-agent":"synthetic/plugin"});
        let merged = merge_agent_changes("task.agentModelOverrides", &current, &changes).unwrap();
        assert_eq!(merged["reviewer"], json!(["@slow", "synthetic/*:high"]));
        assert_eq!(merged["security-reviewer"], current["security-reviewer"]);
        assert_eq!(merged["plugin-agent"], current["plugin-agent"]);
        let changed_same_agent = json!({"reviewer":"synthetic/newer"});
        assert!(
            merge_agent_changes("task.agentModelOverrides", &changed_same_agent, &changes).is_err()
        );
        // An override-only save does not replace disabled names or require an enabled baseline.
        let disabled = json!(["reviewer", "external-agent", {"unknown":"keep"}]);
        assert_eq!(
            merge_agent_changes("task.disabledAgents", &disabled, &changes).unwrap(),
            disabled
        );
    }

    #[test]
    fn clearing_agent_override_removes_entry_and_distinguishes_missing_baseline() {
        let changes: BTreeMap<String, OmpAgentChange> = serde_json::from_value(json!({
            "reviewer": {"modelOverride":null,"expectedModelOverride":["@slow"]}
        }))
        .unwrap();
        let merged = merge_agent_changes(
            "task.agentModelOverrides",
            &json!({"reviewer":["@slow"], "other":["first", "second"]}),
            &changes,
        )
        .unwrap();
        assert!(merged.get("reviewer").is_none());
        assert_eq!(merged["other"], json!(["first", "second"]));
        let missing_baseline =
            serde_json::from_value(json!({"reviewer":{"modelOverride":null}})).unwrap();
        assert!(
            merge_agent_changes("task.agentModelOverrides", &json!({}), &missing_baseline).is_err()
        );
        let enabled_only =
            serde_json::from_value(json!({"reviewer":{"enabled":true,"expectedEnabled":false}}))
                .unwrap();
        assert_eq!(
            merge_agent_changes(
                "task.disabledAgents",
                &json!(["reviewer", "other", "reviewer"]),
                &enabled_only
            )
            .unwrap(),
            json!(["other"])
        );
        assert!(
            merge_agent_changes("task.disabledAgents", &json!(["other"]), &enabled_only).is_err()
        );
    }

    #[test]
    fn agent_rollback_does_not_own_unrequested_names_or_task_fields() {
        let mut before =
            json!({"task":{"agentModelOverrides":{"reviewer":"old","other":"keep"},"batch":true}});
        let mut after = json!({"task":{"agentModelOverrides":{"reviewer":["new"],"other":"external"},"batch":true}});
        let owned = vec!["reviewer".to_owned()];
        mask_owned_entries(&mut before, "task.agentModelOverrides", &owned);
        mask_owned_entries(&mut after, "task.agentModelOverrides", &owned);
        assert_ne!(before, after);
        let mut before = json!({"task":{"batch":true}});
        let mut after = json!({"task":{"disabledAgents":["reviewer"],"batch":true}});
        mask_owned_entries(&mut before, "task.disabledAgents", &owned);
        mask_owned_entries(&mut after, "task.disabledAgents", &owned);
        assert_eq!(before, after);
    }

    #[test]
    fn catalog_never_exposes_generic_secrets_or_unrecognized_enum_values() {
        let raw = json!({
            "tools.maxTimeout": {"type":"number", "value":120},
            "tools.approvalMode": {"type":"enum", "value":"write"},
            "images.urls.credentials": {"type":"record", "value":{"token":"synthetic"}},
            "compaction.remoteEndpoint": {"type":"string", "value":"https://synthetic.invalid"},
            "task.eager": {"type":"enum", "value":"not-a-schema-choice"},
            "task.batch": {"type":"boolean", "redacted":true}
        });
        let catalog = build_catalog(&raw, "  tools.approvalMode = write (always-ask|write|yolo)\n  task.eager = redacted (default|preferred|always)");
        assert_eq!(
            catalog
                .iter()
                .map(|setting| setting.key.as_str())
                .collect::<Vec<_>>(),
            vec!["tools.approvalMode", "tools.maxTimeout"]
        );
        let mut changes = BTreeMap::new();
        changes.insert(
            "tools.maxTimeout".to_owned(),
            OmpOperationalChange {
                expected_value: json!(120),
                value: json!("NaN"),
                reset: false,
            },
        );
        assert!(validate_changes(&catalog, &changes).is_err());
        changes.get_mut("tools.maxTimeout").unwrap().value = json!(300);
        assert!(validate_changes(&catalog, &changes).is_ok());
        changes.get_mut("tools.maxTimeout").unwrap().expected_value = json!(60);
        assert!(validate_changes(&catalog, &changes).is_err());
    }

    #[test]
    fn failed_save_restores_inherited_value_without_erasing_external_writes() {
        let directory = std::env::temp_dir().join(format!(
            "omp-operation-rollback-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("config.yml");
        let before = b"# keep comment\nunknown: keep\n".to_vec();
        let after = b"unknown: keep\nretry:\n  maxRetries: 5\n".to_vec();
        fs::write(&path, &after).unwrap();
        let write = ConfigWrite {
            key: "retry.maxRetries".to_owned(),
            owned_roles: None,
            before: Some(before.clone()),
            after: Some(after.clone()),
        };
        rollback_write(&path, &write).unwrap();
        assert_eq!(fs::read(&path).unwrap(), before);
        let concurrent = b"unknown: external\nretry:\n  maxRetries: 5\n";
        fs::write(&path, concurrent).unwrap();
        assert!(rollback_write(&path, &write).is_err());
        assert_eq!(fs::read(&path).unwrap(), concurrent);
        // Even if an unrelated change was observed in the CLI's own post-write
        // snapshot, rollback must not restore an older value over that change.
        let concurrent_write = ConfigWrite {
            after: Some(concurrent.to_vec()),
            ..write
        };
        assert!(rollback_write(&path, &concurrent_write).is_err());
        assert_eq!(fs::read(&path).unwrap(), concurrent);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn role_rollback_owns_only_changed_roles_and_retains_foreign_mutations() {
        let directory = std::env::temp_dir().join(format!(
            "omp-role-rollback-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("config.yml");
        let before = b"unknown: keep\nmodelRoles:\n  default: synthetic/old\n  advisor: synthetic/external\n".to_vec();
        let after = b"unknown: keep\nmodelRoles:\n  default: synthetic/new\n  advisor: synthetic/external\n".to_vec();
        let write = ConfigWrite {
            key: "modelRoles".to_owned(),
            owned_roles: Some(vec!["default".to_owned()]),
            before: Some(before.clone()),
            after: Some(after.clone()),
        };
        fs::write(&path, &after).unwrap();
        rollback_write(&path, &write).unwrap();
        assert_eq!(fs::read(&path).unwrap(), before);
        let foreign =
            b"unknown: keep\nmodelRoles:\n  default: synthetic/new\n  advisor: synthetic/later\n"
                .to_vec();
        fs::write(&path, &foreign).unwrap();
        // Refuse rollback even when the CLI post-write snapshot itself observed
        // a concurrent, unowned role change. Never restore stale whole records.
        let write = ConfigWrite {
            after: Some(foreign.clone()),
            ..write
        };
        assert!(rollback_write(&path, &write).is_err());
        assert_eq!(fs::read(&path).unwrap(), foreign);
        fs::remove_dir_all(directory).unwrap();
    }
}

#[cfg(all(test, unix))]
#[path = "operational_config_scope_tests.rs"]
mod scope_tests;
