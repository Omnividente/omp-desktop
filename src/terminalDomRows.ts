// xterm 6.0.0 internals, checked by the build-time DOM renderer transform.
interface ExtendedAttributes {
  ext: number
  urlId: number
}

interface BufferLine {
  _data: Uint32Array
  _combined: Record<string, string>
  _extendedAttrs: Record<string, ExtendedAttributes | undefined>
}

interface RowFactory {
  _coreService: { isCursorHidden: boolean; isCursorInitialized: boolean }
  _coreBrowserService: { isFocused: boolean }
  _characterJoinerService: { _characterJoiners: unknown[] }
  _decorationService: { decorations: IterableIterator<unknown> }
  createRow(
    line: BufferLine,
    rowNumber: number,
    isCursorRow: boolean,
    cursorStyle: string | undefined,
    cursorInactiveStyle: string | undefined,
    cursorX: number,
    cursorBlink: boolean,
    cellWidth: number,
    widthCache: object,
    linkStart: number,
    linkEnd: number,
  ): HTMLSpanElement[]
}

interface Renderer {
  _rowContainer: HTMLElement
  _rowFactory: RowFactory
}

interface RendererState {
  version: number
  cacheable: boolean
}

interface RowSnapshot extends BufferLine {
  renderer: Renderer
  version: number
  rowNumber: number
  cursorFlags: number
  cursorStyle: string | undefined
  cursorInactiveStyle: string | undefined
  cursorX: number
  cellWidth: number
  widthCache: object
  linkStart: number
  linkEnd: number
}

const rendererStates = new WeakMap<Renderer, RendererState>()
const rowSnapshots = new WeakMap<HTMLElement, RowSnapshot>()

export function invalidateTerminalRows(renderer: Renderer): void {
  const state = rendererStates.get(renderer)
  if (state) state.version += 1
}

export function beginTerminalRows(renderer: Renderer): void {
  if (!renderer._rowContainer.hasAttribute("data-omp-reuse-dom-rows")) return
  let state = rendererStates.get(renderer)
  if (!state) {
    state = { version: 0, cacheable: true }
    rendererStates.set(renderer, state)
  }
  const factory = renderer._rowFactory
  // Extension callbacks may change output without changing the buffer.
  state.cacheable =
    factory._characterJoinerService._characterJoiners.length === 0 &&
    factory._decorationService.decorations.next().done === true
  if (!state.cacheable) state.version += 1
}

function sameBuffer(snapshot: RowSnapshot, line: BufferLine): boolean {
  const data = line._data
  if (snapshot._data.length !== data.length) return false
  for (let index = 0; index < data.length; index += 1) {
    if (snapshot._data[index] !== data[index]) return false
  }
  for (const key in line._combined) {
    if (snapshot._combined[key] !== line._combined[key]) return false
  }
  for (const key in snapshot._combined) {
    if (!(key in line._combined)) return false
  }
  for (const key in line._extendedAttrs) {
    const current = line._extendedAttrs[key]
    const previous = snapshot._extendedAttrs[key]
    if (current?.ext !== previous?.ext || current?.urlId !== previous?.urlId) return false
  }
  for (const key in snapshot._extendedAttrs) {
    if (!(key in line._extendedAttrs)) return false
  }
  return true
}

function copyBuffer(snapshot: RowSnapshot, line: BufferLine): void {
  if (snapshot._data.length !== line._data.length) {
    snapshot._data = new Uint32Array(line._data.length)
  }
  snapshot._data.set(line._data)
  for (const key in snapshot._combined) {
    if (!(key in line._combined)) delete snapshot._combined[key]
  }
  for (const key in line._combined) snapshot._combined[key] = line._combined[key]
  for (const key in snapshot._extendedAttrs) {
    if (!(key in line._extendedAttrs)) delete snapshot._extendedAttrs[key]
  }
  for (const key in line._extendedAttrs) {
    const current = line._extendedAttrs[key]
    if (current) {
      const previous = snapshot._extendedAttrs[key]
      if (previous) {
        previous.ext = current.ext
        previous.urlId = current.urlId
      } else {
        snapshot._extendedAttrs[key] = { ext: current.ext, urlId: current.urlId }
      }
    } else {
      snapshot._extendedAttrs[key] = undefined
    }
  }
}

