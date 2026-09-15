use crate::{
    diagnostics,
    models::{
        AppSettings, BootstrapPayload, OmpAccountLimitInfo, OmpAccountRouteInfo,
        OmpAccountUsageInfo, OmpConfigSaveRequest, OmpConfigSnapshot, OmpConfigWarning,
        OmpCredentialInfo, OmpModelInfo, OmpRoleInfo, OmpUpdateInfo,
    },
    omp_command::{run_omp_command, OmpOperation},
    provider_config,
    settings::{resolve_omp, SettingsTransaction},
    update,
};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use tauri::AppHandle;

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
        OmpOperation::Config,
    )?;
    let disabled_provider_entries = extract_array_entries(&raw, "disabledProviders");
    let disabled_providers = disabled_provider_entries
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|provider| !provider.is_empty())
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    let (models_result, usage_result) = std::thread::scope(|scope| {
        let models = scope.spawn(|| load_models(&omp.executable, &app_settings.provider_env));
        let usage = scope.spawn(|| load_usage(&omp.executable, &app_settings.provider_env));
        (models.join(), usage.join())
    });
    let mut warnings = Vec::new();
    let mut models =
        snapshot_value_or_warning(models_result, "models", "omp_models_failed", &mut warnings);
    let usage = snapshot_value_or_warning(usage_result, "usage", "omp_usage_failed", &mut warnings);
    apply_usage_to_models(&mut models, &usage.providers);
    let roles_map = extract_roles(&raw);
    let fallback_chains = extract_string_lists(&raw, "retry.fallbackChains");
    let roles = build_roles(&roles_map, &models);
    warnings.extend(build_model_config_warnings(
        &roles_map,
        &fallback_chains,
        &models,
    ));
    for role in roles
        .iter()
        .filter(|role| !role.selector.trim().is_empty() && role.status != "ok")
    {
        warnings.push(OmpConfigWarning {
            source: "model-role".to_owned(),
            code: format!("{}_{}", role.role, role.status),
            message: format!(
                "Роль {}: {}",
                role.role,
                role.detail
                    .as_deref()
                    .unwrap_or("нет доступного маршрута к выбранной модели")
            ),
        });
    }
    let credentials = build_credentials(
        app,
        app_settings,
        &models,
        &usage.providers,
        &disabled_providers,
    );

    Ok(OmpConfigSnapshot {
        roles,
        usage_observed_at: usage.observed_at,
        models,
        accounts: usage.accounts,
        advisor_enabled: extract_bool(&raw, "advisor.enabled").unwrap_or(false),
        auto_resume: extract_bool(&raw, "autoResume").unwrap_or(false),
        default_thinking_level: extract_string(&raw, "defaultThinkingLevel"),
        model_fallback_enabled: extract_bool(&raw, "retry.modelFallback").unwrap_or(true),
        fallback_chains,
        proxy_providers: app_settings.proxy_providers.iter().cloned().collect(),
        disabled_providers: disabled_providers.into_iter().collect(),
        disabled_provider_entries,
        provider_env_keys: PROVIDER_ENV_KEYS
            .iter()
            .map(|key| (*key).to_owned())
            .collect(),
        credentials,
        warnings,
    })
}

pub fn refresh_config_snapshot(
    app: &AppHandle,
    app_settings: &AppSettings,
) -> Result<OmpConfigSnapshot, String> {
    let omp = resolve_omp(app, app_settings);
    if omp.version.is_none() {
        return Err(format!("OMP не найден: {}", omp.executable));
    }
    run_omp_text(
        &omp.executable,
        &["usage", "invalidate"],
        &app_settings.provider_env,
        OmpOperation::Usage,
    )
    .map_err(|error| format!("Не удалось принудительно обновить usage OMP: {error}"))?;
    load_config_snapshot(app, app_settings)
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
    #[serde(rename = "baseUrl")]
    base_url: Option<String>,
    api: Option<String>,
}

fn load_models_yaml(app: &AppHandle) -> BTreeMap<String, ModelsYamlProvider> {
    let Ok(path) = provider_config::models_path(app) else {
        return BTreeMap::new();
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
    disabled_providers: &BTreeSet<String>,
) -> Vec<OmpCredentialInfo> {
    build_credentials_from_sources(
        load_models_yaml(app),
        &app_settings.provider_env,
        models,
        usage,
        disabled_providers,
        |key| std::env::var_os(key).is_some(),
    )
}

fn build_credentials_from_sources<F>(
    yaml_providers: BTreeMap<String, ModelsYamlProvider>,
    provider_env: &HashMap<String, String>,
    models: &[OmpModelInfo],
    usage: &UsageMap,
    disabled_providers: &BTreeSet<String>,
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
            Some(_) => ("models".to_owned(), None),
            None => ("omp".to_owned(), None),
        };
        let managed = provider_config::is_desktop_managed_provider(
            &provider,
            config.api_key.as_ref().and_then(Value::as_str),
        );
        let model_count = model_counts.get(&provider).copied().unwrap_or_default();
        credentials.insert(
            provider.clone(),
            credential_info(
                provider.clone(),
                source,
                key_name,
                model_count,
                usage,
                CredentialMetadata {
                    disabled: disabled_providers.contains(&provider),
                    custom: true,
                    base_url: managed
                        .then(|| provider_config::public_base_url(config.base_url.as_deref()))
                        .flatten(),
                    api: managed
                        .then(|| provider_config::public_api(config.api.as_deref()))
                        .flatten(),
                },
            ),
        );
    }

    for provider in model_counts
        .keys()
        .chain(usage.keys())
        .chain(disabled_providers)
    {
        if credentials.contains_key(provider) {
            continue;
        }
        let model_count = model_counts.get(provider).copied().unwrap_or_default();
        credentials.insert(
            provider.clone(),
            credential_info(
                provider.clone(),
                "omp".to_owned(),
                None,
                model_count,
                usage,
                CredentialMetadata {
                    disabled: disabled_providers.contains(provider),
                    custom: false,
                    base_url: None,
                    api: None,
                },
            ),
        );
    }

    credentials.into_values().collect()
}

struct CredentialMetadata {
    disabled: bool,
    custom: bool,
    base_url: Option<String>,
    api: Option<String>,
}

fn credential_info(
    provider: String,
    source: String,
    key_name: Option<String>,
    model_count: usize,
    usage: &UsageMap,
    metadata: CredentialMetadata,
) -> OmpCredentialInfo {
    let CredentialMetadata {
        disabled,
        custom,
        base_url,
        api,
    } = metadata;
    let usage_status = usage.get(&provider).map(summarize_provider_usage);
    let available = !disabled
        && usage_status
            .as_ref()
            .map(|item| item.available)
            .unwrap_or(model_count > 0);
    let status = if disabled {
        "disabled".to_owned()
    } else {
        usage_status
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
            })
    };
    OmpCredentialInfo {
        provider,
        key_name,
        source,
        status,
        available,
        model_count,
        custom,
        base_url,
        api,
    }
}

fn extract_array_entries(raw: &Value, key: &str) -> Vec<Value> {
    raw.pointer(&format!("/{key}/value"))
        .and_then(Value::as_array)
        .or_else(|| raw.get(key).and_then(Value::as_array))
        .cloned()
        .unwrap_or_default()
}

