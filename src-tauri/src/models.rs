use serde::{Deserialize, Deserializer, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    fmt,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub details: Option<String>,
}

impl AppError {
    pub fn from_internal(default_code: &str, message: &str, error: String) -> Self {
        let (code, details) = parse_internal_error_code(default_code, &error);
        Self {
            code,
            message: message.to_owned(),
            details: Some(details),
        }
    }

    pub fn join(operation: &str, error: impl std::fmt::Display) -> Self {
        Self {
            code: "backend_join_failed".to_owned(),
            message: format!("Не удалось дождаться {operation}"),
            details: Some(error.to_string()),
        }
    }
}

fn parse_internal_error_code(default_code: &str, error: &str) -> (String, String) {
    let Some(rest) = error.strip_prefix('[') else {
        return (default_code.to_owned(), error.to_owned());
    };
    let Some((code, details)) = rest.split_once("] ") else {
        return (default_code.to_owned(), error.to_owned());
    };
    if code.is_empty()
        || !code
            .chars()
            .all(|character| character.is_ascii_lowercase() || character == '_')
    {
        return (default_code.to_owned(), error.to_owned());
    }
    (code.to_owned(), details.to_owned())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsWarning {
    pub code: String,
    pub message: String,
    pub details: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub omp_executable: Option<String>,
    #[serde(default)]
    pub session_root: Option<String>,
    #[serde(default)]
    pub recent_workspaces: Vec<String>,
    #[serde(default)]
    pub session_title_pins: BTreeMap<String, String>,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default = "default_app_font_family")]
    pub app_font_family: String,
    #[serde(default = "default_terminal_font_family")]
    pub terminal_font_family: String,
    #[serde(default = "default_terminal_font_size")]
    pub terminal_font_size: u16,
    /// Secret values exist only in backend memory and are never serialized to disk or IPC.
    #[serde(default, skip_serializing)]
    pub provider_env: HashMap<String, String>,
    #[serde(default)]
    pub provider_env_keys: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_storage_warning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_warning: Option<SettingsWarning>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            omp_executable: None,
            session_root: None,
            recent_workspaces: Vec::new(),
            session_title_pins: BTreeMap::new(),
            language: default_language(),
            app_font_family: default_app_font_family(),
            provider_env: HashMap::new(),
            provider_env_keys: Vec::new(),
            terminal_font_family: default_terminal_font_family(),
            terminal_font_size: default_terminal_font_size(),
            secret_storage_warning: None,
            settings_warning: None,
        }
    }
}

impl fmt::Debug for AppSettings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AppSettings")
            .field("omp_executable", &self.omp_executable)
            .field("session_root", &self.session_root)
            .field("recent_workspaces", &self.recent_workspaces)
            .field("session_title_pin_count", &self.session_title_pins.len())
            .field("language", &self.language)
            .field("app_font_family", &self.app_font_family)
            .field("provider_env_keys", &self.provider_env_keys)
            .field("terminal_font_family", &self.terminal_font_family)
            .field("terminal_font_size", &self.terminal_font_size)
            .field("provider_env_value_count", &self.provider_env.len())
            .field("secret_storage_warning", &self.secret_storage_warning)
            .field("settings_warning", &self.settings_warning)
            .finish()
    }
}

fn default_language() -> String {
    "ru".to_owned()
}

pub const DEFAULT_APP_FONT_FAMILY: &str =
    "Inter, \"Segoe UI Variable\", \"Segoe UI\", system-ui, -apple-system, sans-serif";

pub const DEFAULT_TERMINAL_FONT_FAMILY: &str =
    "\"Cascadia Code\", \"Cascadia Mono\", \"JetBrains Mono\", \"Fira Code\", Consolas, monospace";
pub const DEFAULT_TERMINAL_FONT_SIZE: u16 = 14;

fn default_app_font_family() -> String {
    DEFAULT_APP_FONT_FAMILY.to_owned()
}

fn default_terminal_font_family() -> String {
    DEFAULT_TERMINAL_FONT_FAMILY.to_owned()
}

fn default_terminal_font_size() -> u16 {
    DEFAULT_TERMINAL_FONT_SIZE
}

#[derive(Clone, Default, PartialEq, Eq)]
pub enum SettingsPatch<T> {
    #[default]
    Missing,
    Set(Option<T>),
}

