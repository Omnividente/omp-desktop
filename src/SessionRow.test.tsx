/** @vitest-environment jsdom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SessionRow } from "./SessionRow"
import type { SessionSummary } from "./types"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const session: SessionSummary = {
  id: "session-1",
  title: "Initial title",
  pinnedTitle: null,
  cwd: "/tmp/project",
  projectKey: "/tmp/project",
  filePath: "/tmp/session.jsonl",
  parentSessionPath: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: 1,
  model: null,
  thinkingLevel: null,
  configuredThinkingLevel: null,
  source: "omp",
  hasMessages: true,
  primaryProviderPinned: false,
}

describe("SessionRow rename input", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it("keeps Space inside the rename input", () => {
    const onKeySelect = vi.fn()
    const onRenameKeyDown = vi.fn()
    act(() => {
      root.render(
        <SessionRow
          actionsDisabled={false}
          busy={false}
          childrenExpanded={false}
          deleting={false}
          depth={0}
          hasChildren={false}
          lang="ru"
          launchDisabled={false}
          onDelete={vi.fn()}
          onDoubleLaunch={vi.fn()}
          onKeySelect={onKeySelect}
          onLaunch={vi.fn()}
          onRenameChange={vi.fn()}
          onRenameKeyDown={onRenameKeyDown}
          onSelect={vi.fn()}
          onStartRename={vi.fn()}
          onSubmitRename={vi.fn()}
          onToggleChildren={vi.fn()}
          onToggleTitlePin={vi.fn()}
          onTranscript={vi.fn()}
          renameValue="Initial title"
          renaming
          selected={false}
          session={session}
          sessionOpen={false}
          sessionRunning={false}
          sessionThinking={false}
        />,
      )
    })

    const input = container.querySelector<HTMLInputElement>(".session-rename")
    act(() => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: " " }))
    })

    expect(onRenameKeyDown).toHaveBeenCalledOnce()
    expect(onKeySelect).not.toHaveBeenCalled()
  })
})
