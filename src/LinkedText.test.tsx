/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { LinkedText, linkedTextContent } from "./LinkedText"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it("opens the destination behind a label and keeps unsafe content inert", () => {
  const container = document.createElement("div")
  const root = createRoot(container)
  const onOpen = vi.fn()
  try {
    act(() =>
      root.render(
        <LinkedText
          onOpen={onOpen}
          text={
            "[Отчёт](<local://Отчёт за день.md>) https://example.test/a. [Вредный](javascript:alert(1)) <script>alert(1)</script>"
          }
        />,
      ),
    )
    const links = container.querySelectorAll("a")
    expect(Array.from(links, (link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Отчёт", "local://Отчёт за день.md"],
      ["https://example.test/a", "https://example.test/a"],
    ])
    const click = new MouseEvent("click", { bubbles: true, cancelable: true })
    act(() => links[0].dispatchEvent(click))
    expect(click.defaultPrevented).toBe(true)
    expect(onOpen).toHaveBeenCalledWith("local://Отчёт за день.md")
    expect(container.querySelector("script")).toBeNull()
    expect(container.textContent).toContain("[Вредный](javascript:alert(1))")
  } finally {
    act(() => root.unmount())
  }
})

it("highlights an occurrence across a link boundary without duplicating text or changing its destination", () => {
  const container = document.createElement("div")
  const root = createRoot(container)
  const content = linkedTextContent("before [needle](local://needle.txt) after needle")
  const query = "re needle af"
  const start = content.text.indexOf(query)
  const last = content.text.lastIndexOf("needle")
  try {
    act(() =>
      root.render(
        <LinkedText
          text={content}
          onOpen={() => undefined}
          currentMatch={0}
          matches={[
            { start, end: start + query.length, index: 0 },
            { start: last, end: last + 6, index: 1 },
          ]}
        />,
      ),
    )
    expect(container.textContent).toBe("before needle after needle")
    expect(
      Array.from(container.querySelectorAll("mark.is-current"), (mark) => mark.textContent).join(
        "",
      ),
    ).toBe(query)
    expect(container.querySelector("a")?.getAttribute("href")).toBe("local://needle.txt")
    expect(container.querySelector("a mark.is-current")?.textContent).toBe("needle")
    expect(container.querySelector("mark:not(.is-current)")?.textContent).toBe("needle")
  } finally {
    act(() => root.unmount())
  }
})
