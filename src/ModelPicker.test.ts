import { describe, expect, it } from "vitest"
import {
  matchesSelector,
  normalizeThinkingLevel,
  selectorWithThinking,
  splitSelector,
  thinkingLevelsForModel,
  thinkingOptionsForModel,
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

const taggedModel: OmpModelInfo = {
  ...model,
  provider: "ollama",
  id: "llama3.1:8b",
  selector: "ollama/llama3.1:8b",
  name: "Llama 3.1 8B",
}

describe("splitSelector", () => {
  it.each([
    ["claude-sonnet-4:off", "off"],
    ["claude-sonnet-4:HIGH", "high"],
    ["anthropic/claude-sonnet-4-20250514:xhigh", "xhigh"],
    ["claude-sonnet-4:auto", "auto"],
    ["ollama/llama3.1:8b:high", "high"],
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
    expect(splitSelector("ollama/llama3.1:8b")).toEqual({
      base: "ollama/llama3.1:8b",
      thinking: null,
    })
    expect(splitSelector("ollama/llama3.1:8b:internal")).toEqual({
      base: "ollama/llama3.1:8b:internal",
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

  it("matches an Ollama tag with or without a final thinking suffix", () => {
    expect(matchesSelector(taggedModel, "ollama/llama3.1:8b")).toBe(true)
    expect(matchesSelector(taggedModel, "ollama/llama3.1:8b:high")).toBe(true)
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
    expect(selectorWithThinking("ollama/llama3.1:8b", "high")).toBe("ollama/llama3.1:8b:high")
  })

  it("maps the current reasoning level to the closest level supported by a new model", () => {
    expect(normalizeThinkingLevel("high", ["off", "auto", "medium"])).toBe("medium")
    expect(normalizeThinkingLevel("xhigh", ["off", "auto", "low", "high"])).toBe("high")
    expect(normalizeThinkingLevel("medium", ["off", "auto", "low", "high"])).toBe("low")
  })

  it("preserves exact levels and uses the configured fallback when no preference is usable", () => {
    expect(normalizeThinkingLevel("auto", ["off", "auto", "medium"])).toBe("auto")
    expect(normalizeThinkingLevel("unknown", ["off", "auto", "medium"], "medium")).toBe("medium")
    expect(normalizeThinkingLevel("high", [])).toBeNull()
  })

  it("builds the runtime thinking cycle from model capabilities", () => {
    expect(thinkingOptionsForModel({ ...model, thinking: ["medium", "high"] })).toEqual([
      "off",
      "auto",
      "medium",
      "high",
    ])
  })
})
