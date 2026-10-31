/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { SessionRow } from "./SessionRow"
import type { SessionSummary } from "./types"
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const session: SessionSummary = {
  id: "synthetic",
  title: "A long synthetic session title",
  pinnedTitle: null,
  cwd: "/synthetic",
  projectKey: "/synthetic",
  filePath: "/synthetic/session.jsonl",
  parentSessionPath: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: 1,
  model: null,
  thinkingLevel: null,
  configuredThinkingLevel: null,
  source: "omp",
  hasMessages: true,
  primaryProviderPinned: false,
}

it.each([
  {
    state: "idle",
    actionsDisabled: false,
    busy: false,
    sessionRunning: false,
    renaming: false,
    available: true,
  },
  {
    state: "actions disabled",
    actionsDisabled: true,
    busy: false,
    sessionRunning: false,
    renaming: false,
    available: false,
  },
  {
    state: "launch pending",
    actionsDisabled: false,
    busy: true,
    sessionRunning: false,
    renaming: false,
    available: false,
  },
  {
    state: "running",
    actionsDisabled: false,
    busy: false,
    sessionRunning: true,
    renaming: false,
    available: false,
  },
  {
    state: "renaming",
    actionsDisabled: false,
    busy: false,
    sessionRunning: false,
    renaming: true,
    available: false,
  },
])("only copies explicitly when $state", (scenario) => {
  const { actionsDisabled, busy, sessionRunning, renaming, available } = scenario
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const copy = vi.fn()
  const select = vi.fn()
  const launch = vi.fn()
  const noop = () => undefined
  try {
    act(() =>
      root.render(
        <SessionRow
          session={session}
          lang="en"
          selected={false}
          busy={busy}
          renaming={renaming}
          sessionOpen={sessionRunning}
          sessionRunning={sessionRunning}
          sessionThinking={false}
          deleting={false}
          actionsDisabled={actionsDisabled}
          renameValue={session.title}
          launchDisabled={false}
          depth={0}
          hasChildren={false}
          childrenExpanded={false}
          onSelect={select}
          onDoubleLaunch={launch}
          onKeySelect={select}
          onToggleChildren={noop}
          onLaunch={launch}
          onTranscript={noop}
          onStartRename={noop}
          onToggleTitlePin={noop}
          onDelete={noop}
          onSubmitRename={noop}
          onRenameChange={noop}
          onRenameKeyDown={noop}
          onCopyToWorkspace={copy}
        />,
      ),
    )
    expect(copy).not.toHaveBeenCalled()
    const button = container.querySelector<HTMLButtonElement>(
      '[title="Copy session to another project"]',
    )
    if (renaming) expect(button).toBeNull()
    else {
      expect(button?.disabled).toBe(!available)
      act(() => button!.click())
    }
    expect(copy).toHaveBeenCalledTimes(available ? 1 : 0)
    expect(select).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
