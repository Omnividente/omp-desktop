import { t, type Lang } from "./i18n"

export function ImportProject({
  language,
  targetPath,
}: {
  language: Lang
  targetPath: string | null
}) {
  return (
    <p className="field-help import-project">
      <strong>{t(language, "importProject")}</strong>
      <span className="import-project-path">{targetPath || t(language, "requireProjectDir")}</span>
    </p>
  )
}
