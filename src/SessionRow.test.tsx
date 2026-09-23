/** @vitest-environment jsdom */

import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SessionRow } from "./SessionRow"
import { SessionList } from "./SessionList"
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

function RenameFixture({
  onSave,
  onLaunch,
  onSelect,
  removeOnFinish = false,
}: {
  onSave: (title: string) => void | Promise<void>
  onLaunch: () => void
  onSelect: () => void
  removeOnFinish?: boolean
}) {
  const [sessions, setSessions] = useState([session])
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(session.id)
  const [renameValue, setRenameValue] = useState("Changed title")
  const finish = () => {
    setRenamingSessionId(null)
    if (removeOnFinish) setSessions([])
  }
  const submit = () => {
    const saved = onSave(renameValue)
    const complete = () =>
      setSessions((current) =>
        removeOnFinish ? [] : current.map((item) => ({ ...item, title: renameValue })),
      )
    if (saved) void saved.then(complete)
    else complete()
    setRenamingSessionId(null)
  }
  return (
    <>
      <button className="outside-list" type="button">
        Outside list
      </button>
      <SessionList
        allSessions={sessions}
        canLaunch
        deletingSessionId={null}
        lang="ru"
        launching={null}
        onClearSearch={vi.fn()}
        onDeleteSession={vi.fn()}
        onImportOmp={vi.fn()}
        onLaunchSession={onLaunch}
        onLoadTranscript={vi.fn()}
        onNewSession={onLaunch}
        onOpenCodex={vi.fn()}
        onRenameKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            submit()
          } else if (event.key === "Escape") {
            event.preventDefault()
            finish()
          }
        }}
        onRenameValueChange={setRenameValue}
        onRevealWorkspace={vi.fn()}
        onSearchChange={vi.fn()}
        onSelectSession={onSelect}
        onStartRename={() => setRenamingSessionId(session.id)}
        onSubmitRename={submit}
        onToggleTitlePin={vi.fn()}
        platform="linux"
        renameValue={renameValue}
        renamingSessionId={renamingSessionId}
        search=""
        selectedSessionId={session.id}
        selectedWorkspaceName="Project"
        selectedWorkspacePath={session.cwd}
        tabs={[]}
        visibleSessions={sessions}
        workspaceSessionsCount={sessions.length}
      />
    </>
  )
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
    const onLaunch = vi.fn()
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
          onDoubleLaunch={onLaunch}
          onKeySelect={onKeySelect}
          onLaunch={onLaunch}
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

    expect(document.activeElement).toBe(input)
    expect(onLaunch).not.toHaveBeenCalled()
    expect(onKeySelect).not.toHaveBeenCalled()
  })

  it.each(["Enter", "Escape"])("returns keyboard focus to the session after %s", (key) => {
    const onSave = vi.fn()
    const onLaunch = vi.fn()
    const onSelect = vi.fn()
    act(() =>
      root.render(<RenameFixture onSave={onSave} onLaunch={onLaunch} onSelect={onSelect} />),
    )
    const input = container.querySelector<HTMLInputElement>(".session-rename")!
    expect(document.activeElement).toBe(input)

    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }))
      // A blur before React commits the unmount must not submit the draft again.
      input.blur()
    })

    expect(input.isConnected).toBe(false)
    expect(document.activeElement).toBe(container.querySelector(".session-select"))
    expect(container.querySelector(".session-select strong")?.textContent).toBe(
      key === "Enter" ? "Changed title" : "Initial title",
    )
    if (key === "Enter") {
      expect(onSave).toHaveBeenCalledExactlyOnceWith("Changed title")
    } else {
      expect(onSave).not.toHaveBeenCalled()
    }
    expect(onLaunch).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("saves on ordinary blur without taking focus from the chosen control", () => {
    const onSave = vi.fn()
    const onLaunch = vi.fn()
    const onSelect = vi.fn()
    act(() =>
      root.render(<RenameFixture onSave={onSave} onLaunch={onLaunch} onSelect={onSelect} />),
    )
    const outside = container.querySelector<HTMLButtonElement>(".outside-list")!

    act(() => outside.focus())

    expect(container.querySelector(".session-rename")).toBeNull()
    expect(document.activeElement).toBe(outside)
    expect(onSave).toHaveBeenCalledExactlyOnceWith("Changed title")
    expect(onLaunch).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("focuses the accessible list when the edited session disappears on completion", () => {
    const onSave = vi.fn()
    act(() =>
      root.render(
        <RenameFixture onSave={onSave} onLaunch={vi.fn()} onSelect={vi.fn()} removeOnFinish />,
      ),
    )
    const input = container.querySelector<HTMLInputElement>(".session-rename")!

    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        }),
      ),
    )

    expect(container.querySelector(".session-item")).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('[role="region"][aria-label]'))
    expect(onSave).toHaveBeenCalledExactlyOnceWith("Changed title")
  })

  it.each([false, true])(
    "handles delayed disappearance after rename without stealing external focus (%s)",
    async (moveFocusOutside) => {
      let complete!: () => void
      const saved = new Promise<void>((resolve) => {
        complete = resolve
      })
      act(() =>
        root.render(
          <RenameFixture
            onSave={() => saved}
            onLaunch={vi.fn()}
            onSelect={vi.fn()}
            removeOnFinish
          />,
        ),
      )
      const input = container.querySelector<HTMLInputElement>(".session-rename")!
      act(() =>
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Enter",
          }),
        ),
      )
      expect(document.activeElement).toBe(container.querySelector(".session-select"))
      const outside = container.querySelector<HTMLButtonElement>(".outside-list")!
      if (moveFocusOutside) act(() => outside.focus())

      await act(async () => complete())

      expect(container.querySelector(".session-item")).toBeNull()
      expect(document.activeElement).toBe(
        moveFocusOutside ? outside : container.querySelector('[role="region"][aria-label]'),
      )
    },
  )
})