impl<'de, T> Deserialize<'de> for SettingsPatch<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Self::Set)
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    #[serde(default)]
    pub omp_executable: SettingsPatch<String>,
    #[serde(default)]
    pub session_root: SettingsPatch<String>,
    #[serde(default)]
    pub language: SettingsPatch<String>,
    #[serde(default)]
    pub app_font_family: SettingsPatch<String>,
    #[serde(default)]
    pub terminal_font_family: SettingsPatch<String>,
    #[serde(default)]
    pub terminal_font_size: SettingsPatch<u16>,
    #[serde(default)]
    pub provider_env: SettingsPatch<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub platform: String,
    pub arch: String,
    pub omp_available: bool,
    pub omp_executable: String,
    pub omp_version: Option<String>,
    pub session_root: String,
    pub language: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub pinned_title: Option<String>,
    pub cwd: String,
    pub file_path: String,
    pub created_at: String,
    pub updated_at: u64,
    pub model: Option<String>,
    pub thinking_level: Option<String>,
    pub configured_thinking_level: Option<String>,
    pub source: String,
    pub has_messages: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub path: String,
    pub name: String,
    pub session_count: usize,
    pub last_active: u64,
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapPayload {
    pub settings: AppSettings,
    pub runtime: RuntimeInfo,
    pub workspaces: Vec<WorkspaceSummary>,
    pub sessions: Vec<SessionSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpModelInfo {
    pub provider: String,
    pub id: String,
    pub selector: String,
    pub name: String,
    pub available: bool,
    pub status: String,
    pub detail: Option<String>,
    pub thinking: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpRoleInfo {
    pub role: String,
    pub selector: String,
    pub model: Option<OmpModelInfo>,
    pub available: bool,
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpCredentialInfo {
    pub provider: String,
    pub key_name: Option<String>,
    pub source: String,
    pub status: String,
    pub available: bool,
    pub model_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpConfigWarning {
    pub source: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpConfigSnapshot {
    pub roles: Vec<OmpRoleInfo>,
    pub models: Vec<OmpModelInfo>,
    pub advisor_enabled: bool,
    pub auto_resume: bool,
    pub default_thinking_level: Option<String>,
    pub model_fallback_enabled: bool,
    pub fallback_chains: BTreeMap<String, Vec<String>>,
    pub provider_env_keys: Vec<String>,
    pub credentials: Vec<OmpCredentialInfo>,
    pub warnings: Vec<OmpConfigWarning>,
    pub raw: serde_json::Value,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpConfigSaveRequest {
    pub roles: HashMap<String, String>,
    pub advisor_enabled: Option<bool>,
    pub auto_resume: Option<bool>,
    pub default_thinking_level: Option<String>,
    pub model_fallback_enabled: Option<bool>,
    pub fallback_chains: Option<HashMap<String, Vec<String>>>,
    pub provider_env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpUpdateInfo {
    pub has_update: bool,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSessionSummary {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub file_path: String,
    pub created_at: String,
    pub updated_at: u64,
    pub model: Option<String>,
    pub preview: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptEntryCategory {
    Dialogue,
    Service,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptEntry {
    pub id: String,
    pub timestamp: String,
    pub role: String,
    pub text: String,
    pub dialogue_text: Option<String>,
    pub category: TranscriptEntryCategory,
    pub kind: Option<String>,

    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTranscript {
    pub session: SessionSummary,
    pub entries: Vec<TranscriptEntry>,
    pub updated_at: u64,
}

#[cfg(test)]
mod tests {
    use super::{AppSettings, SettingsPatch, SettingsUpdate, DEFAULT_APP_FONT_FAMILY};

    #[test]
    fn app_settings_never_serialize_provider_secret_values() {
        let mut settings = AppSettings::default();
        settings.provider_env.insert(
            "OPENAI_API_KEY".to_owned(),
            "secret-value-that-must-not-leave-rust".to_owned(),
        );
        settings.provider_env_keys = vec!["OPENAI_API_KEY".to_owned()];

        let serialized = serde_json::to_string(&settings).expect("settings should serialize");
        let debug = format!("{settings:?}");
        assert!(!serialized.contains("secret-value-that-must-not-leave-rust"));
        assert!(!serialized.contains("providerEnv\""));
        assert!(serialized.contains("providerEnvKeys"));
        assert!(!debug.contains("secret-value-that-must-not-leave-rust"));
    }

    #[test]
    fn legacy_provider_env_is_read_but_removed_on_reserialize() {
        let settings: AppSettings = serde_json::from_value(serde_json::json!({
            "providerEnv": {"A6API_KEY": "legacy-secret"}
        }))
        .expect("legacy settings should deserialize");
        assert_eq!(
            settings.provider_env.get("A6API_KEY").map(String::as_str),
            Some("legacy-secret")
        );
        assert_eq!(settings.app_font_family, DEFAULT_APP_FONT_FAMILY);

        let serialized = serde_json::to_string(&settings).expect("settings should serialize");
        assert!(!serialized.contains("legacy-secret"));
        assert!(!serialized.contains("providerEnv\""));
    }

    #[test]
    fn session_title_pins_survive_settings_round_trip() {
        let mut settings = AppSettings::default();
        settings.session_title_pins.insert(
            "c:/sessions/session.jsonl".to_owned(),
            "Fixed project name".to_owned(),
        );

        let serialized = serde_json::to_string(&settings).expect("settings should serialize");
        let restored: AppSettings =
            serde_json::from_str(&serialized).expect("settings should deserialize");

        assert_eq!(restored.session_title_pins, settings.session_title_pins);
    }

    #[test]
    fn settings_update_distinguishes_missing_and_null_fields() {
        let missing: SettingsUpdate = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(matches!(missing.omp_executable, SettingsPatch::Missing));
        assert!(matches!(missing.session_root, SettingsPatch::Missing));
        assert!(matches!(missing.app_font_family, SettingsPatch::Missing));

        let patch: SettingsUpdate = serde_json::from_value(serde_json::json!({
            "ompExecutable": null,
            "sessionRoot": "D:/sessions",
            "language": "en",
            "appFontFamily": "\"Segoe UI Variable\", sans-serif"
        }))
        .unwrap();
        assert!(matches!(patch.omp_executable, SettingsPatch::Set(None)));
        assert!(
            matches!(patch.session_root, SettingsPatch::Set(Some(value)) if value == "D:/sessions")
        );
        assert!(matches!(patch.language, SettingsPatch::Set(Some(value)) if value == "en"));
        assert!(
            matches!(patch.app_font_family, SettingsPatch::Set(Some(value)) if value == "\"Segoe UI Variable\", sans-serif")
        );
    }
}
