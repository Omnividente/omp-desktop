import type { OmpModelInfo } from "./types"

export type ModelPricingStatus = "fixed" | "free" | "included" | "variable" | "unknown"

// This identifies a catalog entry for display, not the runtime's effective model.
// Bare aliases may depend on runtime usage/provider preferences absent from the DTO.
export function catalogModelForSelector(
  models: OmpModelInfo[],
  selector: string,
  selectorWithoutThinking: string,
): OmpModelInfo | undefined {
  for (const candidate of new Set([selector, selectorWithoutThinking])) {
    const normalized = candidate.toLowerCase()
    const qualified = models.filter(
      (model) =>
        model.selector.toLowerCase() === normalized ||
        `${model.provider}/${model.id}`.toLowerCase() === normalized,
    )
    if (qualified.length > 0) return qualified.length === 1 ? qualified[0] : undefined
    const bare = models.filter((model) => model.id.toLowerCase() === normalized)
    // A slash may name a known provider unavailable in this catalog. Do not
    // reinterpret it as another provider's raw ID without runtime evidence,
    // or fall through a literal raw ID to a different thinking-suffix match.
    if (normalized.includes("/") && bare.length > 0) return undefined
    if (bare.length > 0) return bare.length === 1 ? bare[0] : undefined
  }
  return undefined
}

// The runtime supplies pricing status. In particular, zero rates do not mean free.
export function modelPricingStatus(model: OmpModelInfo): ModelPricingStatus {
  switch (model.pricingStatus) {
    case "fixed":
    case "free":
    case "included":
    case "variable":
      return model.pricingStatus
    default:
      return "unknown"
  }
}

export function modelMetadataNumber(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(value) : null
}
