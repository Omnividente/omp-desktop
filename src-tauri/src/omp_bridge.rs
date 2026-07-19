use crate::{
    models::{
        AppSettings, OmpConfigSaveRequest, OmpConfigSnapshot, OmpModelInfo, OmpRoleInfo,
        OmpUpdateInfo,
    },
    settings::{resolve_omp, SettingsState},
};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, HashMap},
    process::Command,
};
use tauri::{AppHandle, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const KNOWN_ROLES: &[&str] = &[
    "default", "smol", "slow", "plan", "advisor", "task", "designer", "vision", "commit", "tiny",
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

    Ok(OmpConfigSnapshot {
        roles,
        models,
        advisor_enabled: extract_bool(&raw, "advisor.enabled").unwrap_or(false),
        auto_resume: extract_bool(&raw, "autoResume").unwrap_or(false),
        default_thinking_level: extract_string(&raw, "defaultThinkingLevel"),
        provider_env_keys: PROVIDER_ENV_KEYS.iter().map(|key| (*key).to_owned()).collect(),
        raw,
    })
}

pub fn save_config(
    app: &AppHandle,
    settings: &State<'_, SettingsState>,
    request: OmpConfigSaveRequest,
) -> Result<OmpConfigSnapshot, String> {
    let mut app_settings = settings
        .0
        .lock()
        .map_err(|_| "Настройки заблокированы после внутренней ошибки".to_owned())?
        .clone();
    let omp = resolve_omp(app, &app_settings);
    if omp.version.is_none() {
        return Err(format!("OMP не найден: {}", omp.executable));
    }

    if let Some(provider_env) = request.provider_env {
        app_settings.provider_env = provider_env
            .into_iter()
            .filter(|(key, value)| !key.trim().is_empty() && !value.trim().is_empty())
            .map(|(key, value)| (key.trim().to_owned(), value))
            .collect();
        crate::settings::save_settings(app, &app_settings)?;
        *settings
            .0
            .lock()
            .map_err(|_| "Настройки заблокированы после внутренней ошибки".to_owned())? =
            app_settings.clone();
    }

    let roles_value = Value::Object(
        request
            .roles
            .into_iter()
            .filter(|(_, selector)| !selector.trim().is_empty())
            .map(|(role, selector)| (role, Value::String(selector.trim().to_owned())))
            .collect::<Map<String, Value>>(),
    );
    set_omp_config(
        &omp.executable,
        "modelRoles",
        &roles_value,
        &app_settings.provider_env,
    )?;

    if let Some(enabled) = request.advisor_enabled {
        set_omp_config(
            &omp.executable,
            "advisor.enabled",
            &Value::Bool(enabled),
            &app_settings.provider_env,
        )?;
    }
    if let Some(enabled) = request.auto_resume {
        set_omp_config(
            &omp.executable,
            "autoResume",
            &Value::Bool(enabled),
            &app_settings.provider_env,
        )?;
    }
    if let Some(level) = request
        .default_thinking_level
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        set_omp_config(
            &omp.executable,
            "defaultThinkingLevel",
            &Value::String(level),
            &app_settings.provider_env,
        )?;
    }

    load_config_snapshot(app, &app_settings)
}

pub fn check_update(
    app: &AppHandle,
    settings: &State<'_, SettingsState>,
) -> Result<OmpUpdateInfo, String> {
    let app_settings = settings
        .0
        .lock()
        .map_err(|_| "Настройки заблокированы после внутренней ошибки".to_owned())?
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
    let current = omp
        .version
        .as_deref()
        .and_then(extract_version)
        .map(str::to_owned);
    let latest = output
        .lines()
        .find_map(|line| {
            let lower = line.to_ascii_lowercase();
            if lower.contains("new version") || lower.contains("latest") {
                extract_version(line).map(str::to_owned)
            } else {
                None
            }
        })
        .or_else(|| {
            output
                .lines()
                .rev()
                .find_map(|line| extract_version(line).map(str::to_owned))
        });

    let has_update = output.to_ascii_lowercase().contains("new version available")
        || match (&current, &latest) {
            (Some(current), Some(latest)) => current != latest,
            _ => false,
        };

    Ok(OmpUpdateInfo {
        has_update,
        current_version: current,
        latest_version: latest,
        message: output.trim().to_owned(),
    })
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
                let status = limit
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("ok");
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
        Some((base, "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto")) =>
        {
            base.to_owned()
        }
        _ => selector.to_owned(),
    }
}

fn extract_version(text: &str) -> Option<&str> {
    text.split_whitespace()
        .find(|part| part.chars().next().is_some_and(|ch| ch.is_ascii_digit()) && part.contains('.'))
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
    let _ = run_omp_text(executable, &["config", "set", key, &rendered], env_map)?;
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
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() && stdout.trim().is_empty() {
        return Err(stderr.trim().to_owned());
    }
    if !stdout.trim().is_empty() {
        Ok(stdout)
    } else {
        Ok(stderr)
    }
}
