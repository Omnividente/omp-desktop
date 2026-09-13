use crate::{
    models::{OmpOperationalChange, OmpOperationalSetting},
    omp_bridge::{run_omp_json, run_omp_text},
    omp_command::OmpOperation,
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
            let current = run_omp_json(
                executable,
                &["config", "get", key, "--json"],
                env,
                OmpOperation::Config,
            )?;
            if current.get("value").unwrap_or(&Value::Null) != &change.expected_value {
                return Err(format!(
                    "Параметр `{key}` изменён во время сохранения; обновите настройки"
                ));
            }
            let before = read_optional(&self.path)?;
            let rendered = change
                .value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| change.value.to_string());
            let args = if change.reset {
                vec!["config", "reset", key.as_str(), "--json"]
            } else {
                vec!["config", "set", key.as_str(), rendered.as_str(), "--json"]
            };
            let result = run_omp_json(executable, &args, env, OmpOperation::Config);
            let after = read_optional(&self.path)?;
            if before != after {
                self.writes.push(ConfigWrite {
                    key: key.clone(),
                    before,
                    after,
                });
            }
            let result = result?;
            let value = result.get("value").cloned().unwrap_or(Value::Null);
            if !change.reset && value != change.value {
                return Err(format!("OMP не применил значение параметра `{key}`"));
            }
            self.expected.insert(key.clone(), value);
        }
        Ok(())
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

fn rollback_write(path: &Path, write: &ConfigWrite) -> Result<(), String> {
    let conflict = || {
        format!("Конфигурация OMP изменилась извне; откат `{}` не перезаписал чужие изменения. Обновите настройки", write.key)
    };
    if read_optional(path)? != write.after {
        return Err(conflict());
    }
    let mut before = parse_config(write.before.as_deref())?;
    let mut after = parse_config(write.after.as_deref())?;
    let segments: Vec<_> = write.key.split('.').collect();
    remove_path(&mut before, &segments);
    remove_path(&mut after, &segments);
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
}
