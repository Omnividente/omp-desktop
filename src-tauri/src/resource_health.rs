use crate::models::{
    ResourceHealthSnapshot, ResourceMemorySnapshot, ResourceProcessSnapshot, ResourceSeverity,
    ResourceVolumeSnapshot,
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
#[cfg(unix)]
use std::{
    ffi::CString,
    mem::MaybeUninit,
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
};
#[cfg(windows)]
use std::{
    ffi::OsString,
    os::windows::ffi::{OsStrExt, OsStringExt},
};
use sysinfo::{
    get_current_pid, MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, System,
};

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;
const MEMORY_CRITICAL_BYTES: u64 = 512 * MIB;
const MEMORY_WARNING_BYTES: u64 = GIB;
const DISK_CRITICAL_BYTES: u64 = 2 * GIB;
const DISK_WARNING_BYTES: u64 = 10 * GIB;

#[derive(Debug, Clone)]
pub struct ResourcePath {
    pub purpose: &'static str,
    pub path: PathBuf,
}

#[derive(Debug)]
struct VolumeAccumulator {
    mount_path: String,
    available_bytes: u64,
    total_bytes: u64,
    purposes: Vec<String>,
}

#[derive(Debug)]
struct VolumeSample {
    identity: String,
    mount_path: String,
    available_bytes: u64,
    total_bytes: u64,
}

pub fn sample_resource_health(
    paths: Vec<ResourcePath>,
    terminal_processes: Vec<(String, u32)>,
) -> Result<ResourceHealthSnapshot, String> {
    let mut system = System::new();
    system.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram().with_swap());

    let available_severity = memory_severity(system.available_memory(), system.total_memory());
    let swap_severity = swap_severity(system.used_swap(), system.total_swap());
    let memory = ResourceMemorySnapshot {
        available_bytes: system.available_memory(),
        total_bytes: system.total_memory(),
        used_swap_bytes: system.used_swap(),
        total_swap_bytes: system.total_swap(),
        available_severity,
        swap_severity,
        severity: available_severity.max(swap_severity),
    };

    let volumes = sample_volumes(paths)?;
    let processes = sample_processes(&mut system, terminal_processes)?;
    let severity = volumes
        .iter()
        .map(|volume| volume.severity)
        .chain(std::iter::once(memory.severity))
        .max()
        .unwrap_or(ResourceSeverity::Ok);

    Ok(ResourceHealthSnapshot {
        sampled_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("Системные часы недоступны: {error}"))?
            .as_millis() as u64,
        severity,
        memory,
        volumes,
        processes,
    })
}

fn sample_volumes(paths: Vec<ResourcePath>) -> Result<Vec<ResourceVolumeSnapshot>, String> {
    let mut volumes = BTreeMap::<String, VolumeAccumulator>::new();

    for target in paths {
        let sample = sample_volume(&target.path)?;
        let entry = volumes
            .entry(sample.identity)
            .or_insert_with(|| VolumeAccumulator {
                mount_path: sample.mount_path,
                available_bytes: sample.available_bytes,
                total_bytes: sample.total_bytes,
                purposes: Vec::new(),
            });
        if !entry
            .purposes
            .iter()
            .any(|purpose| purpose == target.purpose)
        {
            entry.purposes.push(target.purpose.to_owned());
        }
    }

    Ok(volumes
        .into_values()
        .map(|volume| ResourceVolumeSnapshot {
            severity: disk_severity(volume.available_bytes, volume.total_bytes),
            mount_path: volume.mount_path,
            available_bytes: volume.available_bytes,
            total_bytes: volume.total_bytes,
            purposes: volume.purposes,
        })
        .collect())
}

fn existing_resource_path(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|error| {
        format!(
            "Не удалось определить путь для проверки ресурсов {}: {error}",
            path.display()
        )
    })
}

#[cfg(unix)]
fn into_u64_saturating<T>(value: T) -> u64
where
    T: TryInto<u64>,
{
    value.try_into().unwrap_or(u64::MAX)
}

