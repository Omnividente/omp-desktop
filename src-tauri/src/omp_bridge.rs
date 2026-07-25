use crate::{
    models::{
        AppSettings, OmpConfigSaveRequest, OmpConfigSnapshot, OmpCredentialInfo, OmpModelInfo,
        OmpRoleInfo, OmpUpdateInfo,
    },
    settings::{resolve_omp, SettingsState},
    update,
};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, HashMap},
    process::Command,
};
use tauri::{AppHandle, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const KNOWN_ROLES: &[&str] = &[
    "default", "smol", "slow", "plan", "advisor", "task", "designer", "vision", "commit", "tiny",
    "consult",
];

const PROVIDER_ENV_KEYS: &[&str] = &[
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "MISTRAL_API_KEY",
    "ZAI_API_KEY",
    "MINIMAX_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "CURSOR_ACCESS_TOKEN",
    "OPENCODE_API_KEY",
    "KILO_API_KEY",
    "RDSH_API_KEY",
    "A6API_KEY",
];

pub fn load_config_snapshot(
    app: &AppHandle,
    app_settings: &AppSettings,
) -> Result<OmpConfigSnapshot, String> {
    let omp = resolve_omp(app, app_settings);
    if omp.version.is_none() {
        return Err(format!("OMP не найден: {}", omp.executable));
    }

    let raw = run_omp_json(
        &omp.executable,
        &["config", "list", "--json"],
        &app_settings.provider_env,
    )?;
    let (models, usage) = std::thread::scope(|scope| {
        let models = scope.spawn(|| load_models(&omp.executable, &app_settings.provider_env));
        let usage = scope.spawn(|| load_usage(&omp.executable, &app_settings.provider_env));
        (
            models.join().ok().and_then(Result::ok).unwrap_or_default(),
            usage.join().ok().and_then(Result::ok).unwrap_or_default(),
        )
    });
    let roles_map = extract_roles(&raw);
    let roles = build_roles(&roles_map, &models, &usage);
    let credentials = build_credentials(app, app_settings, &models, &usage);

    Ok(OmpConfigSnapshot {
        roles,
        models,
        advisor_enabled: extract_bool(&raw, "advisor.enabled").unwrap_or(false),
        auto_resume: extract_bool(&raw, "autoResume").unwrap_or(false),
        default_thinking_level: extract_string(&raw, "defaultThinkingLevel"),
        provider_env_keys: PROVIDER_ENV_KEYS
            .iter()
            .map(|key| (*key).to_owned())
            .collect(),
        credentials,
        raw,
    })
}

#[derive(Debug, serde::Deserialize)]
struct ModelsYamlFile {
    providers: Option<BTreeMap<String, ModelsYamlProvider>>,
}

#[derive(Debug, serde::Deserialize)]
struct ModelsYamlProvider {
    #[serde(rename = "apiKey")]
    api_key: Option<serde_yml::Value>,
}

fn load_models_yaml(app: &AppHandle) -> BTreeMap<String, ModelsYamlProvider> {
    let path = if let Some(dir) = std::env::var_os("PI_CODING_AGENT_DIR") {
        std::path::PathBuf::from(dir).join("models.yml")
    } else {
        app.path()
            .home_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."))
            .join(".omp")
            .join("agent")
            .join("models.yml")
    };
    let Ok(contents) = std::fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    serde_yml::from_str::<ModelsYamlFile>(&contents)
        .ok()
        .and_then(|file| file.providers)
        .unwrap_or_default()
}

fn build_credentials(
    app: &AppHandle,
    app_settings: &AppSettings,
    models: &[OmpModelInfo],
    usage: &HashMap<String, UsageStatus>,
) -> Vec<OmpCredentialInfo> {
    build_credentials_from_sources(
        load_models_yaml(app),
        &app_settings.provider_env,
        models,
        usage,
        |key| std::env::var_os(key).is_some(),
    )
}

fn build_credentials_from_sources<F>(
    yaml_providers: BTreeMap<String, ModelsYamlProvider>,
    provider_env: &HashMap<String, String>,
    models: &[OmpModelInfo],
    usage: &HashMap<String, UsageStatus>,
    environment_has: F,
) -> Vec<OmpCredentialInfo>
where
    F: Fn(&str) -> bool,
{
    let mut model_counts = BTreeMap::<String, usize>::new();
    for model in models {
        *model_counts.entry(model.provider.clone()).or_default() += 1;
    }

    let mut credentials = BTreeMap::<String, OmpCredentialInfo>::new();
    for (provider, config) in yaml_providers {
        let (source, key_name) = match config.api_key.as_ref().and_then(serde_yml::Value::as_str) {
            Some(resolver) if resolver.starts_with('!') => ("command".to_owned(), None),
            Some(resolver) if provider_env.contains_key(resolver) => {
                ("desktop".to_owned(), Some(resolver.to_owned()))
            }
            Some(resolver) if environment_has(resolver) => {
                ("environment".to_owned(), Some(resolver.to_owned()))
            }
            Some(resolver) => (
                "models".to_owned(),
                looks_like_environment_key(resolver).then(|| resolver.to_owned()),
            ),
            None => ("omp".to_owned(), None),
        };
        let model_count = model_counts.get(&provider).copied().unwrap_or_default();
        credentials.insert(
            provider.clone(),
            credential_info(provider, source, key_name, model_count, usage),
        );
    }

    for provider in model_counts.keys().chain(usage.keys()) {
        if credentials.contains_key(provider) {
            continue;
        }
        let model_count = model_counts.get(provider).copied().unwrap_or_default();
        credentials.insert(
            provider.clone(),
            credential_info(provider.clone(), "omp".to_owned(), None, model_count, usage),
        );
    }

    credentials.into_values().collect()
}

fn credential_info(
    provider: String,
    source: String,
    key_name: Option<String>,
    model_count: usize,
    usage: &HashMap<String, UsageStatus>,
) -> OmpCredentialInfo {
    let usage_status = usage.get(&provider);
    let available = usage_status
        .map(|item| item.available)
        .unwrap_or(model_count > 0);
    let status = usage_status
        .map(|item| item.status.clone())
        .unwrap_or_else(|| {
            if model_count == 0 {
                "missing".to_owned()
            } else if matches!(source.as_str(), "command" | "models") {
                "configured".to_owned()
            } else {
                "ready".to_owned()
            }
        });
    OmpCredentialInfo {
        provider,
        key_name,
        source,
        status,
        available,
        model_count,
    }
}

fn looks_like_environment_key(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

pub fn save_config(
    app: &AppHandle,
    settings: &State<'_, SettingsState>,
    request: OmpConfigSaveRequest,
) -> Result<OmpConfigSnapshot, String> {
    let mut app_settings = settings
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let omp = resolve_omp(app, &app_settings);
    if omp.version.is_none() {
        return Err(format!("OMP не найден: {}", omp.executable));
    }

    let expected_roles = request
        .roles
        .iter()
        .filter(|(_, selector)| !selector.trim().is_empty())
        .map(|(role, selector)| (role.clone(), selector.trim().to_owned()))
        .collect::<BTreeMap<_, _>>();
    for (role, selector) in &expected_roles {
        validate_role_selector(selector)
            .map_err(|error| format!("Некорректная модель для роли `{role}`: {error}"))?;
    }

    if let Some(provider_env) = request.provider_env {
        crate::settings::update_provider_secrets(app, &mut app_settings, provider_env)?;
        crate::settings::save_settings(app, &app_settings)?;
        *settings
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = app_settings.clone();
    }
    let expected_advisor = request.advisor_enabled;
    let expected_auto_resume = request.auto_resume;
    let expected_thinking = request
        .default_thinking_level
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let roles_value = Value::Object(
        expected_roles
            .iter()
            .map(|(role, selector)| (role.clone(), Value::String(selector.clone())))
            .collect::<Map<String, Value>>(),
    );
    set_omp_config(
        &omp.executable,
        "modelRoles",
        &roles_value,
        &app_settings.provider_env,
    )?;

    if let Some(enabled) = expected_advisor {
        set_omp_config(
            &omp.executable,
            "advisor.enabled",
            &Value::Bool(enabled),
            &app_settings.provider_env,
        )?;
    }
    if let Some(enabled) = expected_auto_resume {
        set_omp_config(
            &omp.executable,
            "autoResume",
            &Value::Bool(enabled),
            &app_settings.provider_env,
        )?;
    }
    if let Some(level) = expected_thinking.as_ref() {
        set_omp_config(
            &omp.executable,
            "defaultThinkingLevel",
            &Value::String(level.clone()),
            &app_settings.provider_env,
        )?;
    }

    let snapshot = load_config_snapshot(app, &app_settings)?;
    verify_saved_config(
        &snapshot,
        &expected_roles,
        expected_advisor,
        expected_auto_resume,
        expected_thinking.as_deref(),
    )?;
    Ok(snapshot)
}

fn verify_saved_config(
    snapshot: &OmpConfigSnapshot,
    expected_roles: &BTreeMap<String, String>,
    expected_advisor: Option<bool>,
    expected_auto_resume: Option<bool>,
    expected_thinking: Option<&str>,
) -> Result<(), String> {
    let actual_roles = snapshot
        .roles
        .iter()
        .filter(|role| !role.selector.trim().is_empty())
        .map(|role| (role.role.clone(), role.selector.trim().to_owned()))
        .collect::<BTreeMap<_, _>>();
    if &actual_roles != expected_roles {
        return Err("OMP не применил сохранённые роли моделей".to_owned());
    }
    if expected_advisor.is_some_and(|expected| snapshot.advisor_enabled != expected) {
        return Err("OMP не применил настройку советника".to_owned());
    }
    if expected_auto_resume.is_some_and(|expected| snapshot.auto_resume != expected) {
        return Err("OMP не применил настройку автопродолжения".to_owned());
    }
    if expected_thinking
        .is_some_and(|expected| snapshot.default_thinking_level.as_deref() != Some(expected))
    {
        return Err("OMP не применил уровень рассуждений".to_owned());
    }
    Ok(())
}

pub fn check_update(
    app: &AppHandle,
    settings: &State<'_, SettingsState>,
) -> Result<OmpUpdateInfo, String> {
    let app_settings = settings
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let omp = resolve_omp(app, &app_settings);
    if omp.version.is_none() {
        return Err(format!("OMP не найден: {}", omp.executable));
    }

    let output = run_omp_text(
        &omp.executable,
        &["update", "--check"],
        &app_settings.provider_env,
    )?;
    Ok(update::normalize_update_info(
        &output,
        omp.version.as_deref(),
    ))
}

fn load_models(
    executable: &str,
    env_map: &HashMap<String, String>,
) -> Result<Vec<OmpModelInfo>, String> {
    let value = run_omp_json(executable, &["models", "--json"], env_map)?;
    let models = value
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    Ok(models
        .into_iter()
        .filter_map(|model| {
            let provider = model.get("provider")?.as_str()?.to_owned();
            let id = model.get("id")?.as_str()?.to_owned();
            let selector = model
                .get("selector")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("{provider}/{id}"));
            let name = model
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| id.clone());
            let thinking = model
                .get("thinking")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some(OmpModelInfo {
                provider,
                id,
                selector,
                name,
                available: true,
                status: "ok".to_owned(),
                detail: None,
                thinking,
            })
        })
        .collect())
}

