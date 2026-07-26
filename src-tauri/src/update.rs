use crate::models::OmpUpdateInfo;
use semver::Version;

pub fn normalize_update_info(output: &str, installed_version: Option<&str>) -> OmpUpdateInfo {
    let output = output.trim();
    let lower = output.to_lowercase();
    let no_update = [
        "already up to date",
        "up-to-date",
        "no update available",
        "no updates available",
        "latest version is installed",
        "using the latest version",
        "обновление не требуется",
        "актуальная версия",
    ]
    .iter()
    .any(|marker| lower.contains(marker));
    let advertised_update = [
        "new version",
        "update available",
        "upgrade available",
        "новая версия",
        "доступно обновление",
        "доступна новая версия",
    ]
    .iter()
    .any(|marker| lower.contains(marker));
    let current = version_from_matching_line(
        output,
        &[
            "current version",
            "installed version",
            "текущая версия",
            "установлена",
        ],
    )
    .or_else(|| installed_version.and_then(parse_version));
    let explicit_latest = version_from_matching_line(
        output,
        &[
            "latest version",
            "new version",
            "update available",
            "upgrade available",
            "новая версия",
            "доступно обновление",
        ],
    );
    let latest = explicit_latest.or_else(|| no_update.then(|| current.clone()).flatten());

    let has_update = match (&current, &latest) {
        (Some(current), Some(latest)) => latest > current,
        _ => advertised_update && !no_update,
    };
    let message = match (has_update, current.as_ref(), latest.as_ref()) {
        (true, Some(current), Some(latest)) => {
            format!("Доступна новая версия OMP {latest} (установлена {current}).")
        }
        (true, _, Some(latest)) => format!("Доступна новая версия OMP {latest}."),
        (true, _, None) => "Доступна новая версия OMP.".to_owned(),
        (false, Some(current), _) => format!("Установлена актуальная версия OMP {current}."),
        (false, None, _) => "Обновления OMP не найдены.".to_owned(),
    };

    OmpUpdateInfo {
        has_update,
        current_version: current.map(|version| version.to_string()),
        latest_version: latest.map(|version| version.to_string()),
        message,
    }
}

fn version_from_matching_line(output: &str, markers: &[&str]) -> Option<Version> {
    output.lines().find_map(|line| {
        let lower = line.to_lowercase();
        markers
            .iter()
            .any(|marker| lower.contains(marker))
            .then(|| parse_version(line))
            .flatten()
    })
}

fn parse_version(text: &str) -> Option<Version> {
    text.split(|character: char| {
        !character.is_ascii_alphanumeric() && !matches!(character, '.' | '-' | '+')
    })
    .filter_map(|token| {
        let token = token.trim_matches(|character| matches!(character, '.' | '-' | '+'));
        let token = token
            .strip_prefix('v')
            .or_else(|| token.strip_prefix('V'))
            .unwrap_or(token);
        Version::parse(token).ok()
    })
    .next()
}

pub fn contains_version(text: &str) -> bool {
    text.split(|character: char| {
        !character.is_ascii_alphanumeric() && !matches!(character, '.' | '-' | '+')
    })
    .any(|token| {
        let token = token.trim_matches(|character| matches!(character, '.' | '-' | '+'));
        let token = token
            .strip_prefix('v')
            .or_else(|| token.strip_prefix('V'))
            .unwrap_or(token);
        Version::parse(token).is_ok()
    })
}

#[cfg(test)]
mod tests {
    use super::{contains_version, normalize_update_info};

    #[test]
    fn ordinary_no_update_output_is_not_a_false_positive() {
        let info = normalize_update_info(
            "Current version: 17.0.7\n✔ Already up to date",
            Some("omp/17.0.7"),
        );

        assert!(!info.has_update);
        assert_eq!(info.current_version.as_deref(), Some("17.0.7"));
        assert_eq!(info.latest_version.as_deref(), Some("17.0.7"));
        assert_eq!(info.message, "Установлена актуальная версия OMP 17.0.7.");
    }

    #[test]
    fn newer_semantic_version_is_reported_as_an_update() {
        let info = normalize_update_info(
            "Current version: 17.0.7\nNew version available: 17.1.0",
            None,
        );

        assert!(info.has_update);
        assert_eq!(info.current_version.as_deref(), Some("17.0.7"));
        assert_eq!(info.latest_version.as_deref(), Some("17.1.0"));
        assert_eq!(
            info.message,
            "Доступна новая версия OMP 17.1.0 (установлена 17.0.7)."
        );
    }

    #[test]
    fn older_advertised_version_is_never_an_update() {
        let info = normalize_update_info("Current version: 18.0.0\nLatest version: 17.9.0", None);
        assert!(!info.has_update);
        assert_eq!(info.latest_version.as_deref(), Some("17.9.0"));
    }

    #[test]
    fn installed_version_is_used_when_output_omits_current() {
        let info = normalize_update_info("New version available: v17.2.0", Some("omp/17.1.3"));
        assert!(info.has_update);
        assert_eq!(info.current_version.as_deref(), Some("17.1.3"));
        assert_eq!(info.latest_version.as_deref(), Some("17.2.0"));
    }

    #[test]
    fn current_omp_check_snapshot_is_supported() {
        let info = normalize_update_info(
            "Current version: 17.1.3\n[OK] Already up to date",
            Some("omp/17.1.3"),
        );
        assert!(!info.has_update);
        assert_eq!(info.current_version.as_deref(), Some("17.1.3"));
        assert_eq!(info.latest_version.as_deref(), Some("17.1.3"));
        assert!(contains_version("Run: omp update to install v17.2.0"));
    }

    #[test]
    fn localized_update_snapshot_is_supported() {
        let info = normalize_update_info(
            "Текущая версия: 17.1.3\nДоступна новая версия OMP: 17.2.0\nЗапустите omp update",
            None,
        );
        assert!(info.has_update);
        assert_eq!(info.latest_version.as_deref(), Some("17.2.0"));
    }
}