#[cfg(unix)]
fn sample_volume(path: &Path) -> Result<VolumeSample, String> {
    let resolved = existing_resource_path(path)?;
    let metadata = fs::metadata(&resolved)
        .map_err(|error| format!("Не удалось проверить {}: {error}", resolved.display()))?;
    let device = metadata.dev();
    let mut mount_path = if metadata.is_dir() {
        resolved.clone()
    } else {
        resolved
            .parent()
            .unwrap_or_else(|| Path::new("/"))
            .to_path_buf()
    };
    while let Some(parent) = mount_path.parent() {
        if parent == mount_path {
            break;
        }
        match fs::metadata(parent) {
            Ok(parent_metadata) if parent_metadata.dev() == device => {
                mount_path = parent.to_path_buf();
            }
            _ => break,
        }
    }

    let c_path = CString::new(resolved.as_os_str().as_bytes())
        .map_err(|_| format!("Путь содержит нулевой байт: {}", resolved.display()))?;
    let mut stats = MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::statvfs(c_path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return Err(format!(
            "Не удалось проверить свободное место {}: {}",
            resolved.display(),
            std::io::Error::last_os_error()
        ));
    }
    let stats = unsafe { stats.assume_init() };
    let fragment_size = if stats.f_frsize == 0 {
        into_u64_saturating(stats.f_bsize)
    } else {
        into_u64_saturating(stats.f_frsize)
    };
    let available_blocks = into_u64_saturating(stats.f_bavail);
    let total_blocks = into_u64_saturating(stats.f_blocks);

    Ok(VolumeSample {
        identity: format!("unix-device-{device}"),
        mount_path: mount_path.to_string_lossy().into_owned(),
        available_bytes: available_blocks.saturating_mul(fragment_size),
        total_bytes: total_blocks.saturating_mul(fragment_size),
    })
}

#[cfg(windows)]
fn sample_volume(path: &Path) -> Result<VolumeSample, String> {
    use windows_sys::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetVolumePathNameW};

    const VOLUME_PATH_CAPACITY: usize = 32_768;
    let resolved = existing_resource_path(path)?;
    let path_wide = resolved
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut volume_path = vec![0_u16; VOLUME_PATH_CAPACITY];
    if unsafe {
        GetVolumePathNameW(
            path_wide.as_ptr(),
            volume_path.as_mut_ptr(),
            volume_path.len() as u32,
        )
    } == 0
    {
        return Err(format!(
            "Не удалось определить том для {}: {}",
            resolved.display(),
            std::io::Error::last_os_error()
        ));
    }
    let root_length = volume_path
        .iter()
        .position(|character| *character == 0)
        .ok_or_else(|| format!("Слишком длинный путь тома для {}", resolved.display()))?;
    let root = OsString::from_wide(&volume_path[..root_length]);
    let mut available_bytes = 0_u64;
    let mut total_bytes = 0_u64;
    let mut total_free_bytes = 0_u64;
    if unsafe {
        GetDiskFreeSpaceExW(
            volume_path.as_ptr(),
            &mut available_bytes,
            &mut total_bytes,
            &mut total_free_bytes,
        )
    } == 0
    {
        return Err(format!(
            "Не удалось проверить свободное место {}: {}",
            resolved.display(),
            std::io::Error::last_os_error()
        ));
    }
    let mount_path = root.to_string_lossy().into_owned();
    Ok(VolumeSample {
        identity: mount_path.to_lowercase(),
        mount_path,
        available_bytes,
        total_bytes,
    })
}

fn sample_processes(
    system: &mut System,
    terminal_processes: Vec<(String, u32)>,
) -> Result<Vec<ResourceProcessSnapshot>, String> {
    let desktop_pid =
        get_current_pid().map_err(|error| format!("PID OMP Desktop недоступен: {error}"))?;
    let mut pids = vec![desktop_pid];
    pids.extend(
        terminal_processes
            .iter()
            .map(|(_, process_id)| Pid::from_u32(*process_id)),
    );
    pids.sort_unstable();
    pids.dedup();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::nothing().with_memory(),
    );

    let mut processes = Vec::with_capacity(pids.len());
    if let Some(process) = system.process(desktop_pid) {
        processes.push(ResourceProcessSnapshot {
            terminal_id: None,
            process_id: desktop_pid.as_u32(),
            resident_bytes: process.memory(),
            source: "desktop".to_owned(),
        });
    }
    for (terminal_id, process_id) in terminal_processes {
        let pid = Pid::from_u32(process_id);
        if let Some(process) = system.process(pid) {
            processes.push(ResourceProcessSnapshot {
                terminal_id: Some(terminal_id),
                process_id,
                resident_bytes: process.memory(),
                source: "omp".to_owned(),
            });
        }
    }
    processes.sort_by_key(|process| std::cmp::Reverse(process.resident_bytes));
    Ok(processes)
}

fn ratio(numerator: u64, denominator: u64) -> f64 {
    if denominator == 0 {
        1.0
    } else {
        numerator as f64 / denominator as f64
    }
}

fn memory_severity(available: u64, total: u64) -> ResourceSeverity {
    let available_ratio = ratio(available, total);
    if available <= MEMORY_CRITICAL_BYTES || available_ratio <= 0.05 {
        ResourceSeverity::Critical
    } else if available <= MEMORY_WARNING_BYTES || available_ratio <= 0.10 {
        ResourceSeverity::Warning
    } else {
        ResourceSeverity::Ok
    }
}

