import { t, type Lang } from "./i18n"
import type { OmpAgentDefinitionField, OmpAgentInfo } from "./types"

const fields = [
  ["tools", "agentPassportTools"],
  ["spawns", "agentPassportSpawns"],
  ["thinkingLevel", "agentPassportThinking"],
  ["output", "agentPassportOutput"],
  ["blocking", "agentPassportBlocking"],
  ["structured", "agentPassportStructured"],
] as const

// Defense in depth for an older or future bridge. Render text only, never markup.
function boundedText(value: unknown): string {
  if (typeof value !== "string") return ""
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
  return text.length > 512 ? `${text.slice(0, 512)}…` : text
}

function fieldText(
  field: OmpAgentDefinitionField | undefined,
  language: Lang,
  key: string,
): string {
  if (!field) return t(language, "agentPassportUnknown")
  if (
    key === "output" &&
    ["value", "truncated"].includes(field.state) &&
    !/^(object \(\d+ fields\)|array \(\d+ items\)|string|boolean|number)$/.test(field.text ?? "")
  )
    return t(language, "agentPassportUnsupported")
  switch (field.state) {
    case "absent":
      return t(language, "agentPassportAbsent")
    case "null":
      return t(language, "agentPassportNull")
    case "empty":
      return t(language, "agentPassportEmpty")
    case "wildcard":
      return t(language, "agentPassportWildcard")
    case "unsupported":
      return t(language, "agentPassportUnsupported")
    case "truncated":
      return `${t(language, "agentPassportTruncated")}: ${boundedText(field.text)}`
    case "value":
      return boundedText(field.text) || t(language, "agentPassportUnknown")
    default:
      return t(language, "agentPassportUnknown")
  }
}

export function AgentDefinitionPassport({
  agent,
  language,
}: {
  agent: OmpAgentInfo
  language: Lang
}) {
  const definition = agent.definition
  const observed = definition?.observedAt
  const date =
    typeof observed === "number" && Number.isFinite(observed) && observed > 0
      ? new Date(observed)
      : null
  const stamp = date && Number.isFinite(date.getTime()) ? date.toISOString() : null
  return (
    <details className="agent-definition-passport">
      <summary>{t(language, "agentPassportTitle")}</summary>
      <p className="field-help">{t(language, "agentPassportHelp")}</p>
      {!definition ? (
        <p>{t(language, "agentPassportUnavailable")}</p>
      ) : (
        <>
          {agent.source === "bundled" && (
            <p className="field-help">{t(language, "agentPassportExport")}</p>
          )}
          <dl className="agent-definition" style={{ overflowWrap: "anywhere" }}>
            <dt>{t(language, "agentPassportSourceFile")}</dt>
            <dd>
              {boundedText(definition.sourceFile) || t(language, "agentPassportUnknown")}
              {definition.sourceFileTruncated ? ` (${t(language, "agentPassportTruncated")})` : ""}
            </dd>
            <dt>{t(language, "agentPassportObserved")}</dt>
            <dd>
              {stamp ? <time dateTime={stamp}>{stamp}</time> : t(language, "agentPassportUnknown")}
            </dd>
            <dt>{t(language, "agentPassportContext")}</dt>
            <dd>
              <p className="field-help">{t(language, "agentPassportContextHelp")}</p>
              {definition.contextCwd ? (
                <details>
                  <summary>{t(language, "agentPassportContextReveal")}</summary>
                  {boundedText(definition.contextCwd)}
                  {typeof definition.contextCwd === "string" && definition.contextCwd.length > 512
                    ? ` (${t(language, "agentPassportTruncated")})`
                    : ""}
                </details>
              ) : (
                t(language, "agentPassportUnknown")
              )}
            </dd>
            {fields.map(([key, label]) => (
              <div key={key}>
                <dt>{t(language, label)}</dt>
                <dd>{fieldText(definition.fields?.[key], language, key)}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </details>
  )
}