fn load_usage(
    executable: &str,
    env_map: &HashMap<String, String>,
) -> Result<HashMap<String, UsageStatus>, String> {
    let value = run_omp_json(executable, &["usage", "--json"], env_map)?;
    let mut map = HashMap::new();
    let reports = value
        .get("reports")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for report in reports {
        let provider = report
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if provider.is_empty() {
            continue;
        }
        let mut worst = UsageStatus {
            available: true,
            status: "ok".to_owned(),
            detail: None,
        };
        if let Some(limits) = report.get("limits").and_then(Value::as_array) {
            for limit in limits {
                let status = limit.get("status").and_then(Value::as_str).unwrap_or("ok");
                let label = limit
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or("limit");
                let used = limit
                    .pointer("/amount/usedFraction")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                if status == "exhausted" || used >= 0.999 {
                    worst = UsageStatus {
                        available: false,
                        status: "exhausted".to_owned(),
                        detail: Some(format!("{label}: exhausted")),
                    };
                    break;
                }
                if status != "ok" || used >= 0.9 {
                    worst = UsageStatus {
                        available: true,
                        status: "limited".to_owned(),
                        detail: Some(format!("{label}: {used:.0}% used")),
                    };
                }
            }
        }
        map.insert(provider, worst);
    }
    Ok(map)
}