fn swap_severity(used: u64, total: u64) -> ResourceSeverity {
    if total == 0 {
        return ResourceSeverity::Ok;
    }
    let used_ratio = ratio(used, total);
    if used_ratio >= 0.95 {
        ResourceSeverity::Critical
    } else if used_ratio >= 0.85 {
        ResourceSeverity::Warning
    } else {
        ResourceSeverity::Ok
    }
}

fn disk_severity(available: u64, total: u64) -> ResourceSeverity {
    let available_ratio = ratio(available, total);
    if available <= DISK_CRITICAL_BYTES || available_ratio <= 0.03 {
        ResourceSeverity::Critical
    } else if available <= DISK_WARNING_BYTES || available_ratio <= 0.10 {
        ResourceSeverity::Warning
    } else {
        ResourceSeverity::Ok
    }
}

pub fn default_resource_paths(
    session_root: &Path,
    workspace_path: Option<&str>,
) -> Vec<ResourcePath> {
    let mut paths = vec![
        ResourcePath {
            purpose: "sessions",
            path: session_root.to_path_buf(),
        },
        ResourcePath {
            purpose: "temporary",
            path: std::env::temp_dir(),
        },
    ];
    if let Some(workspace_path) = workspace_path.filter(|path| !path.trim().is_empty()) {
        paths.push(ResourcePath {
            purpose: "workspace",
            path: PathBuf::from(workspace_path),
        });
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::{
        default_resource_paths, disk_severity, memory_severity, sample_resource_health,
        sample_volumes, swap_severity, ResourcePath, GIB, MIB,
    };
    use crate::models::ResourceSeverity;

    #[test]
    fn resource_thresholds_distinguish_warning_and_critical_pressure() {
        assert_eq!(memory_severity(8 * GIB, 32 * GIB), ResourceSeverity::Ok);
        assert_eq!(
            memory_severity(2 * GIB, 32 * GIB),
            ResourceSeverity::Warning
        );
        assert_eq!(
            memory_severity(512 * MIB, 32 * GIB),
            ResourceSeverity::Critical
        );
        assert_eq!(swap_severity(0, 0), ResourceSeverity::Ok);
        assert_eq!(swap_severity(9 * GIB, 10 * GIB), ResourceSeverity::Warning);
        assert_eq!(
            swap_severity(19 * GIB, 20 * GIB),
            ResourceSeverity::Critical
        );
        assert_eq!(disk_severity(12 * GIB, 100 * GIB), ResourceSeverity::Ok);
        assert_eq!(disk_severity(8 * GIB, 100 * GIB), ResourceSeverity::Warning);
        assert_eq!(disk_severity(GIB, 100 * GIB), ResourceSeverity::Critical);
    }

    #[test]
    fn live_sample_reports_memory_and_the_desktop_process() {
        let current = std::env::current_dir().expect("current directory should exist");
        let snapshot = sample_resource_health(default_resource_paths(&current, None), Vec::new())
            .expect("resource sampling should succeed");

        assert!(snapshot.sampled_at > 0);
        assert!(snapshot.memory.total_bytes > 0);
        assert!(!snapshot.volumes.is_empty());
        assert!(snapshot
            .volumes
            .iter()
            .all(|volume| volume.total_bytes > 0 && volume.available_bytes <= volume.total_bytes));
        assert!(snapshot
            .processes
            .iter()
            .any(|process| process.source == "desktop" && process.resident_bytes > 0));
    }

    #[test]
    fn missing_target_is_not_substituted_with_parent_volume() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let missing = std::env::temp_dir().join(format!(
            "omp-resource-missing-{}-{nonce}",
            std::process::id()
        ));
        let error = sample_volumes(vec![ResourcePath {
            purpose: "workspace",
            path: missing.clone(),
        }])
        .expect_err("a missing target must fail instead of sampling its parent");
        assert!(error.contains(missing.to_string_lossy().as_ref()));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn tmpfs_target_is_not_substituted_with_parent_volume() {
        use std::os::unix::fs::MetadataExt;

        let root = std::path::PathBuf::from("/");
        let tmpfs = std::path::PathBuf::from("/dev/shm");
        if !tmpfs.is_dir()
            || std::fs::metadata(&root)
                .expect("root metadata should exist")
                .dev()
                == std::fs::metadata(&tmpfs)
                    .expect("tmpfs metadata should exist")
                    .dev()
        {
            return;
        }

        let volumes = sample_volumes(vec![
            ResourcePath {
                purpose: "root",
                path: root,
            },
            ResourcePath {
                purpose: "temporary",
                path: tmpfs,
            },
        ])
        .expect("both filesystems should be sampled directly");
        assert_eq!(volumes.len(), 2);
        let temporary = volumes
            .iter()
            .find(|volume| volume.purposes.iter().any(|purpose| purpose == "temporary"))
            .expect("tmpfs volume should remain visible");
        assert!(temporary.mount_path.starts_with("/dev/shm"));
        assert!(temporary.total_bytes > 0);
    }
}
