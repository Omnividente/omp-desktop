import { getCurrentWindow, ProgressBarStatus } from "@tauri-apps/api/window"
import { useEffect } from "react"
import type { TerminalTab } from "./types"

export function useWindowActivity(tabs: TerminalTab[], activeTabId: string | null): void {
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

    try {
      void getCurrentWindow()
        .setProgressBar({
          status: thinkingCount > 0 ? ProgressBarStatus.Indeterminate : ProgressBarStatus.None,
        })
        .catch(() => undefined)
    } catch {
      // The browser preview has no native taskbar window.
    }
  }, [activeTabId, tabs])
}
