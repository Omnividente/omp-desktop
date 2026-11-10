import { Fragment } from "react"
import { t, type Lang } from "./i18n"
import { modelMetadataNumber, modelPricingStatus } from "./modelPassportMetadata"
import type { OmpModelInfo } from "./types"

function passportRows(model: OmpModelInfo | undefined, language: Lang): string[][] {
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
  return [
    [t(language, "modelPassportSelector"), model?.selector ?? unknown],
    [t(language, "modelPassportContext"), modelMetadataNumber(model?.contextWindow) ?? unknown],
    [t(language, "modelPassportOutput"), modelMetadataNumber(model?.maxTokens) ?? unknown],
    [
      t(language, "modelPassportReasoning"),
      model?.reasoning === true
        ? t(language, "modelPassportYes")
        : model?.reasoning === false
          ? t(language, "modelPassportNo")
          : unknown,
    ],
    [t(language, "modelPassportInput"), model?.input?.length ? model.input.join(", ") : unknown],
    [t(language, "modelPassportPricing"), model ? statuses[modelPricingStatus(model)] : unknown],
    ...(["input", "output", "cacheRead", "cacheWrite"] as const).map((leg) => [
      rateLabels[leg],
      modelMetadataNumber(model?.cost?.[leg]) ?? unknown,
    ]),
  ]
}

export function ModelPassport({ model, language }: { model: OmpModelInfo; language: Lang }) {
  return (
    <details className="model-passport">
      <summary>{t(language, "modelPassportTitle")}</summary>
      <dl>
        {passportRows(model, language).map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
      <p>{t(language, "modelPassportHelp")}</p>
    </details>
  )
}

export function ModelComparison({
  selected,
  candidate,
  language,
}: {
  selected: OmpModelInfo | undefined
  candidate: OmpModelInfo | undefined
  language: Lang
}) {
  const selectedRows = passportRows(selected, language)
  const candidateRows = passportRows(candidate, language)
  return (
    <details className="model-passport model-comparison">
      <summary>{t(language, "modelComparisonTitle")}</summary>
      <p>{t(language, "modelComparisonHelp")}</p>
      <table>
        <caption>{t(language, "modelComparisonTitle")}</caption>
        <thead>
          <tr>
            <td />
            <th scope="col">
              {t(language, "modelComparisonSelected")}
              <span>{selected?.name ?? t(language, "modelPassportUnknown")}</span>
            </th>
            <th scope="col">
              {t(language, "modelComparisonCandidate")}
              <span>{candidate?.name ?? t(language, "modelPassportUnknown")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {selectedRows.map(([label, value], index) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{value}</td>
              <td>{candidateRows[index][1]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>{t(language, "modelPassportHelp")}</p>
    </details>
  )
}
