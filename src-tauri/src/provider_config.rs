use crate::{models::OmpCustomProviderRequest, sessions::atomic_write_private_file};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use url::Url;

const MAX_PROVIDER_ID_BYTES: usize = 64;
const MAX_BASE_URL_BYTES: usize = 2_048;
const MAX_API_KEY_BYTES: usize = 64 * 1024;
const CUSTOM_PROVIDER_APIS: &[&str] = &["openai-completions", "openai-responses"];

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ModelsYamlFile {
    #[serde(default)]
    providers: BTreeMap<String, Value>,
}

struct NormalizedProvider {
    provider: String,
    base_url: String,
    api: String,
    api_key: String,
    key_name: String,
}

pub struct ProviderFileMutation {
    path: PathBuf,
    original: Option<Vec<u8>>,
    updated: Vec<u8>,
    changed: bool,
    pub secret_values: HashMap<String, String>,
    pub removed_secret_keys: BTreeSet<String>,
    pub added: BTreeMap<String, (String, String)>,
    pub removed: BTreeSet<String>,
}

pub fn models_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("PI_CODING_AGENT_DIR") {
        return Ok(PathBuf::from(dir).join("models.yml"));
    }
    app.path()
        .home_dir()
        .map(|home| home.join(".omp").join("agent").join("models.yml"))
        .map_err(|error| format!("Не удалось определить путь models.yml: {error}"))
}

pub fn prepare_provider_file_mutation(
    path: PathBuf,
    upserts: Vec<OmpCustomProviderRequest>,
    removals: Vec<String>,
) -> Result<Option<ProviderFileMutation>, String> {
    if upserts.is_empty() && removals.is_empty() {
        return Ok(None);
    }

    let original = read_optional(&path)?;
    let mut document = parse_models_file(original.as_deref())?;
    let mut normalized_upserts = BTreeMap::new();
    for request in upserts {
        let normalized = normalize_provider(request)?;
        if normalized_upserts
            .insert(normalized.provider.clone(), normalized)
            .is_some()
        {
            return Err("Один custom provider добавлен несколько раз".to_owned());
        }
    }

    let mut normalized_removals = BTreeSet::new();
    for provider in removals {
        let provider = normalize_provider_id(&provider)?;
        if !normalized_removals.insert(provider) {
            return Err("Один custom provider удаляется несколько раз".to_owned());
        }
    }
    if normalized_upserts
        .keys()
        .any(|provider| normalized_removals.contains(provider))
    {
        return Err("Нельзя одновременно добавить и удалить один provider".to_owned());
    }

    let mut removed_secret_keys = BTreeSet::new();
    for provider in &normalized_removals {
        let removed = document.providers.remove(provider).ok_or_else(|| {
            format!("Provider `{provider}` отсутствует в models.yml; обновите настройки")
        })?;
        let generated_key = provider_secret_key(provider);
        if removed
            .as_object()
            .and_then(|value| value.get("apiKey"))
            .and_then(Value::as_str)
            == Some(generated_key.as_str())
        {
            removed_secret_keys.insert(generated_key);
        }
    }

    let mut secret_values = HashMap::new();
    let mut added = BTreeMap::new();
    for (provider, normalized) in normalized_upserts {
        if document.providers.contains_key(&provider) {
            return Err(format!(
                "Provider `{provider}` уже существует в models.yml; сначала удалите существующую конфигурацию"
            ));
        }
        document.providers.insert(
            provider.clone(),
            json!({
                "baseUrl": normalized.base_url,
                "api": normalized.api,
                "apiKey": normalized.key_name,
                "authHeader": true,
                "discovery": {
                    "type": "openai-models-list",
                    "injectV1": false
                }
            }),
        );
        secret_values.insert(normalized.key_name, normalized.api_key);
        added.insert(provider, (normalized.base_url, normalized.api));
    }

    let mut updated = serde_saphyr::to_string(&document)
        .map_err(|_| "Не удалось сериализовать models.yml".to_owned())?
        .into_bytes();
    if !updated.ends_with(b"\n") {
        updated.push(b'\n');
    }
    let changed = original.as_deref() != Some(updated.as_slice());

    Ok(Some(ProviderFileMutation {
        path,
        original,
        updated,
        changed,
        secret_values,
        removed_secret_keys,
        added,
        removed: normalized_removals,
    }))
}

