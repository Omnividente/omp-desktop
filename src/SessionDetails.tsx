import type { SessionSummary } from "./types"
import { t, type Lang } from "./i18n"
import { CopyButton } from "./CopyButton"

/** Only the summary returned with the loaded history, never live runtime state. */
export function SessionDetails({
  session,
  lang,
  onError,
}: {
  session: SessionSummary
  lang: Lang
  onError: (message: string) => void
}) {
  const fields = [
    [t(lang, "sessionDetailsId"), session.id],
    [t(lang, "sessionDetailsWorkspace"), session.cwd],
    [t(lang, "sessionDetailsFile"), session.filePath],
    [t(lang, "sessionDetailsCreated"), session.createdAt],
    [t(lang, "sessionDetailsModel"), session.model],
    [t(lang, "sessionDetailsPrevious"), session.parentSessionPath],
  ]

  return (
    <details className="session-details">
      <summary>{t(lang, "sessionDetails")}</summary>
      <div className="session-details-content" tabIndex={0}>
        <p>{t(lang, "sessionDetailsHelp")}</p>
        {session.filePath.trim() && (
          <p>
            <CopyButton
              text={session.filePath}
              scope={session}
              label={t(lang, "copySessionFilePath")}
              lang={lang}
              onError={onError}
            />
          </p>
        )}
        <dl>
          {fields.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value?.trim() ? value : t(lang, "sessionDetailsMissing")}</dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  )
}
