use crate::{
    diagnostics,
    models::{
        AppSettings, BootstrapPayload, OmpConfigSaveRequest, OmpConfigSnapshot, OmpConfigWarning,
        OmpCredentialInfo, OmpModelInfo, OmpRoleInfo, OmpUpdateInfo,
    },
    omp_command::{run_omp_command, OmpOperation},
    settings::{resolve_omp, SettingsTransaction},
    update,
};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    env, fs,
    path::PathBuf,
};
use tauri::{AppHandle, Manager};

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

const PROXY_MODE_SETTING: &str = "providers.proxyMode";

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
        OmpOperation::Config,
    )?;
    let (models_result, usage_result) = std::thread::scope(|scope| {
        let models = scope.spawn(|| load_models(&omp.executable, &app_settings.provider_env));
        let usage = scope.spawn(|| load_usage(&omp.executable, &app_settings.provider_env));
        (models.join(), usage.join())
    });
    let mut warnings = Vec::new();
    let mut models =
        snapshot_value_or_warning(models_result, "models", "omp_models_failed", &mut warnings);
    let usage = snapshot_value_or_warning(usage_result, "usage", "omp_usage_failed", &mut warnings);
    apply_usage_to_models(&mut models, &usage);
    let roles_map = extract_roles(&raw);
    let roles = build_roles(&roles_map, &models);
    let credentials = build_credentials(app, app_settings, &models, &usage);

    Ok(OmpConfigSnapshot {
        roles,
        models,
        advisor_enabled: extract_bool(&raw, "advisor.enabled").unwrap_or(false),
        auto_resume: extract_bool(&raw, "autoResume").unwrap_or(false),
        default_thinking_level: extract_string(&raw, "defaultThinkingLevel"),
        model_fallback_enabled: extract_bool(&raw, "retry.modelFallback").unwrap_or(true),
        fallback_chains: extract_string_lists(&raw, "retry.fallbackChains"),
        proxy_providers: extract_proxy_providers(&raw, app),
        provider_env_keys: PROVIDER_ENV_KEYS
            .iter()
            .map(|key| (*key).to_owned())
            .collect(),
        credentials,
        warnings,
    })
}

fn snapshot_value_or_warning<T: Default>(
    result: std::thread::Result<Result<T, String>>,
    source: &str,
    code: &str,
    warnings: &mut Vec<OmpConfigWarning>,
) -> T {
    match result {
        Ok(Ok(value)) => value,
        Ok(Err(message)) => {
            diagnostics::warn(source, &message);
            warnings.push(OmpConfigWarning {
                source: source.to_owned(),
                code: code.to_owned(),
                message,
            });
            T::default()
        }
        Err(_) => {
            diagnostics::warn(source, "фоновая операция завершилась паникой");
            warnings.push(OmpConfigWarning {
                source: source.to_owned(),
                code: format!("{code}_panic"),
                message: format!("OMP {source}: фоновая операция завершилась паникой"),
            });
            T::default()
        }
    }
}

#[derive(Debug, serde::Deserialize)]
struct ModelsYamlFile {
    providers: Option<BTreeMap<String, ModelsYamlProvider>>,
}

#[derive(Debug, serde::Deserialize)]
struct ModelsYamlProvider {
    #[serde(rename = "apiKey")]
    api_key: Option<serde_json::Value>,
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
    serde_saphyr::from_str::<ModelsYamlFile>(&contents)
        .ok()
        .and_then(|file| file.providers)
        .unwrap_or_default()
}

