import { t, type Lang } from "./i18n"
import type { ImportMode } from "./types"

interface ImportModeSelectProps {
  disabled?: boolean
  language: Lang
  mode: ImportMode
  onChange: (mode: ImportMode) => void
}

export function ImportModeSelect({
  disabled = false,
  language,
  mode,
  onChange,
}: ImportModeSelectProps) {
  return (
    <label className="import-mode-field">
      <span>{t(language, "importMode")}</span>
      <select
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as ImportMode)}
        value={mode}
      >
        <option value="skip">{t(language, "importModeSkip")}</option>
        <option value="update">{t(language, "importModeUpdate")}</option>
        <option value="copy">{t(language, "importModeCopy")}</option>
      </select>
    </label>
  )
}