impl ProviderFileMutation {
    pub fn apply(&self) -> Result<(), String> {
        if !self.changed {
            return Ok(());
        }
        if read_optional(&self.path)? != self.original {
            return Err("models.yml изменился во время сохранения; обновите настройки".to_owned());
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Не удалось подготовить models.yml: {error}"))?;
        }
        atomic_write_private_file(&self.path, &self.updated)
            .map_err(|error| format!("Не удалось сохранить models.yml: {error}"))
    }

    pub fn rollback(&self) -> Result<(), String> {
        if !self.changed {
            return Ok(());
        }
        if read_optional(&self.path)?.as_deref() != Some(self.updated.as_slice()) {
            return Err(
                "models.yml изменился после сохранения и не был перезаписан откатом".to_owned(),
            );
        }
        match &self.original {
            Some(contents) => atomic_write_private_file(&self.path, contents)
                .map_err(|error| format!("Не удалось восстановить models.yml: {error}")),
            None => match fs::remove_file(&self.path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
                Err(error) => Err(format!("Не удалось удалить созданный models.yml: {error}")),
            },
        }
    }
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Не удалось прочитать models.yml: {error}")),
    }
}

fn parse_models_file(contents: Option<&[u8]>) -> Result<ModelsYamlFile, String> {
    let Some(contents) = contents.filter(|contents| !contents.is_empty()) else {
        return Ok(ModelsYamlFile::default());
    };
    let text = std::str::from_utf8(contents)
        .map_err(|_| "models.yml должен быть сохранён в UTF-8".to_owned())?;
    serde_saphyr::from_str(text)
        .map_err(|_| "models.yml содержит некорректную YAML-структуру".to_owned())
}

fn normalize_provider(request: OmpCustomProviderRequest) -> Result<NormalizedProvider, String> {
    let provider = normalize_provider_id(&request.provider)?;
    let base_url = normalize_base_url(&request.base_url)?;
    let api = request.api.trim().to_owned();
    if !CUSTOM_PROVIDER_APIS.contains(&api.as_str()) {
        return Err(
            "Custom provider поддерживает OpenAI Chat Completions или Responses".to_owned(),
        );
    }
    let api_key = request.api_key.trim().to_owned();
    if api_key.is_empty()
        || api_key.len() > MAX_API_KEY_BYTES
        || api_key.chars().any(char::is_control)
    {
        return Err("API key пуст, слишком длинный или содержит управляющие символы".to_owned());
    }
    let key_name = provider_secret_key(&provider);
    Ok(NormalizedProvider {
        provider,
        base_url,
        api,
        api_key,
        key_name,
    })
}

pub fn normalize_provider_id(value: &str) -> Result<String, String> {
    let provider = value.trim();
    let valid = !provider.is_empty()
        && provider.len() <= MAX_PROVIDER_ID_BYTES
        && provider
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && provider
            .bytes()
            .next_back()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && provider.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.')
        });
    if !valid {
        return Err(
            "Provider ID должен содержать 1–64 строчные латинские буквы, цифры, `.`, `_` или `-`"
                .to_owned(),
        );
    }
    Ok(provider.to_owned())
}

fn normalize_base_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_BASE_URL_BYTES {
        return Err("API address пуст или слишком длинный".to_owned());
    }
    let parsed =
        Url::parse(value).map_err(|_| "API address должен быть абсолютным URL".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "API address должен быть HTTP(S) URL без credentials, query и fragment".to_owned(),
        );
    }
    Ok(parsed.as_str().trim_end_matches('/').to_owned())
}

pub fn public_base_url(value: Option<&str>) -> Option<String> {
    value.and_then(|value| normalize_base_url(value).ok())
}

pub fn public_api(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte == b'-')
        })
        .map(str::to_owned)
}
pub fn is_desktop_managed_provider(provider: &str, api_key: Option<&str>) -> bool {
    api_key.is_some_and(|api_key| api_key == provider_secret_key(provider))
}