fn normalize_disabled_providers(providers: Vec<String>) -> Result<Vec<String>, String> {
    let mut normalized = BTreeSet::new();
    for provider in providers {
        let provider = provider_config::normalize_provider_id(&provider)?;
        normalized.insert(provider);
    }
    Ok(normalized.into_iter().collect())
}

fn merge_disabled_provider_entries(entries: &[Value], providers: &[String]) -> Value {
    let mut merged = entries
        .iter()
        .filter(|entry| !entry.is_string())
        .cloned()
        .collect::<Vec<_>>();
    merged.extend(providers.iter().cloned().map(Value::String));
    Value::Array(merged)
}

fn validate_removed_provider_references(
    removed: &BTreeSet<String>,
    roles: &BTreeMap<String, String>,
    chains: &BTreeMap<String, Vec<String>>,
) -> Result<(), String> {
    let used = |selector: &str| {
        strip_thinking(selector)
            .split_once('/')
            .is_some_and(|(provider, _)| removed.contains(provider))
    };
    let role_references = roles
        .iter()
        .filter(|(_, selector)| used(selector))
        .map(|(role, _)| role.as_str())
        .collect::<Vec<_>>();
    let fallback_references = chains
        .iter()
        .filter(|(_, selectors)| selectors.iter().any(|selector| used(selector)))
        .map(|(chain, _)| chain.as_str())
        .collect::<Vec<_>>();
    if role_references.is_empty() && fallback_references.is_empty() {
        return Ok(());
    }
    Err(format!(
        "Сначала уберите удаляемый provider из ролей [{}] и fallback-цепочек [{}]",
        role_references.join(", "),
        fallback_references.join(", ")
    ))
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
    let mut expected_proxy_providers = request
        .proxy_providers
        .map(normalize_proxy_providers)
        .transpose()?;
    let mut expected_disabled_providers = request
        .disabled_providers
        .map(normalize_disabled_providers)
        .transpose()?;
    let previous_config = load_config_snapshot(app, &app_settings)?;
    let custom_changes_requested =
        !request.custom_provider_upserts.is_empty() || !request.removed_custom_providers.is_empty();
    let mut provider_file_mutation = if custom_changes_requested {
        provider_config::prepare_provider_file_mutation(
            provider_config::models_path(app)?,
            request.custom_provider_upserts,
            request.removed_custom_providers,
        )?
    } else {
        None
    };

    if let Some(mutation) = provider_file_mutation.as_ref() {
        if let Some(provider) = mutation.added.keys().find(|provider| {
            previous_config
                .models
                .iter()
                .any(|model| model.provider.eq_ignore_ascii_case(provider))
                || previous_config
                    .credentials
                    .iter()
                    .any(|credential| credential.provider.eq_ignore_ascii_case(provider))
        }) {
            return Err(format!(
                "Provider ID `{provider}` уже занят; выберите новый уникальный ID"
            ));
        }
        let chains = expected_fallback_chains
            .as_ref()
            .unwrap_or(&previous_config.fallback_chains);
        validate_removed_provider_references(&mutation.removed, &expected_roles, chains)?;
        if !mutation.removed.is_empty() {
            let providers = expected_proxy_providers
                .get_or_insert_with(|| previous_config.proxy_providers.clone());
            providers.retain(|provider| !mutation.removed.contains(provider));
        }
        if !mutation.added.is_empty() || !mutation.removed.is_empty() {
            let providers = expected_disabled_providers
                .get_or_insert_with(|| previous_config.disabled_providers.clone());
            providers.retain(|provider| {
                !mutation.added.contains_key(provider) && !mutation.removed.contains(provider)
            });
        }
    }

    let proxy_provider_warnings = if let Some(providers) = expected_proxy_providers.as_ref() {
        let warnings = validate_proxy_provider_membership(
            providers,
            &previous_config.proxy_providers,
            &previous_config.models,
        )?;
        app_settings.proxy_providers = providers.iter().cloned().collect();
        warnings
    } else {
        Vec::new()
    };

    let mut requested_provider_env = request.provider_env;
    if let Some(mutation) = provider_file_mutation.as_mut() {
        let requested = requested_provider_env.get_or_insert_with(|| {
            app_settings
                .provider_env_keys
                .iter()
                .cloned()
                .map(|key| (key, String::new()))
                .collect()
        });
        for key in &mutation.removed_secret_keys {
            requested.remove(key);
        }
        requested.extend(std::mem::take(&mut mutation.secret_values));
    }
    let credentials_changed = if let Some(provider_env) = requested_provider_env {
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
    let previous_roles = previous_config
        .roles
        .iter()
        .filter(|role| !role.selector.trim().is_empty())
        .map(|role| (role.role.clone(), role.selector.trim().to_owned()))
        .collect::<BTreeMap<_, _>>();
    let model_config_touched = expected_roles != previous_roles;
    let disabled_value = expected_disabled_providers.as_ref().map(|providers| {
        merge_disabled_provider_entries(&previous_config.disabled_provider_entries, providers)
    });
    let mut settings_save_attempted = false;
    let mut models_file_applied = false;
    let transaction_result = (|| {
        if model_config_touched {
            set_omp_config(
                &omp.executable,
                "modelRoles",
                &roles_value,
                &app_settings.provider_env,
            )?;
        }
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
            )?;
        }
        if let Some(enabled) = expected_model_fallback {
            set_omp_config(
                &omp.executable,
                "retry.modelFallback",
                &Value::Bool(enabled),
                &app_settings.provider_env,
            )?;
        }
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
        if let Some(value) = disabled_value.as_ref() {
            set_omp_config(
                &omp.executable,
                "disabledProviders",
                value,
                &app_settings.provider_env,
            )?;
        }
        if let Some(mutation) = provider_file_mutation.as_ref() {
            mutation.apply()?;
            models_file_applied = true;
        }

        if provider_file_mutation.is_some() {
            run_omp_text(
                &omp.executable,
                &["models", "refresh"],
                &app_settings.provider_env,
                OmpOperation::Models,
            )?;
        }
        let mut snapshot = load_config_snapshot(app, &app_settings)?;
        snapshot.warnings.extend(proxy_provider_warnings);
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
                disabled_providers: expected_disabled_providers.as_deref(),
                provider_mutation: provider_file_mutation.as_ref(),
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
            &omp.executable,
            &app_settings.provider_env,
            &previous_config,
            model_config_touched,
            expected_advisor.is_some(),
            expected_auto_resume.is_some(),
            expected_thinking.is_some(),
            expected_model_fallback.is_some(),
            expected_fallback_chains.is_some(),
            expected_disabled_providers.is_some(),
        );
        if models_file_applied {
            if let Some(mutation) = provider_file_mutation.as_ref() {
                if let Err(rollback_error) = mutation.rollback() {
                    rollback_errors.push(rollback_error);
                }
            }
            if let Err(rollback_error) = run_omp_text(
                &omp.executable,
                &["models", "refresh"],
                &previous_settings.provider_env,
                OmpOperation::Models,
            ) {
                rollback_errors.push(rollback_error);
            }
        }
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
    executable: &str,
    provider_env: &HashMap<String, String>,
    previous: &OmpConfigSnapshot,
    model_roles_touched: bool,
    advisor_touched: bool,
    auto_resume_touched: bool,
    thinking_touched: bool,
    model_fallback_touched: bool,
    fallback_chains_touched: bool,
    disabled_providers_touched: bool,
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
        if let Err(error) = set_omp_config(executable, key, &value, provider_env) {
            errors.push(format!("{key}: {error}"));
        }
    };
    if model_roles_touched {
        restore("modelRoles", roles);
    }
    if fallback_chains_touched {
        restore(
            "retry.fallbackChains",
            serde_json::to_value(&previous.fallback_chains).unwrap_or(Value::Object(Map::new())),
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
    if disabled_providers_touched {
        restore(
            "disabledProviders",
            Value::Array(previous.disabled_provider_entries.clone()),
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
    disabled_providers: Option<&'a [String]>,
    provider_mutation: Option<&'a provider_config::ProviderFileMutation>,
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
        return Err("OMP Desktop не сохранил proxy-режим провайдеров".to_owned());
    }
    if expected
        .disabled_providers
        .is_some_and(|value| snapshot.disabled_providers != value)
    {
        return Err("OMP не применил состояние провайдеров".to_owned());
    }
    if let Some(mutation) = expected.provider_mutation {
        for (provider, (base_url, api)) in &mutation.added {
            let credential = snapshot
                .credentials
                .iter()
                .find(|credential| credential.provider == *provider)
                .ok_or_else(|| format!("OMP не загрузил добавленный provider `{provider}`"))?;
            if !credential.custom
                || credential.base_url.as_deref() != Some(base_url)
                || credential.api.as_deref() != Some(api)
                || credential.source != "desktop"
            {
                return Err(format!("OMP некорректно загрузил provider `{provider}`"));
            }
        }
        if mutation.removed.iter().any(|provider| {
            snapshot
                .credentials
                .iter()
                .any(|credential| credential.custom && credential.provider == *provider)
        }) {
            return Err("OMP не удалил custom provider".to_owned());
        }
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

fn load_usage(
    executable: &str,
    env_map: &HashMap<String, String>,
) -> Result<UsageSnapshot, String> {
    let value = run_omp_json(
        executable,
        &["usage", "--json"],
        env_map,
        OmpOperation::Usage,
    )?;
    Ok(parse_usage_snapshot(&value))
}

#[derive(Default)]
struct UsageSnapshot {
    providers: UsageMap,
    accounts: Vec<OmpAccountUsageInfo>,
    observed_at: Option<u64>,
}

type UsageMap = HashMap<String, ProviderUsage>;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum ModelFamily {
    Google,
    Anthropic,
    AnthropicOpus,
    AnthropicSonnet,
    AnthropicFable,
    AnthropicMythos,
    OpenAi,
    OpenAiSpark,
    General,
}

fn parse_usage_snapshot(value: &Value) -> UsageSnapshot {
    let mut providers = parse_usage_reports(value);
    let accounts = parse_usage_accounts(value);
    apply_account_routing_to_usage(&mut providers, &accounts);
    UsageSnapshot {
        providers,
        accounts,
        observed_at: value.get("generatedAt").and_then(Value::as_u64),
    }
}

fn parse_account_limits(report: &Value) -> Vec<OmpAccountLimitInfo> {
    report
        .get("limits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|limit| {
            let id = limit.get("id")?.as_str()?.to_owned();
            let label = limit
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_owned();
            let used_fraction = limit_used_fraction(limit);
            let status = limit
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    if used_fraction.is_some_and(|used| used >= 0.999) {
                        "exhausted".to_owned()
                    } else if used_fraction.is_some_and(|used| used >= 0.8) {
                        "warning".to_owned()
                    } else {
                        "ok".to_owned()
                    }
                });
            Some(OmpAccountLimitInfo {
                id,
                label,
                status,
                used_percent: used_fraction.map(|used| used.clamp(0.0, 1.0) * 100.0),
                window_label: limit
                    .pointer("/window/label")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                resets_at: limit.pointer("/window/resetsAt").and_then(Value::as_u64),
            })
        })
        .collect()
}

fn parse_usage_accounts(value: &Value) -> Vec<OmpAccountUsageInfo> {
    let mut accounts = Vec::new();
    let mut seen = BTreeSet::new();

    if let Some(reports) = value.get("reports").and_then(Value::as_array) {
        for (index, report) in reports.iter().enumerate() {
            if let Some(account) = parse_usage_report_account(report, index) {
                if seen.insert(account.id.clone()) {
                    accounts.push(account);
                }
            }
        }
    }
    if let Some(missing) = value.get("accountsWithoutUsage").and_then(Value::as_array) {
        for (index, account) in missing.iter().enumerate() {
            if let Some(account) = parse_unreported_account(account, index) {
                if seen.insert(account.id.clone()) {
                    accounts.push(account);
                }
            }
        }
    }
    if let Some(disabled) = value.get("disabledCredentials").and_then(Value::as_array) {
        for (index, credential) in disabled.iter().enumerate() {
            if let Some(account) = parse_disabled_account(credential, index) {
                if seen.insert(account.id.clone()) {
                    accounts.push(account);
                }
            }
        }
    }

    accounts.sort_by(|left, right| {
        left.provider
            .cmp(&right.provider)
            .then_with(|| left.label.cmp(&right.label))
    });
    accounts
}

fn parse_usage_report_account(value: &Value, index: usize) -> Option<OmpAccountUsageInfo> {
    let provider = value.get("provider")?.as_str()?.trim().to_owned();
    if provider.is_empty() {
        return None;
    }
    let identity = usage_account_identity(value, index);
    let id = usage_account_id(&provider, &identity);
    let limits = parse_account_limits(value);
    let routes = routes_from_usage_report(&provider, value);
    let has_limits = !limits.is_empty();
    let routing_eligible = has_limits && routes.iter().any(|route| route.routing_eligible);
    let status = if !has_limits {
        "unknown"
    } else if !routing_eligible {
        "exhausted"
    } else if routes
        .iter()
        .any(|route| route.status != "ready" || !route.routing_eligible)
    {
        "limited"
    } else {
        "ready"
    };

    Some(OmpAccountUsageInfo {
        id: id.clone(),
        provider,
        credential_type: usage_credential_type(value),
        label: usage_account_label(value, &id),
        status: status.to_owned(),
        configured: true,
        reporting: has_limits,
        status_reason: (!has_limits).then(|| "usage limits were not reported".to_owned()),
        routing_eligible,
        routing_evidence: if has_limits { "usage" } else { "unknown" }.to_owned(),
        routes,
        limits,
        fetched_at: value.get("fetchedAt").and_then(Value::as_u64),
    })
}

fn parse_unreported_account(value: &Value, index: usize) -> Option<OmpAccountUsageInfo> {
    let provider = value.get("provider")?.as_str()?.trim().to_owned();
    if provider.is_empty() {
        return None;
    }
    let identity = usage_account_identity(value, index);
    let id = usage_account_id(&provider, &identity);
    Some(OmpAccountUsageInfo {
        id: id.clone(),
        provider,
        credential_type: usage_credential_type(value),
        label: usage_account_label(value, &id),
        status: "unknown".to_owned(),
        configured: true,
        reporting: false,
        status_reason: Some("usage limits were not reported".to_owned()),
        routing_eligible: false,
        routing_evidence: "unknown".to_owned(),
        routes: Vec::new(),
        limits: Vec::new(),
        fetched_at: None,
    })
}

fn parse_disabled_account(value: &Value, index: usize) -> Option<OmpAccountUsageInfo> {
    let provider = value.get("provider")?.as_str()?.trim().to_owned();
    if provider.is_empty() || provider.starts_with("mcp_oauth:") {
        return None;
    }
    let identity = usage_account_identity(value, index);
    let id = usage_account_id(&provider, &identity);
    Some(OmpAccountUsageInfo {
        id: id.clone(),
        provider,
        credential_type: usage_credential_type(value),
        label: usage_account_label(value, &id),
        status: "disabled".to_owned(),
        configured: false,
        reporting: false,
        status_reason: Some("credential disabled; sign in again".to_owned()),
        routing_eligible: false,
        routing_evidence: "reported".to_owned(),
        routes: Vec::new(),
        limits: Vec::new(),
        fetched_at: None,
    })
}

fn routes_from_usage_report(provider: &str, report: &Value) -> Vec<OmpAccountRouteInfo> {
    let mut families = HashMap::<ModelFamily, UsageStatus>::new();
    if let Some(limits) = report.get("limits").and_then(Value::as_array) {
        for limit in limits {
            let family = usage_family(provider, limit);
            let candidate = usage_status_from_limit(limit);
            families
                .entry(family)
                .and_modify(|current| {
                    if usage_severity(&candidate) > usage_severity(current) {
                        *current = candidate.clone();
                    }
                })
                .or_insert(candidate);
        }
    }
    if families.is_empty() {
        return Vec::new();
    }

    let mut routes = families
        .into_iter()
        .map(|(family, status)| OmpAccountRouteInfo {
            id: usage_route_id(family).to_owned(),
            label: family.label().to_owned(),
            status: match status.status.as_str() {
                "ok" => "ready".to_owned(),
                "limited" => "limited".to_owned(),
                _ => "exhausted".to_owned(),
            },
            routing_eligible: status.available,
        })
        .collect::<Vec<_>>();
    routes.sort_by(|left, right| left.id.cmp(&right.id));
    routes
}

fn usage_route_id(family: ModelFamily) -> &'static str {
    match family {
        ModelFamily::Google => "counter:google",
        ModelFamily::Anthropic => "counter:anthropic",
        ModelFamily::AnthropicOpus => "counter:anthropic-opus",
        ModelFamily::AnthropicSonnet => "counter:anthropic-sonnet",
        ModelFamily::AnthropicFable => "counter:anthropic-fable",
        ModelFamily::AnthropicMythos => "counter:anthropic-mythos",
        ModelFamily::OpenAi => "counter:openai",
        ModelFamily::OpenAiSpark => "counter:openai-spark",
        ModelFamily::General => "general",
    }
}