#[derive(Clone)]
struct UsageStatus {
    available: bool,
    status: String,
    detail: Option<String>,
}

fn build_roles(
    roles: &BTreeMap<String, String>,
    models: &[OmpModelInfo],
    usage: &HashMap<String, UsageStatus>,
) -> Vec<OmpRoleInfo> {
    let mut names = KNOWN_ROLES
        .iter()
        .map(|role| (*role).to_owned())
        .collect::<Vec<_>>();
    for role in roles.keys() {
        if !names.iter().any(|existing| existing == role) {
            names.push(role.clone());
        }
    }

    names
        .into_iter()
        .map(|role| {
            let selector = roles.get(&role).cloned().unwrap_or_default();
            if selector.trim().is_empty() {
                return OmpRoleInfo {
                    role,
                    selector,
                    model: None,
                    available: false,
                    status: "unset".to_owned(),
                    detail: Some("Role is not assigned".to_owned()),
                };
            }

            let base = strip_thinking(&selector);
            let matched = models.iter().find(|model| {
                model.selector.eq_ignore_ascii_case(&base)
                    || model.id.eq_ignore_ascii_case(&base)
                    || format!("{}/{}", model.provider, model.id).eq_ignore_ascii_case(&base)
            });

            if let Some(model) = matched {
                let usage_status = usage.get(&model.provider);
                let available = usage_status.map(|item| item.available).unwrap_or(true);
                let status = usage_status
                    .map(|item| item.status.clone())
                    .unwrap_or_else(|| "ok".to_owned());
                let detail = usage_status.and_then(|item| item.detail.clone());
                let mut info = model.clone();
                info.available = available;
                info.status = status.clone();
                info.detail = detail.clone();
                OmpRoleInfo {
                    role,
                    selector,
                    model: Some(info),
                    available,
                    status,
                    detail,
                }
            } else {
                OmpRoleInfo {
                    role,
                    selector: selector.clone(),
                    model: None,
                    available: false,
                    status: "missing".to_owned(),
                    detail: Some(format!("Model not found in catalog: {selector}")),
                }
            }
        })
        .collect()
}

