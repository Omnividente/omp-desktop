import { Fragment } from "react"
import { t, type Lang } from "./i18n"
import { modelMetadataNumber, modelPricingStatus } from "./modelPassport"
import type { OmpModelInfo } from "./types"

export function ModelPassport({ model, language }: { model: OmpModelInfo; language: Lang }) {
  const unknown = t(language, "modelPassportUnknown")
  const statuses = {
    fixed: t(language, "modelPassportFixed"),
    free: t(language, "modelPassportFree"),
    included: t(language, "modelPassportIncluded"),
    variable: t(language, "modelPassportVariable"),
    unknown,
  }
  const rateLabels = {
    input: t(language, "modelPassportInputRate"),
    output: t(language, "modelPassportOutputRate"),
    cacheRead: t(language, "modelPassportCacheReadRate"),
    cacheWrite: t(language, "modelPassportCacheWriteRate"),
  }
  const declaredInput = model.input?.length ? model.input.join(", ") : unknown
  return (
    <details className="model-passport">
      <summary>{t(language, "modelPassportTitle")}</summary>
      <dl>
        <dt>{t(language, "modelPassportContext")}</dt>
        <dd>{modelMetadataNumber(model.contextWindow) ?? unknown}</dd>
        <dt>{t(language, "modelPassportOutput")}</dt>
        <dd>{modelMetadataNumber(model.maxTokens) ?? unknown}</dd>
        <dt>{t(language, "modelPassportReasoning")}</dt>
        <dd>
          {model.reasoning === true
            ? t(language, "modelPassportYes")
            : model.reasoning === false
              ? t(language, "modelPassportNo")
              : unknown}
        </dd>
        <dt>{t(language, "modelPassportInput")}</dt>
        <dd>{declaredInput}</dd>
        <dt>{t(language, "modelPassportPricing")}</dt>
        <dd>{statuses[modelPricingStatus(model)]}</dd>
        {(["input", "output", "cacheRead", "cacheWrite"] as const).map((leg) => (
          <Fragment key={leg}>
            <dt>{rateLabels[leg]}</dt>
            <dd>{modelMetadataNumber(model.cost?.[leg]) ?? unknown}</dd>
          </Fragment>
        ))}
      </dl>
      <p>{t(language, "modelPassportHelp")}</p>
    </details>
  )
}
