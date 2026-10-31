import { backendErrorCode } from "./api"
import { t, type Lang } from "./i18n"
import type { ImportItemResult } from "./types"

/** Import can reject an active session in this Desktop, not only another process. */
export function importFailureMessage(item: ImportItemResult, language: Lang): string {
  const detail = item.message ?? item.sourcePath
  if (backendErrorCode(item.message) !== "session_lease_active") return detail
  // Keep the original diagnostic: it can contain a target path absent from the result.
  return `${t(language, "importSessionInUse")}\n${detail}`
}
