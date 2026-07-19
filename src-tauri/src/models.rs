use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub omp_executable: Option<String>,
    #[serde(default)]
    pub session_root: Option<String>,
    #[serde(default)]
    pub recent_workspaces: Vec<String>,
    #[serde(default = "default_language")]
    pub language: String,
    /// Provider env keys injected into OMP PTY processes. Values stay local.
    #[serde(default)]
    pub provider_env: HashMap<String, String>,
}

fn default_language() -> String {
    "ru".to_owned()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    pub omp_executable: Option<String>,
    pub session_root: Option<String>,
    pub language: Option<String>,
    pub provider_env: Option<HashMap<String, String>>,
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
    pub cwd: String,
    pub file_path: String,
    pub created_at: String,
    pub updated_at: u64,
    pub model: Option<String>,
    pub source: String,
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
pub struct OmpConfigSnapshot {
    pub roles: Vec<OmpRoleInfo>,
    pub models: Vec<OmpModelInfo>,
    pub advisor_enabled: bool,
    pub auto_resume: bool,
    pub default_thinking_level: Option<String>,
    pub provider_env_keys: Vec<String>,
    pub raw: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpConfigSaveRequest {
    pub roles: HashMap<String, String>,
    pub advisor_enabled: Option<bool>,
    pub auto_resume: Option<bool>,
    pub default_thinking_level: Option<String>,
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