fn extract_roles(raw: &Value) -> BTreeMap<String, String> {
    let mut roles = BTreeMap::new();
    if let Some(map) = raw
        .pointer("/modelRoles/value")
        .and_then(Value::as_object)
        .or_else(|| raw.get("modelRoles").and_then(Value::as_object))
    {
        for (role, value) in map {
            if let Some(selector) = value.as_str() {
                roles.insert(role.clone(), selector.to_owned());
            }
        }
    }
    roles
}

fn extract_bool(raw: &Value, key: &str) -> Option<bool> {
    raw.pointer(&format!("/{key}/value"))
        .and_then(Value::as_bool)
        .or_else(|| raw.get(key).and_then(Value::as_bool))
}

fn extract_string(raw: &Value, key: &str) -> Option<String> {
    raw.pointer(&format!("/{key}/value"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| raw.get(key).and_then(Value::as_str).map(str::to_owned))
}

fn strip_thinking(selector: &str) -> String {
    match selector.rsplit_once(':') {
        Some((base, "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto")) => {
            base.to_owned()
        }
        _ => selector.to_owned(),
    }
}

fn validate_role_selector(selector: &str) -> Result<(), String> {
    if selector.is_empty() || selector.len() > 512 {
        return Err("selector модели пуст или слишком длинный".to_owned());
    }
    if selector
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err("selector модели содержит пробельные или управляющие символы".to_owned());
    }

    let base = strip_thinking(selector);
    if base == "*" {
        return Ok(());
    }
    if let Some(alias) = base.strip_prefix('@') {
        if valid_role_alias(alias) {
            return Ok(());
        }
        return Err("некорректный alias роли модели".to_owned());
    }
    if let Some((provider, model)) = base.split_once('/') {
        if valid_selector_segment(provider)
            && !model.is_empty()
            && model.split('/').all(valid_selector_segment)
        {
            return Ok(());
        }
        return Err("selector модели должен иметь формат provider/model".to_owned());
    }
    if valid_selector_segment(&base) {
        return Ok(());
    }
    Err("некорректный canonical selector модели".to_owned())
}

fn valid_role_alias(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

fn valid_selector_segment(value: &str) -> bool {
    let Some(first) = value.chars().next() else {
        return false;
    };
    let Some(last) = value.chars().next_back() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && last.is_ascii_alphanumeric()
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '-' | '_' | '.' | '+' | ':' | '@')
        })
}

fn set_omp_config(
    executable: &str,
    key: &str,
    value: &Value,
    env_map: &HashMap<String, String>,
) -> Result<(), String> {
    let rendered = match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    run_omp_text(executable, &["config", "set", key, &rendered], env_map)
        .map_err(|error| format!("Не удалось сохранить `{key}`: {error}"))?;
    Ok(())
}

