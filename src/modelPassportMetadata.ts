import type { OmpModelInfo } from "./types"

export type ModelPricingStatus = "fixed" | "free" | "included" | "variable" | "unknown"

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
