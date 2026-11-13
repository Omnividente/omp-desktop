/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { CodexImportModal } from "./CodexImportModal"
import { ImportSessionModal } from "./ImportSessionModal"
import { t, type Lang } from "./i18n"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const source = {
  id: "synthetic-source",
  title: "Same project name",
  cwd: "/synthetic/source-project",
  filePath: "/synthetic/source.jsonl",
  createdAt: "2026-01-01",
  updatedAt: 1,
  model: null,
  preview: "",
}

function renderDialog(
  kind: "omp" | "codex",
  language: Lang,
  targetPath: string | null,
  importing = false,
) {
  const onImport = vi.fn()
  const onClose = vi.fn()
  const shared = {
    language,
    targetPath,
    importing,
    mode: "update" as const,
    onImport,
    onClose,
    onModeChange: vi.fn(),
  }
  act(() =>
    root.render(
      kind === "omp" ? (
        <ImportSessionModal {...shared} path={source.filePath} />
      ) : (
        <CodexImportModal
          {...shared}
          loading={false}
          sessions={[source]}
          selected={{ [source.filePath]: true }}
          onSelectedChange={vi.fn()}
        />
      ),
    ),
  )
  return { onImport, onClose }
}

for (const kind of ["omp", "codex"] as const) {
  it.each(["ru", "en"] as const)(
    `shows the exact selected project as inert text in ${kind} import (%s)`,
    (language) => {
      const path = " /synthetic/Проект & <img src=x>/same name/" + "x".repeat(200) + "  "
      const callbacks = renderDialog(kind, language, path)
      expect(container.querySelector(".import-project strong")?.textContent).toBe(
        t(language, "importProject"),
      )
      expect(container.querySelector(".import-project-path")?.textContent).toBe(path)
      expect(container.querySelector(".import-project-path img")).toBeNull()
      expect(container.querySelector(".import-project-path a")).toBeNull()
      expect(callbacks.onImport).not.toHaveBeenCalled()
      expect(container.querySelector<HTMLSelectElement>("select")?.value).toBe("update")
      act(() => container.querySelector<HTMLButtonElement>("header button")!.click())
      expect(callbacks.onClose).toHaveBeenCalledOnce()
      expect(callbacks.onImport).not.toHaveBeenCalled()
    },
  )

  it.each([null, ""])(`disables ${kind} confirmation without a project (%s)`, (path) => {
    const callbacks = renderDialog(kind, "en", path)
    const confirm = container.querySelector<HTMLButtonElement>(".primary")!
    expect(container.querySelector(".import-project-path")?.textContent).toBe(
      t("en", "requireProjectDir"),
    )
    expect(confirm.disabled).toBe(true)
    act(() => confirm.click())
    expect(callbacks.onImport).not.toHaveBeenCalled()
  })

  it(`updates ${kind} project disclosure without trimming or changing import mode`, () => {
    renderDialog(kind, "en", "/synthetic/first/same name")
    const callbacks = renderDialog(kind, "en", " C:\\synthetic\\second\\same name ")
    expect(container.querySelector(".import-project-path")?.textContent).toBe(
      " C:\\synthetic\\second\\same name ",
    )
    const confirm = container.querySelector<HTMLButtonElement>(".primary")!
    expect(confirm.disabled).toBe(false)
    expect(container.querySelector<HTMLSelectElement>("select")?.value).toBe("update")
    act(() => confirm.click())
    expect(callbacks.onImport).toHaveBeenCalledOnce()
    renderDialog(kind, "en", " C:\\synthetic\\second\\same name ", true)
    expect(container.querySelector<HTMLButtonElement>(".primary")?.disabled).toBe(true)
  })
}
