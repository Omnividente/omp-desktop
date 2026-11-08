//! Desktop binary updates are owned here, not by JavaScript updater resources.
//! The settings mutation lock precedes this short-lived state lock. Never do IO under it.
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

const REPOSITORY: &str = "Omnividente/omp-desktop";
const RELEASES_URL: &str = "https://api.github.com/repos/Omnividente/omp-desktop/releases";
const EVENT: &str = "desktop-update-state";
const MAX_METADATA_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientUpdateInfo {
    pub candidate_id: String,
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
    pub prerelease: bool,
    pub release_id: String,
    pub release_url: String,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PolicyState {
    NotReady,
    Ready,
    Changing,
    Uncertain,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum InstallState {
    Idle,
    Downloading,
    Installing,
    Installed,
    Uncertain,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopUpdateStatus {
    pub policy_state: PolicyState,
    pub include_prereleases: Option<bool>,
    pub revision: String,
    pub checking: bool,
    pub install_state: InstallState,
    pub update: Option<ClientUpdateInfo>,
    pub installed: Option<ClientUpdateInfo>,
}

struct Candidate {
    info: ClientUpdateInfo,
    update: Arc<Update>,
}
struct InstallReservation {
    update: Arc<Update>,
    info: ClientUpdateInfo,
    policy_epoch: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CheckTicket {
    policy: u64,
    check: u64,
}

pub(crate) struct DesktopUpdaterState(Mutex<Broker>);
struct Broker {
    policy_state: PolicyState,
    include_prereleases: Option<bool>,
    revision: u64,
    policy_epoch: u64,
    check_epoch: u64,
    checking: bool,
    install_state: InstallState,
    candidate: Option<Candidate>,
    installed: Option<ClientUpdateInfo>,
}
impl Default for DesktopUpdaterState {
    fn default() -> Self {
        Self(Mutex::new(Broker::default()))
    }
}
impl Default for Broker {
    fn default() -> Self {
        Self {
            policy_state: PolicyState::NotReady,
            include_prereleases: None,
            revision: 0,
            policy_epoch: 0,
            check_epoch: 0,
            checking: false,
            install_state: InstallState::Idle,
            candidate: None,
            installed: None,
        }
    }
}
impl Broker {
    fn snapshot(&self) -> DesktopUpdateStatus {
        DesktopUpdateStatus {
            policy_state: self.policy_state,
            include_prereleases: self.include_prereleases,
            revision: self.revision.to_string(),
            checking: self.checking,
            install_state: self.install_state,
            update: self
                .candidate
                .as_ref()
                .map(|candidate| candidate.info.clone()),
            installed: self.installed.clone(),
        }
    }
    fn changed(&mut self) {
        self.revision += 1;
    }
    fn invalidate(&mut self) {
        self.policy_epoch += 1;
        self.check_epoch += 1;
        self.checking = false;
        self.candidate = None;
    }
    fn begin_policy(&mut self, channel: bool, force: bool) -> Result<bool, String> {
        if !force && self.policy_state == PolicyState::Uncertain {
            return Err(
                "Сначала необходимо прочитать фактически сохранённый канал Desktop".to_owned(),
            );
        }
        if !force
            && self.policy_state == PolicyState::Ready
            && self.include_prereleases == Some(channel)
        {
            return Ok(false);
        }
        if matches!(
            self.install_state,
            InstallState::Downloading | InstallState::Installing | InstallState::Uncertain
        ) {
            return Err(
                "Изменение канала заблокировано незавершённой установкой Desktop".to_owned(),
            );
        }
        self.invalidate();
        self.policy_state = PolicyState::Changing;
        self.include_prereleases = None;
        self.changed();
        Ok(true)
    }
    fn publish_policy(&mut self, channel: Option<bool>) {
        // Initialization/reconciliation may repeat a proven snapshot without retiring a valid offer.
        if self.policy_state == PolicyState::Ready && self.include_prereleases == channel {
            return;
        }
        self.invalidate();
        self.policy_state = if channel.is_some() {
            PolicyState::Ready
        } else {
            PolicyState::Uncertain
        };
        self.include_prereleases = channel;
        self.changed();
    }
    fn begin_check(&mut self) -> Result<Option<(CheckTicket, bool)>, String> {
        if self.policy_state != PolicyState::Ready {
            return Err("Канал обновлений ещё не подтверждён сохранёнными настройками".to_owned());
        }
        if self.install_state != InstallState::Idle {
            return Ok(None);
        }
        self.check_epoch += 1;
        self.candidate = None;
        self.checking = true;
        self.changed();
        Ok(Some((
            CheckTicket {
                policy: self.policy_epoch,
                check: self.check_epoch,
            },
            self.include_prereleases
                .expect("ready policy has a channel"),
        )))
    }
    fn accepts_check(&self, ticket: CheckTicket) -> bool {
        self.policy_state == PolicyState::Ready
            && self.install_state == InstallState::Idle
            && self.policy_epoch == ticket.policy
            && self.check_epoch == ticket.check
    }
    fn finish_check(&mut self, ticket: CheckTicket, candidate: Option<Candidate>) {
        if !self.accepts_check(ticket) {
            return;
        }
        self.checking = false;
        self.candidate = candidate;
        self.changed();
    }
    fn reserve_install(&mut self, id: &str) -> Result<Option<InstallReservation>, String> {
        if self.install_state == InstallState::Installed {
            return if self
                .installed
                .as_ref()
                .is_some_and(|info| info.candidate_id == id)
            {
                Ok(None)
            } else {
                Err("Другая версия Desktop уже установлена; перезапустите приложение".to_owned())
            };
        }
        if self.policy_state != PolicyState::Ready
            || self.install_state != InstallState::Idle
            || self.checking
        {
            return Err("Установка Desktop недоступна до завершения текущей операции".to_owned());
        }
        let candidate = self
            .candidate
            .as_ref()
            .filter(|candidate| candidate.info.candidate_id == id)
            .ok_or_else(|| {
                "Предложение обновления устарело; проверьте обновления повторно".to_owned()
            })?;
        if candidate.info.prerelease && self.include_prereleases != Some(true) {
            return Err("Предварительные версии Desktop не разрешены".to_owned());
        }
        let reserved = InstallReservation {
            update: Arc::clone(&candidate.update),
            info: candidate.info.clone(),
            policy_epoch: self.policy_epoch,
        };
        self.install_state = InstallState::Downloading;
        self.changed();
        Ok(Some(reserved))
    }
    fn download_failed(&mut self) {
        self.install_state = InstallState::Idle;
        self.changed();
    }
    fn begin_install(&mut self, policy_epoch: u64) -> Result<(), String> {
        // Read-only reconciliation can discover an externally changed/unknown policy while
        // bytes are downloading. An old reservation must not reach the installer.
        if self.install_state != InstallState::Downloading
            || self.policy_state != PolicyState::Ready
            || self.policy_epoch != policy_epoch
        {
            self.install_state = InstallState::Idle;
            self.candidate = None;
            self.changed();
            return Err("Канал изменился во время загрузки; установка не запускалась".to_owned());
        }
        self.install_state = InstallState::Installing;
        self.changed();
        Ok(())
    }
    fn finish_install(&mut self, info: ClientUpdateInfo, succeeded: bool) {
        self.candidate = None;
        self.install_state = if succeeded {
            InstallState::Installed
        } else {
            InstallState::Uncertain
        };
        if succeeded {
            self.installed = Some(info);
        }
        self.changed();
    }
}

fn with_broker<T>(app: &AppHandle, operation: impl FnOnce(&mut Broker) -> T) -> T {
    let state = app.state::<DesktopUpdaterState>();
    let mut broker = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let revision = broker.revision;
    let result = operation(&mut broker);
    if broker.revision != revision {
        // Emit in mutation order. Emission does not invoke frontend code synchronously.
        let _ = app.emit(EVENT, broker.snapshot());
    }
    result
}
pub(crate) fn status(app: &AppHandle) -> DesktopUpdateStatus {
    with_broker(app, |broker| broker.snapshot())
}

/// Called only while the settings mutation critical section is held, before persistence.
pub(crate) fn reserve_policy(app: &AppHandle, channel: bool, force: bool) -> Result<bool, String> {
    with_broker(app, |broker| broker.begin_policy(channel, force))
}
/// A generic persistence error is unknown, including errors after rename/fsync or failed rollback.
pub(crate) fn publish_policy(app: &AppHandle, channel: Option<bool>) {
    with_broker(app, |broker| broker.publish_policy(channel));
}

/// All persistence callers share the settings critical section. An unknown prior write must
/// be reconciled before an unrelated save can overwrite its possibly committed channel.
pub(crate) fn authorize_settings_write(app: &AppHandle, channel: bool) -> Result<(), String> {
    with_broker(app, |broker| {
        if broker.policy_state == PolicyState::Uncertain
            || (broker.policy_state == PolicyState::Ready
                && broker.include_prereleases != Some(channel))
        {
            Err("Канал Desktop не подтверждён; сохранение заблокировано до read-only reconciliation".to_owned())
        } else {
            Ok(())
        }
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ReleaseAsset {
    id: u64,
    name: String,
    state: String,
    size: u64,
    digest: String,
    content_type: String,
    browser_download_url: String,
    #[serde(rename = "url")]
    api_url: String,
}
impl ReleaseAsset {
    // Both addresses belong to the same validated inventory identity, not arbitrary origins.
    fn matches_download_url(&self, url: &str) -> bool {
        self.browser_download_url == url || self.api_url == url
    }
}
#[derive(Clone, Debug, Deserialize)]
struct GithubRelease {
    id: u64,
    tag_name: String,
    draft: bool,
    prerelease: bool,
    #[serde(default)]
    immutable: bool,
    published_at: Option<String>,
    html_url: String,
    body: Option<String>,
    assets: Vec<ReleaseAsset>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetManifest {
    schema_version: u32,
    version: String,
    tag: String,
    repository: String,
    generated_at: String,
    assets: Vec<ManifestAsset>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestAsset {
    name: String,
    kind: String,
    platform: String,
    bytes: u64,
    sha256: String,
    download_url: String,
}

struct DiscoverySource {
    releases_url: Url,
    fixture: bool,
}
impl DiscoverySource {
    fn production() -> Self {
        Self {
            releases_url: Url::parse(RELEASES_URL).expect("fixed URL"),
            fixture: false,
        }
    }
    fn configured() -> Result<Self, String> {
        #[cfg(feature = "updater-e2e")]
        if let Some(raw) = std::env::var_os("OMP_DESKTOP_UPDATER_E2E_RELEASES_URL") {
            let gated = [
                "OMP_DESKTOP_UPDATER_E2E_MARKER",
                "OMP_DESKTOP_UPDATER_E2E_TARGET",
            ]
            .iter()
            .all(|key| std::env::var_os(key).is_some_and(|value| !value.is_empty()));
            let url = raw
                .to_str()
                .and_then(|raw| Url::parse(raw).ok())
                .filter(|url| {
                    gated
                        && url.scheme() == "http"
                        && url.host_str() == Some("127.0.0.1")
                        && url.port().is_some()
                        && url.path() == "/releases"
                        && url.username().is_empty()
                        && url.password().is_none()
                        && url.query().is_none()
                        && url.fragment().is_none()
                })
                .ok_or_else(|| "Недопустимый изолированный updater E2E endpoint".to_owned())?;
            return Ok(Self {
                releases_url: url,
                fixture: true,
            });
        }
        Ok(Self::production())
    }
    fn validate_api_url(&self, asset: &ReleaseAsset) -> Result<(), String> {
        let root = if self.fixture {
            self.releases_url
                .as_str()
                .strip_suffix("/releases")
                .ok_or("Некорректный fixture origin")?
        } else {
            "https://api.github.com/repos/Omnividente/omp-desktop"
        };
        let id = asset
            .api_url
            .strip_prefix(root)
            .and_then(|path| path.strip_prefix("/releases/assets/"))
            .ok_or("API asset URL не принадлежит фиксированному repository")?;
        if id.starts_with(['0', '+']) || id.parse::<u64>().ok() != Some(asset.id) {
            return Err("API asset URL не связан с inventory ID".to_owned());
        }
        Ok(())
    }
    fn asset_url(&self, release: &GithubRelease, asset: &ReleaseAsset) -> Result<Url, String> {
        let url = Url::parse(&asset.browser_download_url)
            .map_err(|_| "Некорректный URL release asset")?;
        let mut expected = if self.fixture {
            let mut root = self.releases_url.clone();
            root.set_path("/");
            root
        } else {
            Url::parse("https://github.com/").expect("fixed URL")
        };
        {
            let mut segments = expected
                .path_segments_mut()
                .map_err(|_| "Некорректный asset origin")?;
            segments.clear();
            if !self.fixture {
                segments.push("Omnividente").push("omp-desktop");
            }
            segments
                .push("releases")
                .push("download")
                .push(&release.tag_name)
                .push(&asset.name);
        }
        if url != expected {
            return Err("Asset URL не принадлежит фиксированному repository/tag".to_owned());
        }
        Ok(url)
    }
}

#[cfg(feature = "updater-e2e")]
pub(crate) fn e2e_fixture_enabled() -> Result<bool, String> {
    DiscoverySource::configured().map(|source| source.fixture)
}

fn valid_timestamp(value: &str) -> bool {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).is_ok()
}
fn release_version(release: &GithubRelease, current: &Version, include: bool) -> Option<Version> {
    if release.id == 0
        || release.draft
        || !release.immutable
        || (release.prerelease && !include)
        || !release.published_at.as_deref().is_some_and(valid_timestamp)
        || release.html_url
            != format!(
                "https://github.com/{REPOSITORY}/releases/tag/{}",
                release.tag_name
            )
    {
        return None;
    }
    let version = Version::parse(release.tag_name.strip_prefix('v')?).ok()?;
    (version.cmp_precedence(current).is_gt() && release.tag_name == format!("v{version}"))
        .then_some(version)
}
fn content_type(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".json") {
        "application/json"
    } else if lower.ends_with(".txt") || lower.ends_with(".sig") {
        "text/plain"
    } else if lower.ends_with(".zip") {
        "application/zip"
    } else if lower.ends_with(".tar.gz") {
        "application/gzip"
    } else {
        "application/octet-stream"
    }
}
fn installer(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".appimage", ".deb", ".rpm", "setup.exe", ".msi"]
        .iter()
        .any(|suffix| lower.ends_with(suffix))
}
fn classification(name: &str) -> (&'static str, &'static str) {
    let lower = name.to_ascii_lowercase();
    let base = lower.strip_suffix(".sig").unwrap_or(&lower);
    let platform = if ["setup.exe", ".msi", ".nsis.zip", ".msi.zip"]
        .iter()
        .any(|suffix| base.ends_with(suffix))
    {
        "windows"
    } else if [".appimage", ".deb", ".rpm", ".tar.gz"]
        .iter()
        .any(|suffix| base.ends_with(suffix))
    {
        "linux"
    } else {
        "metadata"
    };
    let kind = if lower.ends_with(".sig") {
        "signature"
    } else if lower == "latest.json" {
        "updater-manifest"
    } else if lower.starts_with("sha256sums-") {
        "checksum"
    } else if [".nsis.zip", ".msi.zip", ".tar.gz"]
        .iter()
        .any(|suffix| lower.ends_with(suffix))
    {
        "updater-bundle"
    } else {
        "installer"
    };
    (kind, platform)
}
fn digest_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn versioned_filename(name: &str, version: &str) -> bool {
    name.match_indices(version).any(|(offset, matched)| {
        let end = offset + matched.len();
        (offset == 0 || !name.as_bytes()[offset - 1].is_ascii_alphanumeric())
            && (end == name.len() || !name.as_bytes()[end].is_ascii_alphanumeric())
    })
}
fn asset_inventory<'a>(
    source: &DiscoverySource,
    release: &'a GithubRelease,
    version: &Version,
) -> Result<BTreeMap<&'a str, &'a ReleaseAsset>, String> {
    let mut assets = BTreeMap::new();
    let mut ids = BTreeSet::new();
    for asset in &release.assets {
        if asset.id == 0
            || !ids.insert(asset.id)
            || asset.state != "uploaded"
            || asset.size == 0
            || asset.name.is_empty()
            || asset.name.contains(['/', '\\'])
            || asset.name.starts_with("__omp_stage__")
            || asset.content_type != content_type(&asset.name)
            || !asset.digest.strip_prefix("sha256:").is_some_and(digest_hex)
            || assets.insert(asset.name.as_str(), asset).is_some()
        {
            return Err("Неполный или неоднозначный inventory релиза".to_owned());
        }
        source.asset_url(release, asset)?;
        source.validate_api_url(asset)?;
    }
    for name in [
        "latest.json",
        "release-assets-manifest.json",
        "SHA256SUMS-linux.txt",
        "SHA256SUMS-windows.txt",
    ] {
        if !assets.contains_key(name) {
            return Err(format!("Отсутствует release asset: {name}"));
        }
    }
    let coverage: &[&str] = if source.fixture {
        &[".appimage", "setup.exe"]
    } else {
        &[".appimage", ".deb", ".rpm", "setup.exe", ".msi"]
    };
    for suffix in coverage {
        if !assets
            .keys()
            .any(|name| name.to_ascii_lowercase().ends_with(suffix))
        {
            return Err(format!("Неполный набор installers: {suffix}"));
        }
    }
    let version = version.to_string();
    for name in assets.keys().filter(|name| installer(name)) {
        if !versioned_filename(name, &version)
            || !assets.contains_key(format!("{name}.sig").as_str())
        {
            return Err("Installer version/signature inventory mismatch".to_owned());
        }
    }
    Ok(assets)
}
fn validate_manifest(
    manifest: &AssetManifest,
    release: &GithubRelease,
    version: &Version,
    assets: &BTreeMap<&str, &ReleaseAsset>,
) -> Result<(), String> {
    if manifest.schema_version != 1
        || manifest.version != version.to_string()
        || manifest.tag != release.tag_name
        || manifest.repository != REPOSITORY
        || !valid_timestamp(&manifest.generated_at)
        || manifest.assets.len() + 1 != assets.len()
    {
        return Err("Release manifest identity/inventory mismatch".to_owned());
    }
    let mut seen = BTreeSet::new();
    for entry in &manifest.assets {
        let asset = assets
            .get(entry.name.as_str())
            .filter(|_| entry.name != "release-assets-manifest.json")
            .ok_or("Неизвестный asset в release manifest")?;
        let (kind, platform) = classification(&entry.name);
        if !seen.insert(&entry.name)
            || entry.kind != kind
            || entry.platform != platform
            || entry.bytes != asset.size
            || asset.digest != format!("sha256:{}", entry.sha256)
            || !asset.matches_download_url(&entry.download_url)
        {
            return Err("Release manifest asset binding mismatch".to_owned());
        }
    }
    Ok(())
}
fn decode_text(encoded: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|_| "Некорректная base64 подпись")?;
    String::from_utf8(bytes).map_err(|_| "Некорректный текст подписи".to_owned())
}
fn signature_metadata(
    encoded: &str,
    public_key: &str,
    version: &Version,
    filename: &str,
) -> Result<(), String> {
    let key_text = decode_text(public_key)?;
    PublicKey::decode(&key_text).map_err(|_| "Некорректный updater public key")?;
    let signature_text = decode_text(encoded)?;
    if signature_text.lines().count() != 4 {
        return Err("Некорректное число строк minisign подписи".to_owned());
    }
    let signature =
        Signature::decode(&signature_text).map_err(|_| "Некорректная minisign подпись")?;
    let key = base64::engine::general_purpose::STANDARD
        .decode(key_text.lines().nth(1).ok_or("Нет public key")?)
        .map_err(|_| "Некорректный public key")?;
    let packet = base64::engine::general_purpose::STANDARD
        .decode(signature_text.lines().nth(1).ok_or("Нет подписи")?)
        .map_err(|_| "Некорректная подпись")?;
    if key.get(2..10) != packet.get(2..10) {
        return Err("Подпись другого updater key".to_owned());
    }
    // Minisign's global signature authenticates the detached package signature and trusted
    // comment without downloading the binary. Key-id equality alone is NOT sufficient.
    let global_signature = base64::engine::general_purpose::STANDARD
        .decode(
            signature_text
                .lines()
                .nth(3)
                .ok_or("Нет global signature")?,
        )
        .map_err(|_| "Некорректная global signature")?;
    let comment = signature.trusted_comment().as_bytes();
    let mut signed_metadata = Vec::with_capacity(64 + comment.len());
    signed_metadata.extend_from_slice(&packet[10..74]);
    signed_metadata.extend_from_slice(comment);
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &key[10..42])
        .verify(&signed_metadata, &global_signature)
        .map_err(|_| "Updater signature metadata не прошла проверку ключом")?;
    // This authenticates metadata, not the package. SDK download/install must still verify
    // actual package bytes and signed version before any installer is started.
    let fields = signature.trusted_comment().split('\t');
    let mut versions = fields
        .clone()
        .filter_map(|field| field.strip_prefix("version:"));
    let mut files = fields.filter_map(|field| field.strip_prefix("file:"));
    // The trusted filename is signed before GitHub replaces upload-name spaces with dots.
    let filename_matches = files.next().is_some_and(|name| {
        let normalize = |ch| if ch == ' ' { '.' } else { ch };
        name.chars()
            .map(normalize)
            .eq(filename.chars().map(normalize))
    });
    if versions
        .next()
        .and_then(|value| Version::parse(value.trim_start_matches('v')).ok())
        .as_ref()
        != Some(version)
        || versions.next().is_some()
        || !filename_matches
        || files.next().is_some()
    {
        return Err("Подпись не связывает announced version/filename".to_owned());
    }
    Ok(())
}
pub(crate) fn metadata_client() -> Result<reqwest::Client, String> {
    // restore_update bypasses SDK check(), which normally initializes the shared TLS provider.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .user_agent(concat!("OMP-Desktop/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            let allowed = url.scheme() == "https"
                && matches!(
                    url.host_str(),
                    Some(
                        "github.com"
                            | "api.github.com"
                            | "release-assets.githubusercontent.com"
                            | "objects.githubusercontent.com"
                    )
                );
            if attempt.previous().len() >= 5 || !allowed {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| "Не удалось создать updater HTTP client".to_owned())
}
async fn fetch_bytes(client: &reqwest::Client, url: Url, limit: usize) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| "Не удалось получить release metadata".to_owned())?
        .error_for_status()
        .map_err(|_| "Release metadata HTTP error".to_owned())?;
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("Release metadata слишком велика".to_owned());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Ошибка чтения release metadata".to_owned())?
    {
        if bytes.len() + chunk.len() > limit {
            return Err("Release metadata слишком велика".to_owned());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn fetch_asset(
    client: &reqwest::Client,
    source: &DiscoverySource,
    release: &GithubRelease,
    asset: &ReleaseAsset,
) -> Result<Vec<u8>, String> {
    if asset.size > MAX_METADATA_BYTES as u64 {
        return Err("Metadata asset слишком велик".to_owned());
    }
    let bytes = fetch_bytes(
        client,
        source.asset_url(release, asset)?,
        asset.size as usize,
    )
    .await?;
    if bytes.len() as u64 != asset.size
        || format!("sha256:{:x}", Sha256::digest(&bytes)) != asset.digest
    {
        return Err("Metadata asset digest/size mismatch".to_owned());
    }
    Ok(bytes)
}
fn public_key(app: &AppHandle) -> Result<String, String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(|key| key.as_str())
        .map(str::to_owned)
        .ok_or_else(|| "Updater public key не настроен".to_owned())
}

fn platform_binding<'a>(
    platform: &str,
    entry: &'a serde_json::Value,
    assets: &BTreeMap<&str, &'a ReleaseAsset>,
    public_key: &str,
    version: &Version,
) -> Result<(&'a ReleaseAsset, &'a str), String> {
    let url = entry
        .get("url")
        .and_then(|value| value.as_str())
        .ok_or("Нет platform URL")?;
    let asset = assets
        .values()
        .find(|asset| asset.matches_download_url(url))
        .ok_or("Platform asset отсутствует")?;
    let (_, family) = classification(&asset.name);
    if !installer(&asset.name) || !platform.starts_with(&format!("{family}-")) {
        return Err("Platform installer mismatch".to_owned());
    }
    let signature = entry
        .get("signature")
        .and_then(|value| value.as_str())
        .ok_or("Нет platform signature")?;
    signature_metadata(signature, public_key, version, &asset.name)?;
    Ok((asset, signature))
}
async fn candidate_for_release(
    app: &AppHandle,
    client: &reqwest::Client,
    source: &DiscoverySource,
    release: &GithubRelease,
    version: &Version,
    public_key: &str,
) -> Result<Candidate, String> {
    let assets = asset_inventory(source, release, version)?;
    let manifest: AssetManifest = serde_json::from_slice(
        &fetch_asset(
            client,
            source,
            release,
            assets["release-assets-manifest.json"],
        )
        .await?,
    )
    .map_err(|_| "Некорректный release manifest")?;
    validate_manifest(&manifest, release, version, &assets)?;
    let raw: serde_json::Value =
        serde_json::from_slice(&fetch_asset(client, source, release, assets["latest.json"]).await?)
            .map_err(|_| "Некорректный updater manifest")?;
    if raw.get("version").and_then(|value| value.as_str()) != Some(version.to_string().as_str()) {
        return Err("Updater manifest version mismatch".to_owned());
    }
    let platforms = raw
        .get("platforms")
        .and_then(|value| value.as_object())
        .ok_or("Нет updater platforms")?;
    let mut covered = BTreeSet::new();
    let mut signatures = BTreeMap::new();
    for (platform, entry) in platforms {
        let (asset, signature) = platform_binding(platform, entry, &assets, public_key, version)?;
        if !signatures.contains_key(&asset.name) {
            let bytes = fetch_asset(
                client,
                source,
                release,
                assets[format!("{}.sig", asset.name).as_str()],
            )
            .await?;
            signatures.insert(
                asset.name.clone(),
                String::from_utf8(bytes).map_err(|_| "Некорректный signature asset")?,
            );
        }
        if signatures[&asset.name].trim() != signature.trim() {
            return Err("Manifest/signature asset mismatch".to_owned());
        }
        covered.insert(asset.name.as_str());
    }
    if assets
        .keys()
        .filter(|name| installer(name))
        .any(|name| !covered.contains(*name))
    {
        return Err("Не каждый installer имеет updater target".to_owned());
    }
    // Pin the exact validated JSON: no second manifest request or check/install TOCTOU.
    let update = app
        .updater()
        .map_err(|_| "Updater SDK недоступен")?
        .restore_update(raw)
        .map_err(|_| "Updater platform несовместим с этим приложением")?
        .ok_or("Updater SDK не принял новую версию")?;
    if update.version != version.to_string()
        || !assets
            .values()
            .any(|asset| asset.matches_download_url(update.download_url.as_str()))
    {
        return Err("SDK target не связан с проверенным inventory".to_owned());
    }
    Ok(Candidate {
        info: ClientUpdateInfo {
            candidate_id: String::new(),
            version: version.to_string(),
            date: release.published_at.clone(),
            body: release.body.clone(),
            prerelease: release.prerelease,
            release_id: release.id.to_string(),
            release_url: release.html_url.clone(),
        },
        update: Arc::new(update),
    })
}
async fn discover(app: &AppHandle, include: bool) -> Result<Option<Candidate>, String> {
    let source = DiscoverySource::configured()?;
    let client = metadata_client()?;
    let key = public_key(app)?;
    let current = &app.package_info().version;
    let mut releases = Vec::new();
    let mut page = 1u64;
    loop {
        let mut url = source.releases_url.clone();
        url.query_pairs_mut()
            .append_pair("per_page", "100")
            .append_pair("page", &page.to_string());
        let batch: Vec<serde_json::Value> =
            serde_json::from_slice(&fetch_bytes(&client, url, MAX_METADATA_BYTES).await?)
                .map_err(|_| "Некорректный GitHub releases response")?;
        let complete = batch.len() < 100;
        for raw in batch {
            // Missing/null digest and malformed inventory disqualify that release, not all
            // other published releases in the same GitHub response page.
            if let Ok(release) = serde_json::from_value::<GithubRelease>(raw) {
                if let Some(version) = release_version(&release, current, include) {
                    releases.push((version, release));
                }
            }
        }
        if complete {
            break;
        }
        page += 1;
    }
    releases.sort_by(|left, right| {
        right
            .0
            .cmp_precedence(&left.0)
            .then_with(|| right.1.id.cmp(&left.1.id))
    });
    for (version, release) in releases {
        // An incomplete newer release must not hide an older complete compatible update.
        if let Ok(candidate) =
            candidate_for_release(app, &client, &source, &release, &version, &key).await
        {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

pub(crate) async fn check(app: &AppHandle) -> Result<DesktopUpdateStatus, String> {
    let reservation = with_broker(app, Broker::begin_check)?;
    let Some((ticket, include)) = reservation else {
        return Ok(status(app));
    };
    match discover(app, include).await {
        Ok(mut candidate) => {
            if let Some(candidate) = &mut candidate {
                candidate.info.candidate_id = format!(
                    "{}:{}:{}",
                    ticket.policy, ticket.check, candidate.info.release_id
                );
            }
            with_broker(app, |broker| broker.finish_check(ticket, candidate));
            Ok(status(app))
        }
        Err(error) => {
            with_broker(app, |broker| broker.finish_check(ticket, None));
            Err(error)
        }
    }
}
pub(crate) async fn install(
    app: &AppHandle,
    candidate_id: &str,
) -> Result<DesktopUpdateStatus, String> {
    let reservation = with_broker(app, |broker| broker.reserve_install(candidate_id))?;
    let Some(InstallReservation {
        update,
        info,
        policy_epoch,
    }) = reservation
    else {
        return Ok(status(app));
    };
    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => bytes,
        Err(_) => {
            with_broker(app, Broker::download_failed);
            return Err(
                "Загрузка или проверка подписи Desktop не завершена; установка не запускалась"
                    .to_owned(),
            );
        }
    };
    with_broker(app, |broker| broker.begin_install(policy_epoch))?;
    let install_result = tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await;
    let success = matches!(install_result, Ok(Ok(())));
    with_broker(app, |broker| broker.finish_install(info, success));
    if success {
        Ok(status(app))
    } else {
        Err("Исход установки Desktop неизвестен. Повторная установка заблокирована; перезапустите приложение и проверьте версию".to_owned())
    }
}

fn command_error(operation: &str, error: String) -> crate::models::AppError {
    crate::models::AppError::from_internal("desktop_update_failed", operation, error)
}
#[tauri::command]
pub(crate) fn desktop_update_status(app: AppHandle) -> DesktopUpdateStatus {
    status(&app)
}
#[tauri::command]
pub(crate) async fn desktop_update_check(
    app: AppHandle,
) -> Result<DesktopUpdateStatus, crate::models::AppError> {
    check(&app)
        .await
        .map_err(|error| command_error("Не удалось проверить обновления Desktop", error))
}
#[tauri::command]
pub(crate) async fn desktop_update_install(
    app: AppHandle,
    candidate_id: String,
) -> Result<DesktopUpdateStatus, crate::models::AppError> {
    install(&app, &candidate_id)
        .await
        .map_err(|error| command_error("Не удалось установить обновление Desktop", error))
}
#[tauri::command]
pub(crate) async fn desktop_update_reconcile_settings(
    app: AppHandle,
) -> Result<DesktopUpdateStatus, crate::models::AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::settings::reconcile_desktop_update_policy(&app)
    })
    .await
    .map_err(|error| crate::models::AppError::join("чтения канала Desktop", error))?
    .map_err(|error| command_error("Не удалось прочитать сохранённый канал Desktop", error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Public throwaway vectors from tauri-plugin-updater 2.14.1 offline_tests,
    // payload `test`, signed for 2.0.0. No production signing material.
    const KEY: &str = "untrusted comment: minisign public key: A49EF4746FA6E6D7\nRWTX5qZvdPSepDGWg2bz8n6ArQnBMwgQK1geVosorcbLzcunD+KJ+cYe";
    const SIGNATURE: &str = "untrusted comment: signature from tauri secret key\nRUTX5qZvdPSepPF2zsjvP/L/TQtBLRnWRvaq+4omK1UEugtQp/USrGiI1v762sDy3id3aor7bRC9ETyeot6lMHHrWoZ5hjUM1Qc=\ntrusted comment: timestamp:1791649051\tfile:payload\tversion:2.0.0\nDDq2CLOEl5cQmC2eJRHlnZPVViOZsu1CjpPKQoei4A/XBfkDqGO0B+QMrcrHgEQ5qV3mne75tdFWhJpqUXh9AA==";
    const OTHER_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";

    fn encoded(value: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(value)
    }
    fn release(version: &str, prerelease: bool) -> GithubRelease {
        GithubRelease {
            id: 42,
            tag_name: format!("v{version}"),
            draft: false,
            prerelease,
            immutable: true,
            published_at: Some("2026-11-08T00:00:00Z".to_owned()),
            html_url: format!("https://github.com/{REPOSITORY}/releases/tag/v{version}"),
            body: None,
            assets: Vec::new(),
        }
    }
    fn info() -> ClientUpdateInfo {
        ClientUpdateInfo {
            candidate_id: "2:3:42".to_owned(),
            version: "2.0.0".to_owned(),
            date: None,
            body: None,
            prerelease: true,
            release_id: "42".to_owned(),
            release_url: format!("https://github.com/{REPOSITORY}/releases/tag/v2.0.0"),
        }
    }
    fn ready() -> Broker {
        let mut broker = Broker::default();
        broker.publish_policy(Some(false));
        broker
    }
    fn complete_release() -> GithubRelease {
        let mut release = release("2.0.0", false);
        let mut names = vec![
            "latest.json".to_owned(),
            "release-assets-manifest.json".to_owned(),
            "SHA256SUMS-linux.txt".to_owned(),
            "SHA256SUMS-windows.txt".to_owned(),
        ];
        for name in [
            "OMP_2.0.0_amd64.AppImage",
            "OMP_2.0.0_amd64.deb",
            "OMP_2.0.0_x86_64.rpm",
            "OMP_2.0.0_x64-setup.exe",
            "OMP_2.0.0_x64.msi",
        ] {
            names.push(name.to_owned());
            names.push(format!("{name}.sig"));
        }
        release.assets = names
            .into_iter()
            .enumerate()
            .map(|(index, name)| ReleaseAsset {
                id: index as u64 + 1,
                content_type: content_type(&name).to_owned(),
                browser_download_url: format!(
                    "https://github.com/{REPOSITORY}/releases/download/v2.0.0/{name}"
                ),
                api_url: format!(
                    "https://api.github.com/repos/{REPOSITORY}/releases/assets/{}",
                    index + 1
                ),
                name,
                state: "uploaded".to_owned(),
                size: 123,
                digest: format!("sha256:{}", "a".repeat(64)),
            })
            .collect();
        release
    }
    fn manifest(release: &GithubRelease) -> AssetManifest {
        AssetManifest {
            schema_version: 1,
            version: "2.0.0".to_owned(),
            tag: release.tag_name.clone(),
            repository: REPOSITORY.to_owned(),
            generated_at: "2026-11-08T00:00:00Z".to_owned(),
            assets: release
                .assets
                .iter()
                .filter(|asset| asset.name != "release-assets-manifest.json")
                .map(|asset| {
                    let (kind, platform) = classification(&asset.name);
                    ManifestAsset {
                        name: asset.name.clone(),
                        kind: kind.to_owned(),
                        platform: platform.to_owned(),
                        bytes: asset.size,
                        sha256: asset.digest[7..].to_owned(),
                        download_url: asset.browser_download_url.clone(),
                    }
                })
                .collect(),
        }
    }

    #[test]
    fn selection_uses_github_flag_and_strict_semver_precedence() {
        let current = Version::new(1, 0, 0);
        assert_eq!(
            release_version(&release("2.0.0", true), &current, true),
            Some(Version::new(2, 0, 0))
        );
        assert!(release_version(&release("2.0.0", true), &current, false).is_none());
        // A suffix is not the channel: GitHub's flag is the authority.
        assert!(release_version(&release("2.0.0-beta.1", false), &current, false).is_some());
        for version in [
            "0.9.0",
            "1.0.0",
            "1.0.0+new-build",
            "1.0.0-beta.2",
            "02.0.0",
            "2.0",
        ] {
            assert!(
                release_version(&release(version, false), &current, true).is_none(),
                "{version}"
            );
        }
        let mut unpublished = release("2.0.0", false);
        unpublished.draft = true;
        assert!(release_version(&unpublished, &current, true).is_none());
        unpublished.draft = false;
        unpublished.immutable = false;
        assert!(release_version(&unpublished, &current, true).is_none());
        unpublished.immutable = true;
        unpublished.published_at = None;
        assert!(release_version(&unpublished, &current, true).is_none());
    }

    #[test]
    fn inventory_requires_complete_uploaded_versioned_installers_and_signatures() {
        let source = DiscoverySource::production();
        let mut release = complete_release();
        assert!(asset_inventory(&source, &release, &Version::new(2, 0, 0)).is_ok());
        release
            .assets
            .retain(|asset| !asset.name.ends_with(".msi.sig"));
        assert!(asset_inventory(&source, &release, &Version::new(2, 0, 0)).is_err());
        let mut release = complete_release();
        release.assets.retain(|asset| !asset.name.ends_with(".deb"));
        assert!(asset_inventory(&source, &release, &Version::new(2, 0, 0)).is_err());
        let mut release = complete_release();
        release.assets[0].state = "new".to_owned();
        assert!(asset_inventory(&source, &release, &Version::new(2, 0, 0)).is_err());
        let mut release = complete_release();
        release.assets.push(release.assets[0].clone());
        assert!(asset_inventory(&source, &release, &Version::new(2, 0, 0)).is_err());
    }

    #[test]
    fn inventory_rejects_foreign_http_and_wrong_tag_downloads() {
        for url in [
            "http://github.com/Omnividente/omp-desktop/releases/download/v2.0.0/latest.json",
            "https://example.invalid/latest.json",
            "https://github.com/other/repo/releases/download/v2.0.0/latest.json",
            "https://github.com/Omnividente/omp-desktop/releases/download/v1.0.0/latest.json",
        ] {
            let mut release = complete_release();
            release.assets[0].browser_download_url = url.to_owned();
            assert!(asset_inventory(
                &DiscoverySource::production(),
                &release,
                &Version::new(2, 0, 0)
            )
            .is_err());
        }
    }

    #[test]
    fn inventory_rejects_untrusted_or_ambiguous_api_asset_identity() {
        for url in [
            "http://api.github.com/repos/Omnividente/omp-desktop/releases/assets/1",
            "https://api.github.com/repos/other/repository/releases/assets/1",
            "https://api.github.com/repos/Omnividente/omp-desktop/releases/assets/2",
            "https://api.github.com/repos/Omnividente/omp-desktop/releases/assets/01",
            "https://api.github.com/repos/Omnividente/omp-desktop/releases/assets/+1",
            "https://api.github.com/repos/Omnividente/omp-desktop/releases/assets/1?redirect=elsewhere",
        ] {
            let mut release = complete_release();
            release.assets[0].api_url = url.to_owned();
            assert!(asset_inventory(&DiscoverySource::production(), &release, &Version::new(2, 0, 0)).is_err());
        }
    }

    #[test]
    fn manifest_binds_full_inventory_digest_size_url_and_version() {
        let release = complete_release();
        let assets = asset_inventory(
            &DiscoverySource::production(),
            &release,
            &Version::new(2, 0, 0),
        )
        .unwrap();
        let mut manifest = manifest(&release);
        assert!(validate_manifest(&manifest, &release, &Version::new(2, 0, 0), &assets).is_ok());
        manifest.assets[0].bytes += 1;
        assert!(validate_manifest(&manifest, &release, &Version::new(2, 0, 0), &assets).is_err());
        manifest.assets[0].bytes -= 1;
        manifest.assets[0].sha256 = "b".repeat(64);
        assert!(validate_manifest(&manifest, &release, &Version::new(2, 0, 0), &assets).is_err());
        manifest.assets[0].sha256 = "a".repeat(64);
        manifest.version = "3.0.0".to_owned();
        assert!(validate_manifest(&manifest, &release, &Version::new(2, 0, 0), &assets).is_err());
        manifest.version = "2.0.0".to_owned();
        manifest.assets.pop();
        assert!(validate_manifest(&manifest, &release, &Version::new(2, 0, 0), &assets).is_err());
    }

    #[test]
    fn published_filename_normalization_preserves_authenticated_identity() {
        // GitHub's published asset replaces spaces in the pre-upload signed filename with dots.
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("fixtures/updater-upload-name.json")).unwrap();
        let public_key = vector["publicKey"].as_str().unwrap();
        let signature = vector["signature"].as_str().unwrap();
        PublicKey::decode(&decode_text(public_key).unwrap())
            .unwrap()
            .verify(
                b"test",
                &Signature::decode(&decode_text(signature).unwrap()).unwrap(),
                true,
            )
            .unwrap();
        assert!(signature_metadata(
            signature,
            public_key,
            &Version::new(2, 0, 0),
            vector["uploadedFilename"].as_str().unwrap()
        )
        .is_ok());
        assert!(signature_metadata(
            signature,
            public_key,
            &Version::new(2, 0, 0),
            "Another.App_2.0.0_x64-setup.exe"
        )
        .is_err());
    }

    #[test]
    fn published_api_target_is_bound_to_the_current_inventory_asset() {
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("fixtures/updater-upload-name.json")).unwrap();
        let mut asset = complete_release()
            .assets
            .into_iter()
            .find(|asset| asset.name.ends_with("setup.exe"))
            .unwrap();
        asset.name = "OMP Desktop_2.0.0_x64-setup.exe".to_owned();
        asset.browser_download_url = format!("https://github.com/{REPOSITORY}/releases/download/v2.0.0/OMP%20Desktop_2.0.0_x64-setup.exe");
        let assets = BTreeMap::from([(asset.name.as_str(), &asset)]);
        let mut entry = json!({"url":format!("https://api.github.com/repos/{REPOSITORY}/releases/assets/{}",asset.id), "signature":vector["signature"]});
        let key = vector["publicKey"].as_str().unwrap();
        assert!(platform_binding(
            "windows-x86_64",
            &entry,
            &assets,
            key,
            &Version::new(2, 0, 0)
        )
        .is_ok());
        entry["url"] = json!(asset.browser_download_url);
        assert!(platform_binding(
            "windows-x86_64",
            &entry,
            &assets,
            key,
            &Version::new(2, 0, 0)
        )
        .is_ok());
        for invalid in [
            format!(
                "https://api.github.com/repos/other/repository/releases/assets/{}",
                asset.id
            ),
            format!(
                "http://api.github.com/repos/{REPOSITORY}/releases/assets/{}",
                asset.id
            ),
            format!("https://api.github.com/repos/{REPOSITORY}/releases/assets/999999"),
            format!(
                "https://api.github.com/repos/{REPOSITORY}/releases/assets/{}?redirect=elsewhere",
                asset.id
            ),
        ] {
            entry["url"] = json!(invalid);
            assert!(platform_binding(
                "windows-x86_64",
                &entry,
                &assets,
                key,
                &Version::new(2, 0, 0)
            )
            .is_err());
        }
    }

    #[test]
    fn signature_metadata_rejects_absent_malformed_wrong_key_or_binding() {
        let version = Version::new(2, 0, 0);
        assert!(
            signature_metadata(&encoded(SIGNATURE), &encoded(KEY), &version, "payload").is_ok()
        );
        for invalid in ["", "not-base64", "eA=="] {
            assert!(signature_metadata(invalid, &encoded(KEY), &version, "payload").is_err());
        }
        assert!(signature_metadata(
            &encoded(SIGNATURE),
            &encoded(OTHER_KEY),
            &version,
            "payload"
        )
        .is_err());
        assert!(signature_metadata(
            &encoded(SIGNATURE),
            &encoded(KEY),
            &Version::new(3, 0, 0),
            "payload"
        )
        .is_err());
        assert!(
            signature_metadata(&encoded(SIGNATURE), &encoded(KEY), &version, "other-file").is_err()
        );
        assert!(signature_metadata(
            &encoded(&SIGNATURE.replace("\tversion:2.0.0", "")),
            &encoded(KEY),
            &version,
            "payload"
        )
        .is_err());
        let mut same_id_wrong_key = base64::engine::general_purpose::STANDARD
            .decode(KEY.lines().nth(1).unwrap())
            .unwrap();
        same_id_wrong_key[10] ^= 1;
        let forged_key = format!(
            "untrusted comment: test key\n{}",
            base64::engine::general_purpose::STANDARD.encode(same_id_wrong_key)
        );
        assert!(signature_metadata(
            &encoded(SIGNATURE),
            &encoded(&forged_key),
            &version,
            "payload"
        )
        .is_err());
    }

    #[test]
    fn authenticated_metadata_is_not_package_authentication() {
        let key = PublicKey::decode(KEY).unwrap();
        let signature = Signature::decode(SIGNATURE).unwrap();
        key.verify(b"test", &signature, true).unwrap();
        assert!(key.verify(b"tampered", &signature, true).is_err());
        assert!(PublicKey::decode(OTHER_KEY)
            .unwrap()
            .verify(b"test", &signature, true)
            .is_err());
        let altered = SIGNATURE.replace("version:2.0.0", "version:3.0.0");
        // Forged trusted metadata is rejected before offering even a validly signed package.
        assert!(signature_metadata(
            &encoded(&altered),
            &encoded(KEY),
            &Version::new(3, 0, 0),
            "payload"
        )
        .is_err());
        assert!(key
            .verify(b"test", &Signature::decode(&altered).unwrap(), true)
            .is_err());
    }

    #[test]
    fn platform_must_bind_inventory_and_signature_and_sdk_requires_target() {
        let release = complete_release();
        let assets = asset_inventory(
            &DiscoverySource::production(),
            &release,
            &Version::new(2, 0, 0),
        )
        .unwrap();
        let url = &assets["OMP_2.0.0_x64-setup.exe"].browser_download_url;
        let missing_signature = json!({"url": url});
        assert!(platform_binding(
            "windows-x86_64",
            &missing_signature,
            &assets,
            &encoded(KEY),
            &Version::new(2, 0, 0)
        )
        .is_err());
        let wrong_family = json!({"url": url, "signature": encoded(SIGNATURE)});
        assert!(platform_binding(
            "linux-x86_64",
            &wrong_family,
            &assets,
            &encoded(KEY),
            &Version::new(2, 0, 0)
        )
        .is_err());
        let remote: tauri_plugin_updater::RemoteRelease = serde_json::from_value(json!({
            "version": "2.0.0", "platforms": {"windows-x86_64": wrong_family}
        }))
        .unwrap();
        assert!(remote.download_url("windows-x86_64").is_ok());
        assert!(remote.download_url("linux-aarch64").is_err());
    }

    #[test]
    fn initial_policy_is_not_authoritative_and_channel_switch_invalidates_late_check() {
        let mut broker = Broker::default();
        assert_eq!(broker.snapshot().policy_state, PolicyState::NotReady);
        assert_eq!(broker.snapshot().include_prereleases, None);
        assert!(broker.begin_check().is_err());
        broker.publish_policy(Some(false));
        let (old, include) = broker.begin_check().unwrap().unwrap();
        assert!(!include);
        assert!(broker.begin_policy(true, false).unwrap());
        assert!(!broker.accepts_check(old));
        assert_eq!(broker.snapshot().policy_state, PolicyState::Changing);
        broker.publish_policy(Some(true));
        let (new, include) = broker.begin_check().unwrap().unwrap();
        assert!(include);
        broker.finish_check(old, None);
        assert!(broker.checking);
        assert!(broker.accepts_check(new));
        broker.finish_check(new, None);
        assert!(!broker.checking);
        assert!(broker.reserve_install("retired-candidate").is_err());
    }

    #[test]
    fn superseding_check_and_failed_refresh_cannot_restore_old_offer() {
        let mut broker = ready();
        let (first, _) = broker.begin_check().unwrap().unwrap();
        let (second, _) = broker.begin_check().unwrap().unwrap();
        assert!(!broker.accepts_check(first));
        broker.finish_check(first, None);
        assert!(broker.checking);
        broker.finish_check(second, None);
        assert!(!broker.checking);
        assert!(broker.candidate.is_none());
        assert!(broker.reserve_install("first-response-id").is_err());
    }

    #[test]
    fn uncertain_persistence_blocks_until_actual_persisted_channel_is_read() {
        let root = std::env::temp_dir().join(format!(
            "omp-policy-unit-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("settings.json");
        let mut broker = ready();
        broker.begin_policy(true, false).unwrap();
        // Exercise the real outcome/rollback helper: atomic write succeeded, then both
        // the caller and its rollback report errors. No unchanged inference is justified.
        let persistence: Result<(), String> = (|| {
            crate::sessions::atomic_write_private_file(
                &path,
                br#"{"desktopUpdatePrereleases":true}"#,
            )?;
            Err("error after rename".to_owned())
        })();
        let outcome =
            crate::settings::resolve_transaction(
                persistence,
                || vec!["rollback failed".to_owned()],
            );
        assert!(outcome.is_err());
        broker.publish_policy(outcome.ok().map(|_| true));
        assert_eq!(broker.policy_state, PolicyState::Uncertain);
        assert!(broker.begin_check().is_err());
        assert!(broker.begin_policy(false, false).is_err());
        assert!(broker.reserve_install("stale").is_err());
        let bytes_before = std::fs::read(&path).unwrap();
        let actual = crate::settings::read_persisted_update_channel(&path).unwrap();
        assert!(actual);
        broker.publish_policy(Some(actual));
        assert_eq!(broker.include_prereleases, Some(true));
        assert_eq!(std::fs::read(&path).unwrap(), bytes_before);
        std::fs::write(&path, b"{invalid").unwrap();
        assert!(crate::settings::read_persisted_update_channel(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{invalid");
        std::fs::remove_file(&path).unwrap();
        assert!(crate::settings::read_persisted_update_channel(&path).is_err());
        std::fs::remove_dir(&root).unwrap();
    }

    #[test]
    fn download_failure_is_retryable_but_install_failure_is_fail_closed() {
        let mut broker = ready();
        broker.install_state = InstallState::Downloading;
        assert!(broker.begin_policy(true, false).is_err());
        // Unrelated settings are allowed; they cannot change the current channel.
        assert!(!broker.begin_policy(false, false).unwrap());
        broker.download_failed();
        assert_eq!(broker.install_state, InstallState::Idle);
        assert!(broker.begin_check().unwrap().is_some());
        broker.checking = false;
        broker.install_state = InstallState::Downloading;
        broker.begin_install(broker.policy_epoch).unwrap();
        broker.finish_install(info(), false);
        assert_eq!(broker.install_state, InstallState::Uncertain);
        assert!(broker.reserve_install(&info().candidate_id).is_err());
        assert!(broker.begin_policy(true, false).is_err());
        assert!(broker.begin_check().unwrap().is_none());
    }

    #[test]
    fn repeat_installed_candidate_is_idempotent_and_survives_channel_switch() {
        let mut broker = ready();
        broker.install_state = InstallState::Downloading;
        broker.begin_install(broker.policy_epoch).unwrap();
        broker.finish_install(info(), true);
        assert!(broker
            .reserve_install(&info().candidate_id)
            .unwrap()
            .is_none());
        assert!(broker.reserve_install("other-id").is_err());
        broker.begin_policy(true, false).unwrap();
        broker.publish_policy(Some(true));
        assert_eq!(broker.installed, Some(info()));
        assert_eq!(broker.install_state, InstallState::Installed);
        // A relaunch failure is frontend-owned; neither status nor a check resets installed.
        assert!(broker.begin_check().unwrap().is_none());
        assert!(broker
            .reserve_install(&info().candidate_id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn reconciliation_cutover_during_download_cannot_start_old_installer() {
        let mut broker = ready();
        broker.install_state = InstallState::Downloading;
        let reserved_epoch = broker.policy_epoch;
        broker.publish_policy(None);
        assert!(broker.begin_install(reserved_epoch).is_err());
        assert_eq!(broker.install_state, InstallState::Idle);
        assert_eq!(broker.policy_state, PolicyState::Uncertain);
        assert!(broker.candidate.is_none());
    }
}
