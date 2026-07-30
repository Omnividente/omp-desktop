import { describe, expect, it } from "vitest"
import {
  matchesSelector,
  selectorWithThinking,
  splitSelector,
  thinkingLevelsForModel,
} from "./ModelPicker"
import type { OmpModelInfo } from "./types"

const model: OmpModelInfo = {
  provider: "anthropic",
  id: "claude-sonnet-4-20250514",
  selector: "claude-sonnet-4",
  name: "Claude Sonnet 4",
  available: true,
  status: "ready",
  detail: null,
  thinking: ["low", "high"],
}

describe("splitSelector", () => {
  it.each([
    ["claude-sonnet-4:off", "off"],
    ["claude-sonnet-4:HIGH", "high"],
    ["anthropic/claude-sonnet-4-20250514:xhigh", "xhigh"],
    ["claude-sonnet-4:auto", "auto"],
  ])("splits the supported thinking suffix from %s", (selector, thinking) => {
    expect(splitSelector(selector)).toEqual({
      base: selector.slice(0, selector.lastIndexOf(":")),
      thinking,
    })
  })

  it("keeps an unsupported suffix as part of the selector", () => {
    expect(splitSelector("claude-sonnet-4:turbo")).toEqual({
      base: "claude-sonnet-4:turbo",
      thinking: null,
    })
  })
})

describe("matchesSelector", () => {
  it.each([
    "claude-sonnet-4",
    "CLAUDE-SONNET-4:HIGH",
    "claude-sonnet-4-20250514",
    "anthropic/claude-sonnet-4-20250514:low",
  ])("matches the model's canonical selector or id form: %s", (selector) => {
    expect(matchesSelector(model, selector)).toBe(true)
  })

  it("rejects another model selector", () => {
    expect(matchesSelector(model, "anthropic/claude-opus-4")).toBe(false)
  })
})

describe("thinking selector controls", () => {
  it("offers only the levels reported for the selected model", () => {
    expect(thinkingLevelsForModel({ ...model, thinking: ["low", "high", "low"] })).toEqual([
      "low",
      "high",
    ])
  })

  it("replaces or removes a configured thinking suffix", () => {
    expect(selectorWithThinking("anthropic/claude-sonnet-4:low", "high")).toBe(
      "anthropic/claude-sonnet-4:high",
    )
    expect(selectorWithThinking("ollama/qwen3:30b", null)).toBe("ollama/qwen3:30b")
  })
})
