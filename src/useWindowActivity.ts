import { getCurrentWindow, ProgressBarStatus } from "@tauri-apps/api/window"
import { useEffect, useRef } from "react"
import type { TerminalTab } from "./types"

export function useWindowActivity(tabs: TerminalTab[], activeTabId: string | null): void {
  const lastProgressRequest = useRef<{ thinking: boolean } | null>(null)

  useEffect(() => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId)
    const thinkingCount = tabs.filter((tab) => tab.activity === "thinking").length
    if (activeTab?.activity === "thinking") {
      document.title = `[Thinking...] ${activeTab.label} — OMP Desktop`
    } else if (thinkingCount > 0) {
      document.title = `[Thinking ×${thinkingCount}] OMP Desktop`
    } else if (activeTab) {
      document.title = `${activeTab.label} — OMP Desktop`
    } else {
      document.title = "OMP Desktop"
    }

    const thinking = thinkingCount > 0
    if (lastProgressRequest.current?.thinking === thinking) return
    const request = { thinking }
    lastProgressRequest.current = request
    // Retry after failure on the next existing update, without a retry timer.
    // An older failure must not invalidate a newer status request.
    const retryAfterFailure = () => {
      if (lastProgressRequest.current === request) lastProgressRequest.current = null
    }

    try {
      void getCurrentWindow()
        .setProgressBar({
          status: thinking ? ProgressBarStatus.Indeterminate : ProgressBarStatus.None,
        })
        .catch(retryAfterFailure)
    } catch {
      retryAfterFailure()
      // The browser preview has no native taskbar window.
    }
  }, [activeTabId, tabs])
}