fn identity_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .or_else(|| value.get("metadata").and_then(|metadata| metadata.get(key)))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|identity| !identity.is_empty())
}

fn usage_account_identity(value: &Value, index: usize) -> String {
    let mut identity = [
        "accountKey",
        "accountId",
        "projectId",
        "email",
        "enterpriseUrl",
    ]
    .into_iter()
    .find_map(|key| identity_string(value, key).map(|value| format!("{key}:{value}")));
    if identity.is_none() {
        if let Some(limits) = value.get("limits").and_then(Value::as_array) {
            'limits: for limit in limits {
                for key in ["accountId", "projectId"] {
                    if let Some(scoped) = limit
                        .get("scope")
                        .and_then(|scope| scope.get(key))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|scoped| !scoped.is_empty())
                    {
                        identity = Some(format!("{key}:{scoped}"));
                        break 'limits;
                    }
                }
            }
        }
    }
    let organization =
        identity_string(value, "orgId").or_else(|| identity_string(value, "orgName"));
    if let Some(organization) = organization {
        let identity = identity.get_or_insert_with(String::new);
        if !identity.is_empty() {
            identity.push('|');
        }
        identity.push_str("org:");
        identity.push_str(organization);
    }
    if let Some(identity) = identity.filter(|identity| !identity.is_empty()) {
        return identity;
    }
    if let Some(id) = value.get("id") {
        if let Some(id) = id.as_str() {
            return format!("id:{id}");
        }
        if let Some(id) = id.as_u64() {
            return format!("id:{id}");
        }
    }
    format!("row:{index}")
}