fn provider_secret_key(provider: &str) -> String {
    let mut key = String::with_capacity(29 + provider.len() * 2);
    key.push_str("OMP_DESKTOP_PROVIDER_");
    for byte in provider.bytes() {
        use std::fmt::Write as _;
        write!(&mut key, "{byte:02X}").expect("writing to a String cannot fail");
    }
    key.push_str("_API_KEY");
    key
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_models_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        std::env::temp_dir()
            .join(format!("omp-desktop-{label}-{nonce}"))
            .join("models.yml")
    }

    fn request(provider: &str, secret: &str) -> OmpCustomProviderRequest {
        OmpCustomProviderRequest {
            provider: provider.to_owned(),
            base_url: "https://gateway.example.test/v1/".to_owned(),
            api: "openai-completions".to_owned(),
            api_key: secret.to_owned(),
        }
    }

    #[test]
    fn custom_provider_uses_discovery_and_never_writes_secret() {
        let path = temp_models_path("provider-add");
        let secret = "private-provider-secret";
        let mutation = prepare_provider_file_mutation(
            path.clone(),
            vec![request("team-gateway", secret)],
            Vec::new(),
        )
        .expect("provider mutation should be prepared")
        .expect("provider mutation should exist");

        mutation.apply().expect("provider file should be written");
        let contents = fs::read_to_string(&path).expect("provider file should be readable");
        assert!(!contents.contains(secret));
        let parsed =
            parse_models_file(Some(contents.as_bytes())).expect("written YAML should parse");
        let provider = parsed
            .providers
            .get("team-gateway")
            .and_then(Value::as_object)
            .expect("custom provider should be present");
        assert_eq!(
            provider.get("baseUrl").and_then(Value::as_str),
            Some("https://gateway.example.test/v1")
        );
        assert_eq!(
            provider
                .get("discovery")
                .and_then(Value::as_object)
                .and_then(|discovery| discovery.get("type"))
                .and_then(Value::as_str),
            Some("openai-models-list")
        );
        assert_eq!(
            mutation.secret_values.values().next().map(String::as_str),
            Some(secret)
        );

        mutation.rollback().expect("created file should roll back");
        assert!(!path.exists());
    }

    #[test]
    fn removing_provider_preserves_unrelated_yaml_semantics() {
        let path = temp_models_path("provider-remove");
        fs::create_dir_all(path.parent().expect("temp path should have parent"))
            .expect("temp directory should be created");
        let owned_key = provider_secret_key("remove-me");
        let fixture = format!(
            r#"providers:
  keep:
    baseUrl: https://keep.example.test/v1
    api: openai-responses
    apiKey: KEEP_KEY
    headers:
      X-Team: alpha
  remove-me:
    baseUrl: https://remove.example.test/v1
    api: openai-completions
    apiKey: {owned_key}
"#
        );
        fs::write(&path, fixture).expect("fixture should be written");
        let original = fs::read(&path).expect("fixture should be readable");

        let mutation =
            prepare_provider_file_mutation(path.clone(), Vec::new(), vec!["remove-me".to_owned()])
                .expect("removal should be prepared")
                .expect("removal should exist");
        assert!(mutation.removed_secret_keys.contains(&owned_key));
        mutation.apply().expect("removal should be written");
        let parsed = parse_models_file(Some(
            &fs::read(&path).expect("updated file should be readable"),
        ))
        .expect("updated YAML should parse");
        assert!(parsed.providers.contains_key("keep"));
        assert!(!parsed.providers.contains_key("remove-me"));
        assert_eq!(
            parsed.providers["keep"].pointer("/headers/X-Team"),
            Some(&Value::String("alpha".to_owned()))
        );

        mutation.rollback().expect("existing file should roll back");
        assert_eq!(
            fs::read(&path).expect("rolled back file should exist"),
            original
        );
        fs::remove_dir_all(path.parent().expect("temp path should have parent"))
            .expect("temp directory should be removed");
    }

    #[test]
    fn provider_validation_rejects_credentials_in_url() {
        let mut invalid = request("unsafe-provider", "secret");
        invalid.base_url = "https://user:password@example.test/v1".to_owned();
        let error = prepare_provider_file_mutation(
            temp_models_path("provider-invalid"),
            vec![invalid],
            Vec::new(),
        )
        .err()
        .expect("credentials in URL should be rejected");
        assert!(!error.contains("password"));
        assert_eq!(
            public_base_url(Some("https://user:password@example.test/v1")),
            None
        );
    }
}
