import { describe, expect, it } from "vitest"
import { formatBytes, resourceWarningCount } from "./resourceHealth"
import type { ResourceHealthSnapshot } from "./types"

function snapshot(): ResourceHealthSnapshot {
  return {
    sampledAt: 1,
    severity: "warning",
    memory: {
      availableBytes: 512 * 1024 * 1024,
      totalBytes: 16 * 1024 * 1024 * 1024,
      usedSwapBytes: 0,
      totalSwapBytes: 0,
      availableSeverity: "warning",
      swapSeverity: "ok",
      severity: "warning",
    },
    volumes: [
      {
        mountPath: "/",
        availableBytes: 20 * 1024 * 1024 * 1024,
        totalBytes: 100 * 1024 * 1024 * 1024,
        purposes: ["sessions", "workspace"],
        severity: "ok",
      },
      {
        mountPath: "/tmp",
        availableBytes: 1024 * 1024 * 1024,
        totalBytes: 10 * 1024 * 1024 * 1024,
        purposes: ["temporary"],
        severity: "critical",
      },
    ],
    processes: [],
  }
}

describe("resource health presentation", () => {
  it("uses binary units without displaying false precision", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512 * 1024 * 1024)).toBe("512 MiB")
    expect(formatBytes(15.5 * 1024 * 1024 * 1024)).toBe("15.5 GiB")
  })

  it("counts one persistent warning per pressured resource", () => {
    expect(resourceWarningCount(snapshot())).toBe(2)
    expect(resourceWarningCount(null)).toBe(0)
  })
})
