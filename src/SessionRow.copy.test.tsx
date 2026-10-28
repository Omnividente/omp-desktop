/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { SessionRow } from "./SessionRow"
import type { SessionSummary } from "./types"
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
it.each([false, true])(
  "exposes the fixed-height grid variant with copy action %s (not browser geometry)",
  (copy) => {
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    const callback = vi.fn()
    try {
      act(() =>
        root.render(
          <SessionRow
            session={
              {
                id: "synthetic",
                title: "A long synthetic session title",
                updatedAt: 1,
              } as SessionSummary
            }
            lang="en"
            selected={false}
            busy={false}
            renaming={false}
            sessionOpen={false}
            sessionRunning={false}
            sessionThinking={false}
            deleting={false}
            actionsDisabled={false}
            renameValue=""
            launchDisabled={false}
            depth={0}
            hasChildren={false}
            childrenExpanded={false}
            onSelect={callback}
            onDoubleLaunch={callback}
            onKeySelect={callback}
            onToggleChildren={callback}
            onLaunch={callback}
            onTranscript={callback}
            onStartRename={callback}
            onToggleTitlePin={callback}
            onDelete={callback}
            onSubmitRename={callback}
            onRenameChange={callback}
            onRenameKeyDown={callback}
            onCopyToWorkspace={copy ? callback : undefined}
          />,
        ),
      )
      const row = container.querySelector(".session-item")!
      expect(row.children).toHaveLength(copy ? 8 : 7)
      expect(row.classList.contains("has-copy-action")).toBe(copy)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  },
)