fn usage_account_id(provider: &str, identity: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in provider
        .bytes()
        .chain(std::iter::once(0))
        .chain(identity.bytes())
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("usage-{hash:016x}")
}

fn usage_account_label(value: &Value, id: &str) -> String {
    let email = identity_string(value, "email");
    let primary = email
        .or_else(|| identity_string(value, "accountId"))
        .or_else(|| identity_string(value, "projectId"))
        .or_else(|| identity_string(value, "enterpriseUrl"));
    let organization =
        identity_string(value, "orgName").or_else(|| identity_string(value, "orgId"));
    let suffix = id.strip_prefix("usage-").unwrap_or(id);
    let suffix = suffix.get(..8).unwrap_or(suffix);
    let masked = email
        .map(mask_email)
        .or_else(|| primary.map(mask_identifier))
        .or_else(|| {
            value
                .get("provider")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "account".to_owned());
    let mut parts = vec![masked];
    if let Some(organization) = organization.filter(|organization| Some(*organization) != primary) {
        parts.push(mask_identifier(organization));
    }
    parts.push(suffix.to_owned());
    parts.join(" · ")
}

fn mask_email(email: &str) -> String {
    let Some((local, domain)) = email.split_once('@') else {
        return mask_identifier(email);
    };
    let prefix = local.chars().take(3).collect::<String>();
    format!("{prefix}***@{domain}")
}

fn mask_identifier(value: &str) -> String {
    let prefix = value.chars().take(2).collect::<String>();
    format!("{prefix}*")
}

fn usage_credential_type(value: &Value) -> String {
    match value
        .get("credentialType")
        .or_else(|| value.get("type"))
        .and_then(Value::as_str)
    {
        Some("api_key" | "api-key") => "api_key".to_owned(),
        Some("oauth") => "oauth".to_owned(),
        _ => "unknown".to_owned(),
    }
}

fn route_family(provider: &str, route: &OmpAccountRouteInfo) -> Option<ModelFamily> {
    let value = format!("{} {}", route.id, route.label).to_ascii_lowercase();
    if value.contains("model-policy:") {
        return None;
    }
    if provider == "anthropic" {
        if let Some(family) = anthropic_tier_family(&value) {
            return Some(family);
        }
    }
    if value.contains("spark") {
        Some(ModelFamily::OpenAiSpark)
    } else if value.contains("anthropic") || value.contains("claude") {
        Some(ModelFamily::Anthropic)
    } else if value.contains("openai") || value.contains("chat") || value.contains("gpt") {
        Some(ModelFamily::OpenAi)
    } else if value.contains("google") || value.contains("gemini") {
        Some(ModelFamily::Google)
    } else {
        Some(ModelFamily::General)
    }
}

fn usage_status_from_route(route: &OmpAccountRouteInfo) -> UsageStatus {
    let status = match route.status.as_str() {
        "ready" => "ok",
        "limited" => "limited",
        "auth-error" => "auth-error",
        "blocked" | "exhausted" => "exhausted",
        _ if route.routing_eligible => "limited",
        _ => "exhausted",
    };
    UsageStatus {
        available: route.routing_eligible,
        status: status.to_owned(),
        detail: Some(route.label.clone()),
    }
}

fn usage_status_from_account(account: &OmpAccountUsageInfo) -> UsageStatus {
    let status = if account.status == "auth-error" || account.status == "disabled" {
        "auth-error"
    } else if account.routing_eligible {
        "ok"
    } else {
        "exhausted"
    };
    UsageStatus {
        available: account.routing_eligible,
        status: status.to_owned(),
        detail: None,
    }
}

fn account_route_status_for_family(
    routes: &HashMap<ModelFamily, UsageStatus>,
    family: ModelFamily,
) -> Option<UsageStatus> {
    account_status_for_family(routes, family).or_else(|| routes.get(&ModelFamily::General).cloned())
}

fn apply_account_routing_to_usage(usage: &mut UsageMap, accounts: &[OmpAccountUsageInfo]) {
    let mut by_provider = HashMap::<String, Vec<&OmpAccountUsageInfo>>::new();
    for account in accounts {
        if account.routing_evidence == "unknown" {
            continue;
        }
        by_provider
            .entry(account.provider.clone())
            .or_default()
            .push(account);
    }

    for (provider, provider_accounts) in by_provider {
        let account_routes = provider_accounts
            .iter()
            .map(|account| {
                let mut routes = HashMap::<ModelFamily, UsageStatus>::new();
                for route in &account.routes {
                    let Some(family) = route_family(&provider, route) else {
                        continue;
                    };
                    let candidate = usage_status_from_route(route);
                    routes
                        .entry(family)
                        .and_modify(|current| {
                            if usage_severity(&candidate) > usage_severity(current) {
                                *current = candidate.clone();
                            }
                        })
                        .or_insert(candidate);
                }
                if routes.is_empty() {
                    routes.insert(ModelFamily::General, usage_status_from_account(account));
                }
                routes
            })
            .collect::<Vec<_>>();

        let provider_usage = usage.entry(provider).or_default();
        let mut family_keys = provider_usage.families.keys().copied().collect::<Vec<_>>();
        for routes in &account_routes {
            for family in routes.keys().copied() {
                if !family_keys.contains(&family) {
                    family_keys.push(family);
                }
            }
        }
        if family_keys
            .iter()
            .any(|family| *family != ModelFamily::General)
        {
            family_keys.retain(|family| *family != ModelFamily::General);
        }

        for family in family_keys {
            let statuses = account_routes
                .iter()
                .filter_map(|routes| account_route_status_for_family(routes, family))
                .collect::<Vec<_>>();
            if !statuses.is_empty() {
                provider_usage
                    .families
                    .insert(family, aggregate_account_statuses(family, &statuses));
            }
        }
    }
}

fn limit_used_fraction(limit: &Value) -> Option<f64> {
    if let Some(used) = limit
        .pointer("/amount/usedFraction")
        .and_then(Value::as_f64)
    {
        return Some(used);
    }
    let amount = limit.get("amount")?;
    let used = amount.get("used").and_then(Value::as_f64);
    let limit_value = amount.get("limit").and_then(Value::as_f64);
    if let (Some(used), Some(limit_value)) = (used, limit_value) {
        if limit_value > 0.0 {
            return Some(used / limit_value);
        }
    }
    amount
        .get("remainingFraction")
        .and_then(Value::as_f64)
        .map(|remaining| 1.0 - remaining)
}
impl ModelFamily {
    fn label(self) -> &'static str {
        match self {
            Self::Google => "Google",
            Self::Anthropic => "Anthropic",
            Self::AnthropicOpus => "Anthropic Opus",
            Self::AnthropicSonnet => "Anthropic Sonnet",
            Self::AnthropicFable => "Anthropic Fable",
            Self::AnthropicMythos => "Anthropic Mythos",
            Self::OpenAi => "OpenAI",
            Self::OpenAiSpark => "OpenAI Spark",
            Self::General => "Provider",
        }
    }

    fn anthropic_base(self) -> Option<Self> {
        matches!(
            self,
            Self::AnthropicOpus
                | Self::AnthropicSonnet
                | Self::AnthropicFable
                | Self::AnthropicMythos
        )
        .then_some(Self::Anthropic)
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
    let mut reports_by_provider = HashMap::<String, Vec<HashMap<ModelFamily, UsageStatus>>>::new();
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
                let family = usage_family(provider, limit);
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
        reports_by_provider
            .entry(provider.to_owned())
            .or_default()
            .push(account);
    }

    reports_by_provider
        .into_iter()
        .map(|(provider, account_reports)| {
            let mut family_keys = Vec::<ModelFamily>::new();
            for account in &account_reports {
                for family in account.keys().copied() {
                    if !family_keys.contains(&family) {
                        family_keys.push(family);
                    }
                }
            }
            let families = family_keys
                .into_iter()
                .filter_map(|family| {
                    let statuses = account_reports
                        .iter()
                        .filter_map(|account| account_status_for_family(account, family))
                        .collect::<Vec<_>>();
                    (!statuses.is_empty())
                        .then(|| (family, aggregate_account_statuses(family, &statuses)))
                })
                .collect();
            (provider, ProviderUsage { families })
        })
        .collect()
}