fn run_omp_json(
    executable: &str,
    args: &[&str],
    env_map: &HashMap<String, String>,
) -> Result<Value, String> {
    let text = run_omp_text(executable, args, env_map)?;
    serde_json::from_str(&text).map_err(|error| {
        format!(
            "OMP вернул не-JSON для `{}`: {error}\n{}",
            args.join(" "),
            text.chars().take(400).collect::<String>()
        )
    })
}

fn run_omp_text(
    executable: &str,
    args: &[&str],
    env_map: &HashMap<String, String>,
) -> Result<String, String> {
    let mut command = Command::new(executable);
    command.args(args);
    for (key, value) in env_map {
        command.env(key, value);
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .output()
        .map_err(|error| format!("Не удалось запустить OMP ({executable}): {error}"))?;
    interpret_omp_output(
        output.status.success(),
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn interpret_omp_output(
    success: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
) -> Result<String, String> {
    if !success {
        let detail = [stderr.trim(), stdout.trim()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        let code = exit_code
            .map(|value| value.to_string())
            .unwrap_or_else(|| "неизвестный".to_owned());
        return Err(if detail.is_empty() {
            format!("OMP завершил команду с кодом {code}")
        } else {
            format!("OMP завершил команду с кодом {code}: {detail}")
        });
    }
    if !stdout.trim().is_empty() {
        Ok(stdout)
    } else {
        Ok(stderr)
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn model(provider: &str, id: &str) -> OmpModelInfo {
        OmpModelInfo {
            provider: provider.to_owned(),
            id: id.to_owned(),
            selector: format!("{provider}/{id}"),
            name: id.to_owned(),
            available: true,
            status: "ok".to_owned(),
            detail: None,
            thinking: Vec::new(),
        }
    }

    #[test]
    fn credentials_use_sources_without_exposing_secret_values() {
        let mut provider_env = HashMap::new();
        provider_env.insert("A6API_KEY".to_owned(), "secret_token_12345".to_owned());
        let yaml = serde_yml::from_str::<ModelsYamlFile>(
            r#"
providers:
  a6api:
    apiKey: A6API_KEY
  grok2api:
    apiKey: G2A_API_KEY
  rdsh:
    apiKey: ANTHROPIC_API_KEY
  codex-lb:
    apiKey: "!resolve-codex-token"
"#,
        )
        .expect("credential fixture should parse")
        .providers
        .expect("credential fixture should contain providers");
        let models = vec![
            model("a6api", "primary"),
            model("grok2api", "build"),
            model("rdsh", "advisor"),
            model("codex-lb", "fallback"),
        ];
        let credentials =
            build_credentials_from_sources(yaml, &provider_env, &models, &HashMap::new(), |key| {
                key == "G2A_API_KEY"
            });
        let get = |provider: &str| {
            credentials
                .iter()
                .find(|item| item.provider == provider)
                .expect("provider should be present")
        };

        assert_eq!(get("a6api").source, "desktop");
        assert_eq!(get("a6api").key_name.as_deref(), Some("A6API_KEY"));
        assert_eq!(get("grok2api").source, "environment");
        assert_eq!(get("rdsh").source, "models");
        assert_eq!(get("rdsh").status, "configured");
        assert_eq!(get("codex-lb").source, "command");
        assert!(!format!("{credentials:?}").contains("secret_token_12345"));
    }

    #[test]
    fn nonzero_omp_output_is_always_an_error() {
        let result = interpret_omp_output(
            false,
            Some(2),
            "partial stdout".to_owned(),
            "config rejected".to_owned(),
        );
        let error = result.expect_err("nonzero status must not be accepted");
        assert!(error.contains("config rejected"));
        assert!(error.contains("partial stdout"));
    }

    #[test]
    fn successful_omp_output_prefers_stdout() {
        assert_eq!(
            interpret_omp_output(
                true,
                Some(0),
                "configured\n".to_owned(),
                "warning".to_owned(),
            )
            .expect("successful command should return output"),
            "configured\n"
        );
    }

    #[test]
    fn role_selector_validation_accepts_supported_omp_forms() {
        for selector in [
            "provider/model",
            "provider/model:high",
            "ollama/qwen3:30b",
            "gpt-5.3-codex",
            "@slow:xhigh",
            "*",
        ] {
            assert!(validate_role_selector(selector).is_ok(), "{selector}");
        }
    }

    #[test]
    fn role_selector_validation_rejects_malformed_values() {
        for selector in [
            "provider/",
            "/model",
            "provider//model",
            "provider/model with space",
            "@",
            "provider/model::high",
            "model?query",
        ] {
            assert!(validate_role_selector(selector).is_err(), "{selector}");
        }
    }
}
