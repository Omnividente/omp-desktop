use keyring::v1::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "com.ompdesk.desktop";
pub const FALLBACK_WARNING: &str = "fallback_file";

pub const UNAVAILABLE_WARNING: &str = "unavailable";

#[derive(Debug)]
pub struct LoadedSecrets {
    pub values: HashMap<String, String>,
    pub keys: Vec<String>,
    pub warning: Option<String>,
    pub migrated: bool,
}
#[derive(Debug, Default, Deserialize, Serialize)]
struct FallbackSecrets {
    #[serde(default)]
    values: BTreeMap<String, String>,
}

pub fn load_provider_secrets(
    app: &AppHandle,
    configured_keys: &[String],
    legacy_values: HashMap<String, String>,
) -> Result<LoadedSecrets, String> {
    let fallback_path = fallback_path(app)?;
    let fallback_existed = fallback_path.exists();
    let fallback_values = read_fallback(&fallback_path)?;
    let legacy_existed = !legacy_values.is_empty();
    let mut seed = fallback_values;
    seed.extend(legacy_values);

    let mut keys = configured_keys.iter().cloned().collect::<BTreeSet<_>>();
    keys.extend(seed.keys().cloned());

    if !seed.is_empty() {
        match write_keyring(&seed) {
            Ok(()) => {
                remove_fallback(&fallback_path)?;
                let mut values = seed;
                for key in &keys {
                    if values.contains_key(key) {
                        continue;
                    }
                    if let Some(value) = read_keyring(key)? {
                        values.insert(key.clone(), value);
                    }
                }
                return Ok(LoadedSecrets {
                    values: values.into_iter().collect(),
                    keys: keys.into_iter().collect(),
                    warning: None,
                    migrated: legacy_existed || fallback_existed,
                });
            }
            Err(_) => {
                write_fallback(&fallback_path, &seed)?;
                return Ok(LoadedSecrets {
                    values: seed.into_iter().collect(),
                    keys: keys.into_iter().collect(),
                    warning: Some(FALLBACK_WARNING.to_owned()),
                    migrated: legacy_existed || fallback_existed,
                });
            }
        }
    }

    let mut values = BTreeMap::new();
    let mut warning = None;
    for key in &keys {
        match read_keyring(key) {
            Ok(Some(value)) => {
                values.insert(key.clone(), value);
            }
            Ok(None) => {}
            Err(_) => {
                warning = Some(UNAVAILABLE_WARNING.to_owned());
                break;
            }
        }
    }
    Ok(LoadedSecrets {
        values: values.into_iter().collect(),
        keys: keys.into_iter().collect(),
        warning,
        migrated: false,
    })
}

pub fn update_provider_secrets(
    app: &AppHandle,
    current: &HashMap<String, String>,
    configured_keys: &[String],
    requested: HashMap<String, String>,
) -> Result<LoadedSecrets, String> {
    let (next, next_keys) = merge_requested_secrets(current, requested);
    let stale = configured_keys
        .iter()
        .filter(|key| !next_keys.contains(*key))
        .cloned()
        .collect::<Vec<_>>();
    let fallback_path = fallback_path(app)?;
    let keyring_result = write_keyring(&next)
        .and_then(|()| delete_keyring(&stale))
        .and_then(|()| probe_keyring(&next_keys));
    let warning = if keyring_result.is_ok() {
        remove_fallback(&fallback_path)?;
        None
    } else if next.is_empty() {
        Some(UNAVAILABLE_WARNING.to_owned())
    } else {
        write_fallback(&fallback_path, &next)?;
        Some(FALLBACK_WARNING.to_owned())
    };
    Ok(LoadedSecrets {
        values: next.into_iter().collect(),
        keys: next_keys.into_iter().collect(),
        warning,
        migrated: false,
    })
}

fn merge_requested_secrets(
    current: &HashMap<String, String>,
    requested: HashMap<String, String>,
) -> (BTreeMap<String, String>, BTreeSet<String>) {
    let mut values = BTreeMap::new();
    let mut keys = BTreeSet::new();
    for (raw_key, value) in requested {
        let key = raw_key.trim().to_owned();
        if key.is_empty() {
            continue;
        }
        keys.insert(key.clone());
        if value.trim().is_empty() {
            if let Some(existing) = current.get(&key) {
                values.insert(key, existing.clone());
            }
        } else {
            values.insert(key, value);
        }
    }
    (values, keys)
}

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, key)
        .map_err(|error| format!("Системное хранилище недоступно для `{key}`: {error}"))
}

