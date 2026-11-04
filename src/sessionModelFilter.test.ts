import { describe, expect, it } from "vitest"
import { filterSessionsByModel, sessionModelKey, sessionModelOptions } from "./sessionModelFilter"
import type { SessionSummary } from "./types"

const fixture = (id: string, model: string | null) => ({ id, model }) as SessionSummary

describe("recorded session model filter", () => {
  it("preserves the original array for all models and stable order for a chosen model", () => {
    const sessions = [fixture("a", "alpha"), fixture("b", "beta"), fixture("c", "alpha")]
    expect(filterSessionsByModel(sessions, null)).toBe(sessions)
    expect(filterSessionsByModel(sessions, "alpha")).toEqual([sessions[0], sessions[2]])
  })

  it("groups null and empty metadata without confusing them with the all-model state", () => {
    const sessions = [fixture("a", null), fixture("b", ""), fixture("c", "null")]
    expect(sessionModelKey(sessions[0])).toBe("")
    expect(filterSessionsByModel(sessions, "")).toEqual([sessions[0], sessions[1]])
    expect(filterSessionsByModel(sessions, "null")).toEqual([sessions[2]])
  })

  it("does not fold, trim, normalize or substring-match opaque model identities", () => {
    const models = ["alpha", "ALPHA", "alpha-long", " alpha ", "é", "e\u0301"]
    const sessions = models.map((model) => fixture(model, model))
    for (const session of sessions) {
      expect(filterSessionsByModel(sessions, session.model)).toEqual([session])
    }
  })

  it("uses model metadata only, even if the title or id matches a different model", () => {
    const sessions = [{ ...fixture("alpha", "beta"), title: "alpha" }, fixture("b", "alpha")]
    expect(filterSessionsByModel(sessions, "alpha")).toEqual([sessions[1]])
  })

  it("keeps a selected model option after its last session disappears", () => {
    expect(sessionModelOptions([fixture("a", "beta")], "alpha")).toEqual(["alpha", "beta"])
    expect(filterSessionsByModel([fixture("a", "beta")], "alpha")).toEqual([])
    expect(sessionModelOptions([], "")).toEqual([""])
    expect(sessionModelOptions([], null)).toEqual([])
  })

  it("deduplicates and sorts options without object-key or sentinel collisions", () => {
    const models = ["__proto__", "constructor", "all", "", "alpha", "alpha"]
    const sessions = models.map((model) => fixture(model, model))
    expect(sessionModelOptions(sessions, null)).toEqual([
      "",
      "__proto__",
      "all",
      "alpha",
      "constructor",
    ])
    expect(filterSessionsByModel(sessions, "all")).toEqual([sessions[2]])
    expect(sessions.map((session) => session.model)).toEqual(models)
  })
})