export function renderTerminalRow(
  row: HTMLElement,
  renderer: Renderer,
  line: BufferLine,
  rowNumber: number,
  isCursorRow: boolean,
  cursorStyle: string | undefined,
  cursorInactiveStyle: string | undefined,
  cursorX: number,
  cursorBlink: boolean,
  cellWidth: number,
  widthCache: object,
  linkStart: number,
  linkEnd: number,
): void {
  const factory = renderer._rowFactory
  const enabled = row.parentElement?.hasAttribute("data-omp-reuse-dom-rows")
  const state = enabled ? rendererStates.get(renderer) : undefined
  const snapshot = state?.cacheable ? rowSnapshots.get(row) : undefined
  const flags = isCursorRow
    ? 1 |
      (factory._coreService.isCursorHidden ? 2 : 0) |
      (factory._coreService.isCursorInitialized ? 4 : 0) |
      (factory._coreBrowserService.isFocused ? 8 : 0) |
      (cursorBlink ? 16 : 0)
    : 0
  const activeCursorX = isCursorRow ? cursorX : -1
  const activeCursorStyle = isCursorRow ? cursorStyle : undefined
  const inactiveCursorStyle = isCursorRow ? cursorInactiveStyle : undefined
  if (
    snapshot &&
    snapshot.renderer === renderer &&
    snapshot.version === state?.version &&
    snapshot.rowNumber === rowNumber &&
    snapshot.cursorFlags === flags &&
    snapshot.cursorStyle === activeCursorStyle &&
    snapshot.cursorInactiveStyle === inactiveCursorStyle &&
    snapshot.cursorX === activeCursorX &&
    snapshot.cellWidth === cellWidth &&
    snapshot.widthCache === widthCache &&
    snapshot.linkStart === linkStart &&
    snapshot.linkEnd === linkEnd &&
    sameBuffer(snapshot, line)
  )
    return

  const spans = factory.createRow(
    line,
    rowNumber,
    isCursorRow,
    cursorStyle,
    cursorInactiveStyle,
    cursorX,
    cursorBlink,
    cellWidth,
    widthCache,
    linkStart,
    linkEnd,
  )
  replaceTerminalRow(row, spans)
  if (!state?.cacheable) return
  const next = snapshot ?? {
    _data: new Uint32Array(line._data.length),
    _combined: {},
    _extendedAttrs: {},
    renderer,
    version: state.version,
    rowNumber,
    cursorFlags: flags,
    cursorStyle: activeCursorStyle,
    cursorInactiveStyle: inactiveCursorStyle,
    cursorX: activeCursorX,
    cellWidth,
    widthCache,
    linkStart,
    linkEnd,
  }
  next.renderer = renderer
  next.version = state.version
  next.rowNumber = rowNumber
  next.cursorFlags = flags
  next.cursorStyle = activeCursorStyle
  next.cursorInactiveStyle = inactiveCursorStyle
  next.cursorX = activeCursorX
  next.cellWidth = cellWidth
  next.widthCache = widthCache
  next.linkStart = linkStart
  next.linkEnd = linkEnd
  copyBuffer(next, line)
  rowSnapshots.set(row, next)
}

// The marker is set only on Linux terminal row containers in TerminalView.
export function replaceTerminalRow(row: HTMLElement, spans: HTMLSpanElement[]): void {
  if (row.parentElement?.hasAttribute("data-omp-reuse-dom-rows")) {
    const children = row.childNodes
    if (children.length === spans.length) {
      let matches = true
      for (let index = 0; index < spans.length; index += 1) {
        if (!children[index].isEqualNode(spans[index])) {
          matches = false
          break
        }
      }
      if (matches) return
    }
  }
  row.replaceChildren(...spans)
}