fn probe_keyring(keys: &BTreeSet<String>) -> Result<(), String> {
    if let Some(key) = keys.iter().next() {
        let _ = read_keyring(key)?;
    }
    Ok(())
}

fn read_keyring(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Не удалось прочитать credential `{key}` из системного хранилища: {error}"
        )),
    }
}

fn write_keyring(values: &BTreeMap<String, String>) -> Result<(), String> {
    for (key, value) in values {
        entry(key)?.set_password(value).map_err(|error| {
            format!("Не удалось сохранить credential `{key}` в системном хранилище: {error}")
        })?;
    }
    Ok(())
}

fn delete_keyring(keys: &[String]) -> Result<(), String> {
    for key in keys {
        match entry(key)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => {}
            Err(error) => {
                return Err(format!(
                    "Не удалось удалить credential `{key}` из системного хранилища: {error}"
                ))
            }
        }
    }
    Ok(())
}

fn fallback_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Не удалось определить папку настроек: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Не удалось создать {}: {error}", directory.display()))?;
    Ok(directory.join("provider-secrets.json"))
}

fn read_fallback(path: &Path) -> Result<BTreeMap<String, String>, String> {
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Не удалось прочитать резервное хранилище: {error}"))?;
    serde_json::from_str::<FallbackSecrets>(&contents)
        .map(|stored| stored.values)
        .map_err(|error| format!("Резервное хранилище повреждено: {error}"))
}

fn write_fallback(path: &Path, values: &BTreeMap<String, String>) -> Result<(), String> {
    if values.is_empty() {
        return remove_fallback(path);
    }
    let contents = serde_json::to_vec(&FallbackSecrets {
        values: values.clone(),
    })
    .map_err(|error| format!("Не удалось подготовить резервное хранилище: {error}"))?;
    let temporary = path.with_extension(format!("tmp-{}", rand::random::<u64>()));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("Не удалось создать резервное хранилище: {error}"))?;
    file.write_all(&contents)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("Не удалось записать резервное хранилище: {error}"))?;
    drop(file);
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Не удалось заменить резервное хранилище: {error}"))?;
    }
    fs::rename(&temporary, path)
        .map_err(|error| format!("Не удалось активировать резервное хранилище: {error}"))?;
    set_private_permissions(path)?;
    Ok(())
}

fn remove_fallback(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Не удалось удалить резервное хранилище: {error}")),
    }
}

pub fn set_private_permissions(_path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(_path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Не удалось ограничить права {}: {error}", _path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::merge_requested_secrets;
    use std::collections::HashMap;

    #[test]
    fn blank_existing_values_are_preserved_without_round_tripping_to_ui() {
        let current = HashMap::from([
            ("A6API_KEY".to_owned(), "a6-secret".to_owned()),
            ("G2A_API_KEY".to_owned(), "old-grok-secret".to_owned()),
        ]);
        let requested = HashMap::from([
            ("A6API_KEY".to_owned(), String::new()),
            ("G2A_API_KEY".to_owned(), "new-grok-secret".to_owned()),
        ]);
        let (merged, keys) = merge_requested_secrets(&current, requested);
        assert_eq!(
            merged.get("A6API_KEY").map(String::as_str),
            Some("a6-secret")
        );
        assert_eq!(
            merged.get("G2A_API_KEY").map(String::as_str),
            Some("new-grok-secret")
        );
        assert!(keys.contains("A6API_KEY"));
    }

    #[test]
    fn omitted_keys_are_deleted() {
        let current = HashMap::from([("OPENAI_API_KEY".to_owned(), "secret".to_owned())]);
        let (merged, keys) = merge_requested_secrets(&current, HashMap::new());
        assert!(merged.is_empty());
        assert!(keys.is_empty());
    }

    #[test]
    fn blank_unavailable_secret_keeps_non_secret_key_metadata() {
        let requested = HashMap::from([("RDSH_API_KEY".to_owned(), String::new())]);
        let (values, keys) = merge_requested_secrets(&HashMap::new(), requested);
        assert!(values.is_empty());
        assert!(keys.contains("RDSH_API_KEY"));
    }
}