fn build_credentials(
    app: &AppHandle,
    app_settings: &AppSettings,
    models: &[OmpModelInfo],
    usage: &UsageMap,
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
    usage: &UsageMap,
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
        let (source, key_name) = match config.api_key.as_ref().and_then(serde_json::Value::as_str) {
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
    usage: &UsageMap,
) -> OmpCredentialInfo {
    let usage_status = usage.get(&provider).map(summarize_provider_usage);
    let available = usage_status
        .as_ref()
        .map(|item| item.available)
        .unwrap_or(model_count > 0);
    let status = usage_status
        .as_ref()
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

pub(crate) struct OmpConfigSaveResult {
    pub snapshot: OmpConfigSnapshot,
    pub bootstrap: BootstrapPayload,
}

pub fn save_config(
    app: &AppHandle,
    transaction: &mut SettingsTransaction<'_>,
    request: OmpConfigSaveRequest,
) -> Result<OmpConfigSaveResult, String> {
    let previous_settings = transaction.previous().clone();
    let mut app_settings = transaction.candidate().clone();
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
    let expected_advisor = request.advisor_enabled;
    let expected_auto_resume = request.auto_resume;
    let expected_thinking = request
        .default_thinking_level
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let expected_model_fallback = request.model_fallback_enabled;
    let expected_fallback_chains = request
        .fallback_chains
        .map(normalize_fallback_chains)
        .transpose()?;
    let expected_proxy_providers = request
        .proxy_providers
        .map(normalize_proxy_providers)
        .transpose()?;
    let previous_config = load_config_snapshot(app, &app_settings)?;

    let credentials_changed = if let Some(provider_env) = request.provider_env {
        crate::settings::update_provider_secrets(app, &mut app_settings, provider_env)?;
        true
    } else {
        false
    };
    let roles_value = Value::Object(
        expected_roles
            .iter()
            .map(|(role, selector)| (role.clone(), Value::String(selector.clone())))
            .collect::<Map<String, Value>>(),
    );
    let mut settings_save_attempted = false;
    let transaction_result = (|| {
        set_omp_config(
            &omp.executable,
            "modelRoles",
            &roles_value,
            &app_settings.provider_env,
            app,
        )?;
        if let Some(chains) = expected_fallback_chains.as_ref() {
            let value = Value::Object(
                chains
                    .iter()
                    .map(|(key, selectors)| {
                        (
                            key.clone(),
                            Value::Array(selectors.iter().cloned().map(Value::String).collect()),
                        )
                    })
                    .collect(),
            );
            set_omp_config(
                &omp.executable,
                "retry.fallbackChains",
                &value,
                &app_settings.provider_env,
                app,
            )?;
        }
        if let Some(providers) = expected_proxy_providers.as_ref() {
            set_omp_config(
                &omp.executable,
                "providers.proxyMode",
                &serde_json::to_value(providers).unwrap_or(Value::Array(Vec::new())),
                &app_settings.provider_env,
                app,
            )?;
        }
        if let Some(enabled) = expected_model_fallback {
            set_omp_config(
                &omp.executable,
                "retry.modelFallback",
                &Value::Bool(enabled),
                &app_settings.provider_env,
                app,
            )?;
        }
        if let Some(enabled) = expected_advisor {
            set_omp_config(
                &omp.executable,
                "advisor.enabled",
                &Value::Bool(enabled),
                &app_settings.provider_env,
                app,
            )?;
        }
        if let Some(enabled) = expected_auto_resume {
            set_omp_config(
                &omp.executable,
                "autoResume",
                &Value::Bool(enabled),
                &app_settings.provider_env,
                app,
            )?;
        }
        if let Some(level) = expected_thinking.as_ref() {
            set_omp_config(
                &omp.executable,
                "defaultThinkingLevel",
                &Value::String(level.clone()),
                &app_settings.provider_env,
                app,
            )?;
        }
        let snapshot = load_config_snapshot(app, &app_settings)?;
        verify_saved_config(
            &snapshot,
            SavedConfigExpectation {
                roles: &expected_roles,
                advisor: expected_advisor,
                auto_resume: expected_auto_resume,
                thinking: expected_thinking.as_deref(),
                model_fallback: expected_model_fallback,
                fallback_chains: expected_fallback_chains.as_ref(),
                proxy_providers: expected_proxy_providers.as_deref(),
            },
        )?;
        let bootstrap = crate::sessions::build_bootstrap(app, &app_settings)?;
        settings_save_attempted = true;
        crate::settings::save_settings(app, &app_settings)?;
        Ok(OmpConfigSaveResult {
            snapshot,
            bootstrap,
        })
    })();

    let result = crate::settings::resolve_transaction(transaction_result, || {
        let mut rollback_errors = rollback_omp_config(
            app,
            &omp.executable,
            &app_settings.provider_env,
            &previous_config,
            expected_advisor.is_some(),
            expected_auto_resume.is_some(),
            expected_thinking.is_some(),
            expected_model_fallback.is_some(),
            expected_fallback_chains.is_some(),
            expected_proxy_providers.is_some(),
        );
        if credentials_changed {
            if let Err(rollback_error) =
                crate::settings::restore_provider_secrets(app, &app_settings, &previous_settings)
            {
                rollback_errors.push(rollback_error);
            }
        }
        if settings_save_attempted {
            if let Err(rollback_error) = crate::settings::save_settings(app, &previous_settings) {
                rollback_errors.push(rollback_error);
            }
        }
        rollback_errors
    })?;
    *transaction.candidate_mut() = app_settings;
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
fn rollback_omp_config(
    app: &AppHandle,
    executable: &str,
    provider_env: &HashMap<String, String>,
    previous: &OmpConfigSnapshot,
    advisor_touched: bool,
    auto_resume_touched: bool,
    thinking_touched: bool,
    model_fallback_touched: bool,
    fallback_chains_touched: bool,
    proxy_providers_touched: bool,
) -> Vec<String> {
    let mut errors = Vec::new();
    let roles = Value::Object(
        previous
            .roles
            .iter()
            .filter(|role| !role.selector.trim().is_empty())
            .map(|role| (role.role.clone(), Value::String(role.selector.clone())))
            .collect(),
    );
    let mut restore = |key: &str, value: Value| {
        if let Err(error) = set_omp_config(executable, key, &value, provider_env, app) {
            errors.push(format!("{key}: {error}"));
        }
    };
    restore("modelRoles", roles);
    if fallback_chains_touched {
        restore(
            "retry.fallbackChains",
            serde_json::to_value(&previous.fallback_chains).unwrap_or(Value::Object(Map::new())),
        );
    }
    if proxy_providers_touched {
        restore(
            "providers.proxyMode",
            serde_json::to_value(&previous.proxy_providers).unwrap_or(Value::Array(Vec::new())),
        );
    }
    if model_fallback_touched {
        restore(
            "retry.modelFallback",
            Value::Bool(previous.model_fallback_enabled),
        );
    }
    if advisor_touched {
        restore("advisor.enabled", Value::Bool(previous.advisor_enabled));
    }
    if auto_resume_touched {
        restore("autoResume", Value::Bool(previous.auto_resume));
    }
    if thinking_touched {
        restore(
            "defaultThinkingLevel",
            previous
                .default_thinking_level
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
    }
    errors
}

struct SavedConfigExpectation<'a> {
    roles: &'a BTreeMap<String, String>,
    advisor: Option<bool>,
    auto_resume: Option<bool>,
    thinking: Option<&'a str>,
    model_fallback: Option<bool>,
    fallback_chains: Option<&'a BTreeMap<String, Vec<String>>>,
    proxy_providers: Option<&'a [String]>,
}

fn verify_saved_config(
    snapshot: &OmpConfigSnapshot,
    expected: SavedConfigExpectation<'_>,
) -> Result<(), String> {
    let actual_roles = snapshot
        .roles
        .iter()
        .filter(|role| !role.selector.trim().is_empty())
        .map(|role| (role.role.clone(), role.selector.trim().to_owned()))
        .collect::<BTreeMap<_, _>>();
    if &actual_roles != expected.roles {
        return Err("OMP не применил сохранённые роли моделей".to_owned());
    }
    if expected
        .advisor
        .is_some_and(|value| snapshot.advisor_enabled != value)
    {
        return Err("OMP не применил настройку советника".to_owned());
    }
    if expected
        .auto_resume
        .is_some_and(|value| snapshot.auto_resume != value)
    {
        return Err("OMP не применил настройку автопродолжения".to_owned());
    }
    if expected
        .thinking
        .is_some_and(|value| snapshot.default_thinking_level.as_deref() != Some(value))
    {
        return Err("OMP не применил уровень рассуждений".to_owned());
    }
    if expected
        .model_fallback
        .is_some_and(|value| snapshot.model_fallback_enabled != value)
    {
        return Err("OMP не применил включение резервных моделей".to_owned());
    }
    if expected
        .fallback_chains
        .is_some_and(|value| &snapshot.fallback_chains != value)
    {
        return Err("OMP не применил цепочки резервных моделей".to_owned());
    }
    if expected
        .proxy_providers
        .is_some_and(|value| snapshot.proxy_providers != value)
    {
        return Err("OMP не применил proxy-режим провайдеров".to_owned());
    }
    Ok(())
}

pub fn check_update(app: &AppHandle, app_settings: &AppSettings) -> Result<OmpUpdateInfo, String> {
    let omp = resolve_omp(app, app_settings);
    if omp.version.is_none() {
        return Err(format!("OMP не найден: {}", omp.executable));
    }

    let output = run_omp_text(
        &omp.executable,
        &["update", "--check"],
        &app_settings.provider_env,
        OmpOperation::Update,
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
    let value = run_omp_json(
        executable,
        &["models", "--json"],
        env_map,
        OmpOperation::Models,
    )?;
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

fn load_usage(executable: &str, env_map: &HashMap<String, String>) -> Result<UsageMap, String> {
    let value = run_omp_json(
        executable,
        &["usage", "--json"],
        env_map,
        OmpOperation::Usage,
    )?;
    Ok(parse_usage_reports(&value))
}

type UsageMap = HashMap<String, ProviderUsage>;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum ModelFamily {
    Google,
    Anthropic,
    OpenAi,
    General,
}

impl ModelFamily {
    fn label(self) -> &'static str {
        match self {
            Self::Google => "Google",
            Self::Anthropic => "Anthropic",
            Self::OpenAi => "OpenAI",
            Self::General => "Provider",
        }
    }
}

#[derive(Clone, Default)]
struct ProviderUsage {
    families: HashMap<ModelFamily, UsageStatus>,
}

#[derive(Clone, Debug)]
struct UsageStatus {
    available: bool,
    status: String,
    detail: Option<String>,
}

fn parse_usage_reports(value: &Value) -> UsageMap {
    let mut accounts = HashMap::<String, HashMap<ModelFamily, Vec<UsageStatus>>>::new();
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
            .trim();
        if provider.is_empty() {
            continue;
        }

        let mut account = HashMap::<ModelFamily, UsageStatus>::new();
        if let Some(limits) = report.get("limits").and_then(Value::as_array) {
            for limit in limits {
                let family = usage_family(limit);
                let candidate = usage_status_from_limit(limit);
                account
                    .entry(family)
                    .and_modify(|current| {
                        if usage_severity(&candidate) > usage_severity(current) {
                            *current = candidate.clone();
                        }
                    })
                    .or_insert(candidate);
            }
        }

        let provider_accounts = accounts.entry(provider.to_owned()).or_default();
        for (family, status) in account {
            provider_accounts.entry(family).or_default().push(status);
        }
    }

    accounts
        .into_iter()
        .map(|(provider, families)| {
            let families = families
                .into_iter()
                .map(|(family, statuses)| (family, aggregate_account_statuses(family, &statuses)))
                .collect();
            (provider, ProviderUsage { families })
        })
        .collect()
}

fn usage_family(limit: &Value) -> ModelFamily {
    let label = limit
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let id = limit.get("id").and_then(Value::as_str).unwrap_or_default();
    let value = format!("{label} {id}").to_ascii_lowercase();
    if value.contains("anthropic") || value.contains("claude") {
        ModelFamily::Anthropic
    } else if value.contains("openai") || value.contains("gpt") {
        ModelFamily::OpenAi
    } else if value.contains("google") || value.contains("gemini") {
        ModelFamily::Google
    } else {
        ModelFamily::General
    }
}

fn usage_status_from_limit(limit: &Value) -> UsageStatus {
    let raw_status = limit.get("status").and_then(Value::as_str).unwrap_or("ok");
    let label = limit
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or("Usage");
    let used = limit
        .pointer("/amount/usedFraction")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .clamp(0.0, 1.0);
    if raw_status.eq_ignore_ascii_case("exhausted") || used >= 0.999 {
        UsageStatus {
            available: false,
            status: "exhausted".to_owned(),
            detail: Some(format!("{label}: 100%")),
        }
    } else if !raw_status.eq_ignore_ascii_case("ok") || used >= 0.9 {
        UsageStatus {
            available: true,
            status: "limited".to_owned(),
            detail: Some(format!("{label}: {:.0}%", used * 100.0)),
        }
    } else {
        UsageStatus {
            available: true,
            status: "ok".to_owned(),
            detail: Some(format!("{label}: {:.0}%", used * 100.0)),
        }
    }
}

fn usage_severity(status: &UsageStatus) -> u8 {
    if !status.available || status.status == "exhausted" {
        2
    } else if status.status != "ok" {
        1
    } else {
        0
    }
}

fn aggregate_account_statuses(family: ModelFamily, statuses: &[UsageStatus]) -> UsageStatus {
    let available = statuses.iter().filter(|status| status.available).count();
    if available == 0 {
        return UsageStatus {
            available: false,
            status: "exhausted".to_owned(),
            detail: Some(format!("{}: 0/{}", family.label(), statuses.len())),
        };
    }

    let status = if statuses
        .iter()
        .any(|status| status.available && status.status == "ok")
    {
        "ok"
    } else {
        "limited"
    };
    UsageStatus {
        available: true,
        status: status.to_owned(),
        detail: if statuses.len() > 1 {
            Some(format!(
                "{}: {available}/{}",
                family.label(),
                statuses.len()
            ))
        } else {
            statuses
                .iter()
                .find(|status| status.available)
                .and_then(|status| status.detail.clone())
        },
    }
}

fn summarize_provider_usage(usage: &ProviderUsage) -> UsageStatus {
    let total = usage.families.len();
    let available = usage
        .families
        .values()
        .filter(|status| status.available)
        .count();
    if total == 0 {
        return UsageStatus {
            available: true,
            status: "ok".to_owned(),
            detail: None,
        };
    }
    if available == 0 {
        return UsageStatus {
            available: false,
            status: "exhausted".to_owned(),
            detail: Some(format!("families: 0/{total}")),
        };
    }
    let all_ok = usage
        .families
        .values()
        .all(|status| status.available && status.status == "ok");
    UsageStatus {
        available: true,
        status: if all_ok { "ok" } else { "limited" }.to_owned(),
        detail: (!all_ok).then(|| format!("families: {available}/{total}")),
    }
}

fn model_family(model: &OmpModelInfo) -> ModelFamily {
    let id = model.id.to_ascii_lowercase();
    if id.starts_with("claude-") {
        ModelFamily::Anthropic
    } else if id.starts_with("gemini-") || id.starts_with("tab_") {
        ModelFamily::Google
    } else if id.starts_with("gpt-") || id.starts_with("o1-") || id.starts_with("o3-") {
        ModelFamily::OpenAi
    } else {
        ModelFamily::General
    }
}

fn usage_for_model(model: &OmpModelInfo, usage: &UsageMap) -> Option<UsageStatus> {
    let provider = usage.get(&model.provider)?;
    provider
        .families
        .get(&model_family(model))
        .or_else(|| provider.families.get(&ModelFamily::General))
        .cloned()
        .or_else(|| Some(summarize_provider_usage(provider)))
}

fn apply_usage_to_models(models: &mut [OmpModelInfo], usage: &UsageMap) {
    for model in models {
        let Some(status) = usage_for_model(model, usage) else {
            continue;
        };
        model.available = status.available;
        model.status = status.status;
        model.detail = status.detail;
    }
}

fn build_roles(roles: &BTreeMap<String, String>, models: &[OmpModelInfo]) -> Vec<OmpRoleInfo> {
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
                OmpRoleInfo {
                    role,
                    selector,
                    model: Some(model.clone()),
                    available: model.available,
                    status: model.status.clone(),
                    detail: model.detail.clone(),
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

fn extract_string_lists(raw: &Value, key: &str) -> BTreeMap<String, Vec<String>> {
    raw.pointer(&format!("/{key}/value"))
        .and_then(Value::as_object)
        .or_else(|| raw.get(key).and_then(Value::as_object))
        .map(|map| {
            map.iter()
                .filter_map(|(name, value)| {
                    let selectors = value
                        .as_array()?
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|selector| !selector.is_empty())
                        .map(str::to_owned)
                        .collect::<Vec<_>>();
                    Some((name.clone(), selectors))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn extract_string_list(raw: &Value, key: &str) -> Vec<String> {
    raw.pointer(&format!("/{key}/value"))
        .and_then(Value::as_array)
        .or_else(|| raw.get(key).and_then(Value::as_array))
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
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

fn normalize_proxy_providers(providers: Vec<String>) -> Result<Vec<String>, String> {
    let mut normalized = BTreeSet::new();
    for provider in providers {
        let provider = provider.trim();
        if !valid_selector_segment(provider) {
            return Err(format!(
                "Некорректный provider id для proxy-режима: `{provider}`"
            ));
        }
        normalized.insert(provider.to_owned());
    }
    Ok(normalized.into_iter().collect())
}

fn normalize_fallback_chains(
    chains: HashMap<String, Vec<String>>,
) -> Result<BTreeMap<String, Vec<String>>, String> {
    let mut normalized = BTreeMap::new();
    for (key, selectors) in chains {
        let key = key.trim().to_owned();
        if key.is_empty() {
            return Err("Ключ резервной цепочки не может быть пустым".to_owned());
        }
        validate_fallback_selector(&key)
            .map_err(|error| format!("Некорректный ключ резервной цепочки `{key}`: {error}"))?;

        if selectors.is_empty() {
            return Err(format!("Резервная цепочка `{key}` не содержит моделей"));
        }
        let mut normalized_selectors = Vec::with_capacity(selectors.len());
        for selector in selectors {
            let selector = selector.trim().to_owned();
            if selector.is_empty() {
                return Err(format!("Резервная цепочка `{key}` содержит пустую модель"));
            }
            validate_fallback_selector(&selector).map_err(|error| {
                format!("Некорректная резервная модель `{selector}` для `{key}`: {error}")
            })?;
            normalized_selectors.push(selector);
        }
        if normalized
            .insert(key.clone(), normalized_selectors)
            .is_some()
        {
            return Err(format!("Ключ резервной цепочки `{key}` указан повторно"));
        }
    }
    Ok(normalized)
}

fn validate_fallback_selector(selector: &str) -> Result<(), String> {
    let base = strip_thinking(selector);
    if let Some(prefix) = base.strip_suffix("/*") {
        if !prefix.is_empty() && prefix.split('/').all(valid_selector_segment) {
            return Ok(());
        }
        return Err("wildcard должен иметь формат provider/* или provider/prefix/*".to_owned());
    }
    validate_role_selector(selector)
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
    app: &AppHandle,
) -> Result<(), String> {
    let rendered = match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    match run_omp_text(
        executable,
        &["config", "set", key, &rendered],
        env_map,
        OmpOperation::Config,
    ) {
        Ok(_) => Ok(()),
        Err(error)
            if key == PROXY_MODE_SETTING
                && error.contains("Unknown setting: providers.proxyMode") =>
        {
            let providers = value
                .as_array()
                .ok_or_else(|| "proxyMode должен быть массивом provider id".to_owned())?
                .iter()
                .map(|item| {
                    item.as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| "proxyMode содержит нестроковое значение".to_owned())
                })
                .collect::<Result<Vec<_>, _>>()?;
            save_proxy_providers_compat(app, &providers)
        }
        Err(error) => Err(format!("Не удалось сохранить `{key}`: {error}")),
    }
}

fn save_proxy_providers_compat(app: &AppHandle, providers: &[String]) -> Result<(), String> {
    let path = omp_config_file_path(app);
    let existing = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("Не удалось прочитать {}: {error}", path.display())),
    };
    let updated = update_proxy_mode_yaml(&existing, providers)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Не удалось создать {}: {error}", parent.display()))?;
    }
    crate::sessions::atomic_write_file(&path, updated.as_bytes())
}

fn update_proxy_mode_yaml(contents: &str, providers: &[String]) -> Result<String, String> {
    let parsed = if contents.trim().is_empty() {
        Value::Object(Map::new())
    } else {
        serde_saphyr::from_str::<Value>(contents)
            .map_err(|error| format!("Не удалось разобрать config.yml: {error}"))?
    };
    if !parsed.is_object() {
        return Err("Корень config.yml должен быть объектом".to_owned());
    }

    let newline = if contents.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let had_trailing_newline = contents.ends_with('\n');
    let encoded = serde_json::to_string(providers)
        .map_err(|error| format!("Не удалось сериализовать proxyMode: {error}"))?;
    let mut lines = contents.lines().map(str::to_owned).collect::<Vec<_>>();

    let root_index = lines.iter().position(|line| {
        let trimmed = line.trim();
        yaml_indent(line) == 0 && (trimmed == "providers:" || trimmed.starts_with("providers: #"))
    });

    if let Some(root_index) = root_index {
        let block_end = (root_index + 1..lines.len())
            .find(|&index| {
                let trimmed = lines[index].trim();
                !trimmed.is_empty() && !trimmed.starts_with('#') && yaml_indent(&lines[index]) == 0
            })
            .unwrap_or(lines.len());
        let child_indent = (root_index + 1..block_end)
            .find_map(|index| {
                let trimmed = lines[index].trim();
                (!trimmed.is_empty() && !trimmed.starts_with('#'))
                    .then(|| yaml_indent(&lines[index]))
            })
            .unwrap_or(2);
        let proxy_index = (root_index + 1..block_end).find(|&index| {
            yaml_indent(&lines[index]) == child_indent
                && lines[index]
                    .trim_start()
                    .strip_prefix("proxyMode")
                    .is_some_and(|suffix| suffix.starts_with(':'))
        });

        let replacement = format!("{}proxyMode: {encoded}", " ".repeat(child_indent));
        if let Some(proxy_index) = proxy_index {
            let node_end = (proxy_index + 1..block_end)
                .find(|&index| {
                    let trimmed = lines[index].trim();
                    !trimmed.is_empty() && yaml_indent(&lines[index]) <= child_indent
                })
                .unwrap_or(block_end);
            lines.splice(proxy_index..node_end, [replacement]);
        } else {
            lines.insert(block_end, replacement);
        }
    } else {
        if parsed.get("providers").is_some() {
            return Err(
                "config.yml использует неподдерживаемую inline-форму секции providers".to_owned(),
            );
        }
        if lines.last().is_some_and(|line| !line.trim().is_empty()) {
            lines.push(String::new());
        }
        lines.push("providers:".to_owned());
        lines.push(format!("  proxyMode: {encoded}"));
    }

    let mut updated = lines.join(newline);
    if had_trailing_newline || contents.is_empty() {
        updated.push_str(newline);
    }
    Ok(updated)
}

fn yaml_indent(line: &str) -> usize {
    line.as_bytes()
        .iter()
        .take_while(|byte| **byte == b' ')
        .count()
}

fn omp_config_file_path(app: &AppHandle) -> PathBuf {
    if let Some(dir) = env::var_os("PI_CODING_AGENT_DIR") {
        return PathBuf::from(dir).join("config.yml");
    }
    app.path()
        .home_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".omp")
        .join("agent")
        .join("config.yml")
}

fn extract_proxy_providers(raw: &Value, app: &AppHandle) -> Vec<String> {
    if raw.get(PROXY_MODE_SETTING).is_some() {
        return extract_string_list(raw, PROXY_MODE_SETTING);
    }
    let path = omp_config_file_path(app);
    let Ok(contents) = fs::read_to_string(path) else {
        return Vec::new();
    };
    extract_proxy_providers_yaml(&contents)
}

fn extract_proxy_providers_yaml(contents: &str) -> Vec<String> {
    let Ok(doc) = serde_saphyr::from_str::<Value>(contents) else {
        return Vec::new();
    };
    doc.pointer("/providers/proxyMode")
        .or_else(|| doc.get(PROXY_MODE_SETTING))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|provider| !provider.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn run_omp_json(
    executable: &str,
    args: &[&str],
    env_map: &HashMap<String, String>,
    operation: OmpOperation,
) -> Result<Value, String> {
    let text = run_omp_text(executable, args, env_map, operation)?;
    serde_json::from_str(&text).map_err(|error| {
        format!(
            "[omp_invalid_json] OMP вернул не-JSON для `{}`: {error}\n{}",
            args.join(" "),
            text.chars().take(400).collect::<String>()
        )
    })
}

fn run_omp_text(
    executable: &str,
    args: &[&str],
    env_map: &HashMap<String, String>,
    operation: OmpOperation,
) -> Result<String, String> {
    let output = run_omp_command(executable, args, env_map, operation)
        .map_err(|error| format!("[{}] {error}", error.code()))?;
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
            format!("[omp_command_failed] OMP завершил команду с кодом {code}")
        } else {
            format!("[omp_command_failed] OMP завершил команду с кодом {code}: {detail}")
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
        let yaml = serde_saphyr::from_str::<ModelsYamlFile>(
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

    #[test]
    fn fallback_config_extracts_wrapped_record() {
        let raw = serde_json::json!({
            "retry.fallbackChains": {
                "value": {
                    "default": ["provider/primary:high", "provider/backup:low"],
                    "provider/*": ["other/*"]
                }
            }
        });
        let chains = extract_string_lists(&raw, "retry.fallbackChains");
        assert_eq!(
            chains.get("default"),
            Some(&vec![
                "provider/primary:high".to_owned(),
                "provider/backup:low".to_owned(),
            ])
        );
        assert_eq!(chains.get("provider/*"), Some(&vec!["other/*".to_owned()]));
    }

    #[test]
    fn proxy_provider_config_extracts_wrapped_array() {
        let raw = serde_json::json!({
            "providers.proxyMode": { "value": ["codex-lb", " gateway ", 7, ""] }
        });
        assert_eq!(
            extract_string_list(&raw, "providers.proxyMode"),
            vec!["codex-lb".to_owned(), "gateway".to_owned()]
        );
    }

    #[test]
    fn proxy_provider_normalization_deduplicates_and_rejects_selectors() {
        assert_eq!(
            normalize_proxy_providers(vec![
                " codex-lb ".to_owned(),
                "gateway".to_owned(),
                "codex-lb".to_owned(),
            ])
            .unwrap(),
            vec!["codex-lb".to_owned(), "gateway".to_owned()]
        );
        assert!(normalize_proxy_providers(vec!["provider/model".to_owned()]).is_err());
    }

    #[test]
    fn proxy_mode_compat_update_preserves_existing_yaml() {
        let source = concat!(
            "setupVersion: 2\r\n",
            "providers:\r\n",
            "  openaiWebsockets: auto\r\n",
            "retry:\r\n",
            "  modelFallback: true\r\n",
        );
        let updated = update_proxy_mode_yaml(source, &["codex-lb".to_owned()]).unwrap();

        assert_eq!(
            updated,
            concat!(
                "setupVersion: 2\r\n",
                "providers:\r\n",
                "  openaiWebsockets: auto\r\n",
                "  proxyMode: [\"codex-lb\"]\r\n",
                "retry:\r\n",
                "  modelFallback: true\r\n",
            )
        );
        assert_eq!(
            extract_proxy_providers_yaml(&updated),
            vec!["codex-lb".to_owned()]
        );
    }

    #[test]
    fn proxy_mode_compat_update_replaces_block_sequence() {
        let source = concat!(
            "providers:\n",
            "  proxyMode:\n",
            "    - old-proxy\n",
            "  openaiWebsockets: auto\n",
        );
        let updated =
            update_proxy_mode_yaml(source, &["codex-lb".to_owned(), "gateway".to_owned()]).unwrap();

        assert_eq!(
            updated,
            concat!(
                "providers:\n",
                "  proxyMode: [\"codex-lb\",\"gateway\"]\n",
                "  openaiWebsockets: auto\n",
            )
        );
    }

    #[test]
    fn fallback_selector_validation_accepts_roles_models_and_wildcards() {
        for selector in [
            "default",
            "provider/model:high",
            "provider/*",
            "openrouter/google/*",
            "@slow:xhigh",
        ] {
            assert!(validate_fallback_selector(selector).is_ok(), "{selector}");
        }
        for selector in ["provider/", "provider/*/model", "provider/ bad/*"] {
            assert!(validate_fallback_selector(selector).is_err(), "{selector}");
        }
    }

    #[test]
    fn antigravity_usage_is_applied_per_model_family_across_accounts() {
        let usage = parse_usage_reports(&serde_json::json!({
            "reports": [
                {
                    "provider": "google-antigravity",
                    "limits": [
                        {"id": "anthropic", "label": "Usage (Anthropic)", "amount": {"usedFraction": 1.0}, "status": "exhausted"},
                        {"id": "openai", "label": "Usage (OpenAI)", "amount": {"usedFraction": 1.0}, "status": "exhausted"},
                        {"id": "google", "label": "Usage (Google)", "amount": {"usedFraction": 0.0}, "status": "ok"}
                    ]
                },
                {
                    "provider": "google-antigravity",
                    "limits": [
                        {"id": "anthropic", "label": "Usage (Anthropic)", "amount": {"usedFraction": 1.0}, "status": "exhausted"},
                        {"id": "openai", "label": "Usage (OpenAI)", "amount": {"usedFraction": 1.0}, "status": "exhausted"},
                        {"id": "google", "label": "Usage (Google)", "amount": {"usedFraction": 0.23}, "status": "ok"}
                    ]
                }
            ]
        }));
        let mut models = vec![
            model("google-antigravity", "gemini-3.1-pro"),
            model("google-antigravity", "tab_flash_lite_preview"),
            model("google-antigravity", "claude-sonnet-4-6"),
            model("google-antigravity", "gpt-oss-120b"),
        ];
        apply_usage_to_models(&mut models, &usage);

        assert!(models[0].available);
        assert_eq!(models[0].status, "ok");
        assert!(models[1].available);
        assert!(!models[2].available);
        assert_eq!(models[2].status, "exhausted");
        assert!(!models[3].available);
        assert_eq!(models[3].status, "exhausted");

        let provider = summarize_provider_usage(usage.get("google-antigravity").unwrap());
        assert!(provider.available);
        assert_eq!(provider.status, "limited");
    }

    #[test]
    fn one_available_account_keeps_the_model_family_available() {
        let usage = parse_usage_reports(&serde_json::json!({
            "reports": [
                {"provider": "google-antigravity", "limits": [
                    {"label": "Usage (Google)", "amount": {"usedFraction": 1.0}, "status": "exhausted"}
                ]},
                {"provider": "google-antigravity", "limits": [
                    {"label": "Usage (Google)", "amount": {"usedFraction": 0.4}, "status": "ok"}
                ]}
            ]
        }));
        let mut models = vec![model("google-antigravity", "gemini-3.1-pro")];
        apply_usage_to_models(&mut models, &usage);
        assert!(models[0].available);
        assert_eq!(models[0].status, "ok");
        assert_eq!(models[0].detail.as_deref(), Some("Google: 1/2"));
    }
}
