import { expect, it } from "vitest"
import { modelMetadataNumber, modelPricingStatus } from "./modelPassportMetadata"
import type { OmpModelInfo } from "./types"

const legacy: OmpModelInfo = {
  provider: "synthetic",
  id: "old",
  selector: "synthetic/old",
  name: "Old runtime",
  available: true,
  status: "ok",
  detail: null,
  thinking: [],
}

it("does not infer free pricing from absent or zero prices", () => {
  expect(modelPricingStatus(legacy)).toBe("unknown")
  expect(modelPricingStatus({ ...legacy, cost: { input: 0, output: 0 } })).toBe("unknown")
})

it("uses each declared pricing status and treats future states as unknown", () => {
  for (const pricingStatus of ["fixed", "free", "included", "variable", "unknown"] as const) {
    expect(modelPricingStatus({ ...legacy, pricingStatus })).toBe(pricingStatus)
  }
  expect(modelPricingStatus({ ...legacy, pricingStatus: "future-status" })).toBe("unknown")
})

it("preserves zero and small rates without rounding and rejects malformed metadata", () => {
  expect(modelMetadataNumber(0)).toBe("0")
  expect(modelMetadataNumber(0.000001)).toBe("0.000001")
  for (const value of [undefined, null, "0", -1, NaN, Infinity]) {
    expect(modelMetadataNumber(value)).toBeNull()
  }
})