fn account_status_for_family(
    account: &HashMap<ModelFamily, UsageStatus>,
    family: ModelFamily,
) -> Option<UsageStatus> {
    let exact = account.get(&family).cloned();
    let base = family
        .anthropic_base()
        .and_then(|base_family| account.get(&base_family).cloned());
    match (exact, base) {
        (Some(exact), Some(base)) => {
            if usage_severity(&base) > usage_severity(&exact) {
                Some(base)
            } else {
                Some(exact)
            }
        }
        (Some(exact), None) => Some(exact),
        (None, Some(base)) => Some(base),
        (None, None) => None,
    }
}

fn anthropic_tier_family(value: &str) -> Option<ModelFamily> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.contains("opus") {
        Some(ModelFamily::AnthropicOpus)
    } else if normalized.contains("sonnet") {
        Some(ModelFamily::AnthropicSonnet)
    } else if normalized.contains("fable") {
        Some(ModelFamily::AnthropicFable)
    } else if normalized.contains("mythos") {
        Some(ModelFamily::AnthropicMythos)
    } else {
        None
    }
}

fn usage_family(provider: &str, limit: &Value) -> ModelFamily {
    if provider == "anthropic" {
        if let Some(tier) = limit.pointer("/scope/tier").and_then(Value::as_str) {
            if let Some(family) = anthropic_tier_family(tier) {
                return family;
            }
        }
    }
    let label = limit
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let id = limit.get("id").and_then(Value::as_str).unwrap_or_default();
    let value = format!("{label} {id}").to_ascii_lowercase();
    if provider == "anthropic" {
        if let Some(family) = anthropic_tier_family(&value) {
            return family;
        }
    }
    if value.contains("spark") {
        ModelFamily::OpenAiSpark
    } else if value.contains("anthropic") || value.contains("claude") || provider == "anthropic" {
        ModelFamily::Anthropic
    } else if value.contains("openai") || value.contains("gpt") || provider == "openai-codex" {
        ModelFamily::OpenAi
    } else if value.contains("google") || value.contains("gemini") || provider.contains("gemini") {
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
    let used = limit_used_fraction(limit).unwrap_or(0.0).clamp(0.0, 1.0);
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
        let status = if statuses.iter().any(|status| status.status == "auth-error") {
            "auth-error"
        } else {
            "exhausted"
        };
        return UsageStatus {
            available: false,
            status: status.to_owned(),
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
        let status = if usage
            .families
            .values()
            .any(|status| status.status == "auth-error")
        {
            "auth-error"
        } else {
            "exhausted"
        };
        return UsageStatus {
            available: false,
            status: status.to_owned(),
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
    if id.contains("spark") {
        ModelFamily::OpenAiSpark
    } else if id.contains("fable") {
        ModelFamily::AnthropicFable
    } else if id.contains("mythos") {
        ModelFamily::AnthropicMythos
    } else if id.contains("opus") {
        ModelFamily::AnthropicOpus
    } else if id.contains("sonnet") {
        ModelFamily::AnthropicSonnet
    } else if id.starts_with("claude-") {
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
    let family = model_family(model);
    provider
        .families
        .get(&family)
        .or_else(|| {
            family
                .anthropic_base()
                .and_then(|base_family| provider.families.get(&base_family))
        })
        .or_else(|| provider.families.get(&ModelFamily::General))
        .cloned()
        .or_else(|| (family == ModelFamily::General).then(|| summarize_provider_usage(provider)))
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

fn selector_identity(selector: &str) -> String {
    strip_thinking(selector.trim()).to_ascii_lowercase()
}

fn selector_thinking_rank(selector: &str) -> u8 {
    match selector.rsplit_once(':').map(|(_, level)| level) {
        Some("off") => 0,
        Some("minimal") => 1,
        Some("low") => 2,
        Some("medium") => 3,
        Some("high") => 4,
        Some("xhigh") => 5,
        Some("max") => 6,
        _ => 0,
    }
}

fn selector_exists(
    selector: &str,
    roles: &BTreeMap<String, String>,
    models: &[OmpModelInfo],
) -> bool {
    let base = selector_identity(selector);
    if base == "*" {
        return true;
    }
    if let Some(role) = base.strip_prefix('@') {
        return roles.contains_key(role) || KNOWN_ROLES.contains(&role);
    }
    if roles.contains_key(&base) || KNOWN_ROLES.contains(&base.as_str()) {
        return true;
    }
    if let Some(provider) = base.strip_suffix("/*") {
        return models
            .iter()
            .any(|model| model.provider.eq_ignore_ascii_case(provider));
    }
    models.iter().any(|model| {
        model.selector.eq_ignore_ascii_case(&base) || model.id.eq_ignore_ascii_case(&base)
    })
}

fn fallback_target(
    selector: &str,
    roles: &BTreeMap<String, String>,
    chains: &BTreeMap<String, Vec<String>>,
) -> Option<String> {
    let base = selector_identity(selector);
    let direct = base.strip_prefix('@').unwrap_or(&base);
    if chains.contains_key(direct) {
        return Some(direct.to_owned());
    }
    roles.iter().find_map(|(role, primary)| {
        (chains.contains_key(role) && selector_identity(primary) == base).then(|| role.clone())
    })
}

fn fallback_graph_has_cycle(
    node: &str,
    graph: &BTreeMap<String, Vec<String>>,
    visiting: &mut BTreeSet<String>,
    visited: &mut BTreeSet<String>,
) -> bool {
    if visiting.contains(node) {
        return true;
    }
    if visited.contains(node) {
        return false;
    }
    visiting.insert(node.to_owned());
    let cycle = graph
        .get(node)
        .into_iter()
        .flatten()
        .any(|target| fallback_graph_has_cycle(target, graph, visiting, visited));
    visiting.remove(node);
    visited.insert(node.to_owned());
    cycle
}

fn build_model_config_warnings(
    roles: &BTreeMap<String, String>,
    chains: &BTreeMap<String, Vec<String>>,
    models: &[OmpModelInfo],
) -> Vec<OmpConfigWarning> {
    let mut warnings = Vec::new();
    let mut push = |code: &str, message: String| {
        warnings.push(OmpConfigWarning {
            source: "model-config".to_owned(),
            code: code.to_owned(),
            message,
        });
    };

    if let (Some(default), Some(slow)) = (roles.get("default"), roles.get("slow")) {
        if selector_identity(default) == selector_identity(slow)
            && selector_thinking_rank(default) == selector_thinking_rank(slow)
        {
            push(
                "default_equals_slow",
                "Роли default и slow используют один selector и не различаются по глубине"
                    .to_owned(),
            );
        }
    }
    if let Some(default) = roles.get("default") {
        for role in ["smol", "tiny"] {
            let Some(selector) = roles.get(role) else {
                continue;
            };
            if selector_identity(selector) == selector_identity(default)
                && selector_thinking_rank(selector) >= selector_thinking_rank(default)
            {
                push(
                    "light_role_not_lighter",
                    format!("Роль {role} не легче default: {selector}"),
                );
            }
        }
    }

    let mut graph = BTreeMap::<String, Vec<String>>::new();
    for (key, selectors) in chains {
        let mut seen = BTreeSet::new();
        let primary = roles.get(key).map(|selector| selector_identity(selector));
        let mut targets = Vec::new();
        for selector in selectors {
            let identity = selector_identity(selector);
            if !seen.insert(identity.clone()) {
                push(
                    "fallback_duplicate",
                    format!("Fallback-цепочка {key} повторяет selector {selector}"),
                );
            }
            if primary.as_deref() == Some(identity.as_str()) {
                push(
                    "fallback_repeats_primary",
                    format!("Fallback-цепочка {key} повторяет primary selector {selector}"),
                );
            }
            if !selector_exists(selector, roles, models) {
                push(
                    "fallback_missing_model",
                    format!("Fallback-цепочка {key} ссылается на отсутствующую модель {selector}"),
                );
            }
            if let Some(target) = fallback_target(selector, roles, chains) {
                targets.push(target);
            }
        }
        graph.insert(key.to_ascii_lowercase(), targets);
    }
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    if graph
        .keys()
        .any(|node| fallback_graph_has_cycle(node, &graph, &mut visiting, &mut visited))
    {
        push(
            "fallback_cycle",
            "Fallback-цепочки образуют цикл между ролями или primary selectors".to_owned(),
        );
    }
    warnings
}

fn validate_proxy_provider_membership(
    providers: &[String],
    previous_providers: &[String],
    models: &[OmpModelInfo],
) -> Result<Vec<OmpConfigWarning>, String> {
    if providers.is_empty() {
        return Ok(Vec::new());
    }
    if models.is_empty() {
        diagnostics::warn(
            "settings.proxy_providers",
            "membership unverified: model catalog unavailable",
        );
        return Ok(vec![OmpConfigWarning {
            source: "settings.proxy_providers".to_owned(),
            code: "proxy_provider_membership_unverified".to_owned(),
            message: "Принадлежность proxy providers не проверена: каталог моделей OMP недоступен"
                .to_owned(),
        }]);
    }

    let known = models
        .iter()
        .map(|model| model.provider.as_str())
        .collect::<BTreeSet<_>>();
    let previous = previous_providers
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let mut added_unknown = Vec::new();
    let mut retained_unknown = Vec::new();
    for provider in providers {
        if known.contains(provider.as_str()) {
            continue;
        }
        if previous.contains(provider.as_str()) {
            retained_unknown.push(provider.as_str());
        } else {
            added_unknown.push(provider.as_str());
        }
    }
    if !added_unknown.is_empty() {
        return Err(format!(
            "Новые proxy providers отсутствуют в текущем списке моделей OMP: {}",
            added_unknown.join(", ")
        ));
    }
    if retained_unknown.is_empty() {
        return Ok(Vec::new());
    }

    let message = format!(
        "Сохранённые proxy providers отсутствуют в текущем списке моделей OMP: {}",
        retained_unknown.join(", ")
    );
    diagnostics::warn("settings.proxy_providers", &message);
    Ok(vec![OmpConfigWarning {
        source: "settings.proxy_providers".to_owned(),
        code: "proxy_provider_membership_stale".to_owned(),
        message,
    }])
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

pub(crate) fn valid_selector_segment(value: &str) -> bool {
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
    run_omp_text(
        executable,
        &["config", "set", key, &rendered],
        env_map,
        OmpOperation::Config,
    )
    .map(|_| ())
    .map_err(|error| format!("Не удалось сохранить `{key}`: {error}"))
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
        let credentials = build_credentials_from_sources(
            yaml,
            &provider_env,
            &models,
            &HashMap::new(),
            &BTreeSet::new(),
            |key| key == "G2A_API_KEY",
        );
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
        assert!(get("a6api").custom);
        assert_eq!(get("rdsh").key_name, None);
        assert!(!format!("{credentials:?}").contains("secret_token_12345"));
    }

    #[test]
    fn disabled_provider_updates_preserve_path_scopes() {
        let scoped = serde_json::json!({
            "path": "~/projects/sensitive",
            "providers": ["anthropic"]
        });
        let providers = normalize_disabled_providers(vec!["Existing-Gateway".to_owned()])
            .expect("existing mixed-case IDs should be accepted");
        let merged = merge_disabled_provider_entries(
            &[Value::String("old-provider".to_owned()), scoped.clone()],
            &providers,
        );
        assert_eq!(
            merged,
            Value::Array(vec![scoped, Value::String("Existing-Gateway".to_owned())])
        );
    }

    #[test]
    fn referenced_custom_provider_cannot_be_deleted() {
        let removed = BTreeSet::from(["Existing-Gateway".to_owned()]);
        let roles = BTreeMap::from([(
            "default".to_owned(),
            "Existing-Gateway/model:high".to_owned(),
        )]);
        let chains = BTreeMap::from([(
            "slow".to_owned(),
            vec!["Existing-Gateway/fallback:high".to_owned()],
        )]);
        assert!(validate_removed_provider_references(&removed, &roles, &BTreeMap::new()).is_err());
        assert!(validate_removed_provider_references(&removed, &BTreeMap::new(), &chains).is_err());
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
    fn proxy_provider_membership_allows_unavailable_catalog_with_warning() {
        let warnings = validate_proxy_provider_membership(&["codex-lb".to_owned()], &[], &[])
            .expect("unavailable catalog must not block settings save");

        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].code, "proxy_provider_membership_unverified");
    }

    #[test]
    fn proxy_provider_membership_warns_for_retained_unknown_provider() {
        let models = vec![model("gateway", "fallback")];
        let warnings = validate_proxy_provider_membership(
            &["retired".to_owned()],
            &["retired".to_owned()],
            &models,
        )
        .expect("a previously saved provider must not block unrelated settings changes");

        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].code, "proxy_provider_membership_stale");
    }

    #[test]
    fn proxy_provider_membership_rejects_new_unknown_provider() {
        let models = vec![model("gateway", "fallback")];
        let error = validate_proxy_provider_membership(&["missing".to_owned()], &[], &models)
            .expect_err("a newly added provider must exist in the current model catalog");

        assert!(error.contains("missing"));
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
    fn model_config_warnings_detect_weight_missing_duplicates_and_cycles() {
        let roles = BTreeMap::from([
            ("default".to_owned(), "codex-lb/gpt-5.6-sol:max".to_owned()),
            ("slow".to_owned(), "codex-lb/gpt-5.6-sol:max".to_owned()),
            ("smol".to_owned(), "codex-lb/gpt-5.6-sol:max".to_owned()),
            (
                "advisor".to_owned(),
                "google-antigravity/gemini-3.8-flash:high".to_owned(),
            ),
        ]);
        let chains = BTreeMap::from([
            ("default".to_owned(), vec!["@advisor".to_owned()]),
            (
                "advisor".to_owned(),
                vec![
                    "google-antigravity/gemini-3.8-flash:high".to_owned(),
                    "retired/model:high".to_owned(),
                    "retired/model:low".to_owned(),
                    "@default".to_owned(),
                ],
            ),
        ]);
        let models = vec![
            model("codex-lb", "gpt-5.6-sol"),
            model("google-antigravity", "gemini-3.8-flash"),
        ];

        let codes = build_model_config_warnings(&roles, &chains, &models)
            .into_iter()
            .map(|warning| warning.code)
            .collect::<BTreeSet<_>>();

        for expected in [
            "default_equals_slow",
            "light_role_not_lighter",
            "fallback_repeats_primary",
            "fallback_missing_model",
            "fallback_duplicate",
            "fallback_cycle",
        ] {
            assert!(codes.contains(expected), "missing warning {expected}");
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

    #[test]
    fn anthropic_shared_and_tier_limits_stay_correlated_per_account() {
        let usage = parse_usage_reports(&serde_json::json!({
            "reports": [
                {"provider": "anthropic", "limits": [
                    {"id": "anthropic:5h", "label": "Claude 5 Hour", "scope": {"shared": true}, "amount": {"usedFraction": 1.0}, "status": "exhausted"},
                    {"id": "anthropic:7d:fable", "label": "Claude 7 Day (Fable)", "scope": {"tier": "fable"}, "amount": {"usedFraction": 0.2}, "status": "ok"}
                ]},
                {"provider": "anthropic", "limits": [
                    {"id": "anthropic:5h", "label": "Claude 5 Hour", "scope": {"shared": true}, "amount": {"usedFraction": 0.2}, "status": "ok"},
                    {"id": "anthropic:7d:fable", "label": "Claude 7 Day (Fable)", "scope": {"tier": "fable"}, "amount": {"usedFraction": 1.0}, "status": "exhausted"}
                ]}
            ]
        }));
        let mut models = vec![
            model("anthropic", "claude-fable-4-5"),
            model("anthropic", "claude-opus-4-6"),
        ];

        apply_usage_to_models(&mut models, &usage);

        assert!(!models[0].available);
        assert_eq!(models[0].status, "exhausted");
        assert!(models[1].available);
        assert_eq!(models[1].status, "ok");
    }

    #[test]
    fn account_snapshot_keeps_chat_and_spark_health_separate() {
        let snapshot = parse_usage_snapshot(&serde_json::json!({
            "generatedAt": 1_900_000_000_000_u64,
            "reports": [{
                "provider": "openai-codex",
                "fetchedAt": 1_899_999_900_000_u64,
                "metadata": {"email": "account@example.test"},
                "limits": [
                    {
                        "id": "openai-codex:chat:5h",
                        "label": "ChatGPT",
                        "status": "exhausted",
                        "amount": {"usedFraction": 1.0}
                    },
                    {
                        "id": "openai-codex:spark:5h",
                        "label": "Spark",
                        "status": "ok",
                        "amount": {"usedFraction": 0.42},
                        "window": {"label": "5h", "resetsAt": 2_000_000_000_000_u64}
                    }
                ]
            }]
        }));

        assert_eq!(snapshot.accounts.len(), 1);
        assert_eq!(snapshot.observed_at, Some(1_900_000_000_000));
        let account = &snapshot.accounts[0];
        assert!(account.id.starts_with("usage-"));
        assert!(account.label.starts_with("acc***@example.test · "));
        assert_eq!(account.status, "limited");
        assert_eq!(account.routing_evidence, "usage");
        assert_eq!(account.credential_type, "unknown");
        assert_eq!(account.fetched_at, Some(1_899_999_900_000));
        assert_eq!(account.limits.len(), 2);
        assert_eq!(account.limits[1].used_percent, Some(42.0));
        assert_eq!(account.limits[1].resets_at, Some(2_000_000_000_000));
        assert_eq!(account.routes.len(), 2);
        assert!(!account.routes[0].routing_eligible);
        assert!(account.routes[1].routing_eligible);

        let mut models = vec![
            model("openai-codex", "gpt-5.3-codex"),
            model("openai-codex", "gpt-5.3-codex-spark"),
        ];
        apply_usage_to_models(&mut models, &snapshot.providers);
        assert!(!models[0].available);
        assert_eq!(models[0].status, "exhausted");
        assert!(models[1].available);
        assert_eq!(models[1].status, "ok");
    }

    #[test]
    fn usage_contract_synthesizes_safe_account_cards() {
        let value = serde_json::json!({
            "generatedAt": 1_900_000_000_000_u64,
            "reports": [{
                "provider": "google-antigravity",
                "fetchedAt": 1_899_999_900_000_u64,
                "metadata": {
                    "email": "worker@example.test",
                    "projectId": "alpha-project"
                },
                "limits": [
                    {
                        "id": "google-antigravity:google:default:weekly",
                        "label": "Usage (Google)",
                        "status": "exhausted",
                        "amount": {"usedFraction": 1.0},
                        "window": {"label": "Weekly", "resetsAt": 2_000_000_000_000_u64}
                    },
                    {
                        "id": "google-antigravity:google:default:daily",
                        "label": "Usage (Google)",
                        "status": "ok",
                        "amount": {"usedFraction": 0.0},
                        "window": {"label": "Daily"}
                    },
                    {
                        "id": "google-antigravity:openai:default:weekly",
                        "label": "Usage (OpenAI)",
                        "status": "warning",
                        "amount": {"usedFraction": 0.96},
                        "window": {"label": "Weekly"}
                    },
                    {
                        "id": "google-antigravity:anthropic:default:daily",
                        "label": "Usage (Anthropic)",
                        "status": "ok",
                        "amount": {"usedFraction": 0.2},
                        "window": {"label": "Daily"}
                    }
                ]
            }],
            "accountsWithoutUsage": [{
                "provider": "anthropic",
                "type": "oauth",
                "email": "idle@example.test"
            }],
            "disabledCredentials": [
                {
                    "id": 4,
                    "provider": "google-gemini-cli",
                    "type": "oauth",
                    "email": "gone@example.test",
                    "cause": "oauth refresh failed: secret upstream response",
                    "disabledAtMs": 1_899_000_000_000_u64
                },
                {
                    "id": 9,
                    "provider": "mcp_oauth:profile:default:https://example.test/mcp",
                    "type": "oauth",
                    "cause": "revoked"
                }
            ]
        });

        let snapshot = parse_usage_snapshot(&value);
        assert_eq!(snapshot.observed_at, Some(1_900_000_000_000));
        assert_eq!(snapshot.accounts.len(), 3);

        let active = snapshot
            .accounts
            .iter()
            .find(|account| account.provider == "google-antigravity")
            .expect("active account");
        assert!(active.label.starts_with("wor***@example.test · "));
        assert_eq!(active.routing_evidence, "usage");
        assert_eq!(active.status, "limited");
        assert!(active.routing_eligible);
        assert_eq!(active.limits.len(), 4);
        let google = active
            .routes
            .iter()
            .find(|route| route.id == "counter:google")
            .expect("Google route");
        assert_eq!(google.status, "exhausted");
        assert!(!google.routing_eligible);
        let openai = active
            .routes
            .iter()
            .find(|route| route.id == "counter:openai")
            .expect("OpenAI route");
        assert_eq!(openai.status, "limited");
        assert!(openai.routing_eligible);

        let unreported = snapshot
            .accounts
            .iter()
            .find(|account| account.provider == "anthropic")
            .expect("unreported account");
        assert_eq!(unreported.routing_evidence, "unknown");
        assert!(!unreported.routing_eligible);
        assert!(!unreported.reporting);

        let disabled = snapshot
            .accounts
            .iter()
            .find(|account| account.provider == "google-gemini-cli")
            .expect("disabled account");
        assert_eq!(disabled.status, "disabled");
        assert_eq!(disabled.routing_evidence, "reported");
        assert!(!disabled.configured);

        let serialized = serde_json::to_string(&snapshot.accounts).expect("serialize accounts");
        for secret in [
            "worker@example.test",
            "idle@example.test",
            "gone@example.test",
            "alpha-project",
            "secret upstream response",
        ] {
            assert!(
                !serialized.contains(secret),
                "sensitive value leaked into account snapshot"
            );
        }

        let repeated = parse_usage_snapshot(&value);
        assert_eq!(snapshot.accounts[0].id, repeated.accounts[0].id);
    }

    #[test]
    fn usage_identity_keeps_projects_and_organizations_distinct() {
        let limit = serde_json::json!({
            "id": "google-antigravity:google:default:daily",
            "label": "Usage (Google)",
            "status": "ok",
            "amount": {"usedFraction": 0.1}
        });
        let snapshot = parse_usage_snapshot(&serde_json::json!({
            "reports": [
                {
                    "provider": "google-antigravity",
                    "metadata": {"email": "same@example.test", "projectId": "project-a", "orgId": "org-a"},
                    "limits": [limit.clone()]
                },
                {
                    "provider": "google-antigravity",
                    "metadata": {"email": "same@example.test", "projectId": "project-b", "orgId": "org-a"},
                    "limits": [limit.clone()]
                },
                {
                    "provider": "google-antigravity",
                    "metadata": {"email": "same@example.test", "projectId": "project-a", "orgId": "org-b"},
                    "limits": [limit]
                }
            ]
        }));

        assert_eq!(snapshot.accounts.len(), 3);
        let ids = snapshot
            .accounts
            .iter()
            .map(|account| account.id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(ids.len(), 3);
        let serialized = serde_json::to_string(&snapshot.accounts).expect("serialize accounts");
        for identity in [
            "same@example.test",
            "project-a",
            "project-b",
            "org-a",
            "org-b",
        ] {
            assert!(
                !serialized.contains(identity),
                "raw identity leaked into account snapshot"
            );
        }
    }
}
