import { t, type Lang } from "./i18n"
import type { ResourceHealthSnapshot, ResourceSeverity } from "./types"

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  const precision = value >= 100 || exponent === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(precision)} ${units[exponent]}`
}

export function resourceSeverityLabel(language: Lang, severity: ResourceSeverity): string {
  if (severity === "critical") return t(language, "resourceCritical")
  if (severity === "warning") return t(language, "resourceWarning")
  return t(language, "resourceOk")
}

export function resourcePurposeLabel(language: Lang, purpose: string): string {
  if (purpose === "sessions") return t(language, "resourcePurposeSessions")
  if (purpose === "workspace") return t(language, "resourcePurposeWorkspace")
  if (purpose === "temporary") return t(language, "resourcePurposeTemporary")
  return purpose
}

export function resourceWarningCount(snapshot: ResourceHealthSnapshot | null): number {
  if (!snapshot) return 0
  return (
    Number(snapshot.memory.severity !== "ok") +
    snapshot.volumes.filter((volume) => volume.severity !== "ok").length
  )
}
