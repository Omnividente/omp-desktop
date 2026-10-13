// xterm 6.0.0 / addon-webgl 0.19.0, checked by the build-time renderer transform.
export const WEBGL_SIMPLE_COLOR_ATTRIBUTE = "data-omp-simple-webgl-colors"
const HAS_EXTENDED = 0x10000000
const CODEPOINT_MASK = 0x1fffff
const IS_COMBINED_MASK = 0x200000
const ASCII_STYLE_SLOTS = 64
const ASCII_CHARS = Array.from({ length: 128 }, (_, code) =>
  code === 0 ? "" : String.fromCharCode(code),
)

interface CharacterCell {
  content: number
  getChars(): string
}

interface GlyphCache {
  get(key: string | number, bg: number, fg: number, ext: number): unknown
  ompAsciiGlyphsEnabled?: boolean
  ompAsciiGlyphs?: {
    keys: Array<number | undefined>
    glyphs: unknown[]
    last: number
    next: number
  }
}

interface CellColors {
  fg: number
  bg: number
}

interface ColorResolver {
  result: { fg: number; bg: number; ext: number }
  ompSimpleColors?: boolean
}

interface BufferLine {
  _data: Uint32Array
  loadCell(index: number, cell: CharacterCell & CellColors): unknown
}

interface WebglRenderer {
  _core: { cols: number }
  _terminal: { element?: HTMLElement }
  _model: {
    selection: { hasSelection: boolean }
    cells: Uint32Array
    lineLengths: Uint32Array
  }
  _decorationService: { decorations: IterableIterator<unknown> }
  _cellColorResolver: ColorResolver
  _workCell: CharacterCell & CellColors
  _glyphRenderer: {
    value: {
      updateCell(
        x: number,
        y: number,
        code: number,
        bg: number,
        fg: number,
        ext: number,
        chars: string,
        width: number,
        lastBg: number,
      ): void
    }
  }
  _charAtlas?: { _cacheMap: GlyphCache }
  ompFastCells?: boolean
}

interface TextureAtlas {
  pages: Array<{ canvas: HTMLCanvasElement }>
}

interface AtlasRenderer {
  _terminal: { element?: HTMLElement }
  _atlas?: TextureAtlas
  ompAtlasCanvases?: HTMLCanvasElement[]
}

export function beginWebglCells(renderer: WebglRenderer): void {
  // Selection and decorations are checked once per frame, not once per cell.
  const enabled = Boolean(renderer._terminal.element?.hasAttribute(WEBGL_SIMPLE_COLOR_ATTRIBUTE))
  renderer.ompFastCells = enabled
  if (renderer._charAtlas) renderer._charAtlas._cacheMap.ompAsciiGlyphsEnabled = enabled
  renderer._cellColorResolver.ompSimpleColors =
    enabled &&
    !renderer._model.selection.hasSelection &&
    Boolean(renderer._decorationService.decorations.next().done)
}

export function resolveSimpleCellColors(resolver: ColorResolver, cell: CellColors): boolean {
  // Extended underline variants, links and selection/decorations keep xterm's resolver.
  if (!resolver.ompSimpleColors || cell.bg & HAS_EXTENDED) return false
  resolver.result.fg = cell.fg
  resolver.result.bg = cell.bg
  resolver.result.ext = 0
  return true
}

// 0: use xterm's row loop; 1: handled unchanged; 2: handled with changed cells.
export function updateSimpleWebglRow(
  renderer: WebglRenderer,
  line: BufferLine | undefined,
  y: number,
  cursorRow: boolean,
  joinedCount: number,
): 0 | 1 | 2 {
  if (!line || !renderer._cellColorResolver.ompSimpleColors || cursorRow || joinedCount !== 0)
    return 0
  const data = line._data
  const cols = renderer._core.cols
  if (!(data instanceof Uint32Array) || data.length < cols * 3) return 0
  // Reject the entire row before mutating anything. Complex cells keep the stock
  // joiner, Unicode, extended-attribute and cursor behavior, including mixed rows.
  for (let p = 0; p < cols * 3; p += 3) {
    if (
      data[p] & IS_COMBINED_MASK ||
      (data[p] & CODEPOINT_MASK) >= ASCII_CHARS.length ||
      data[p + 2] & HAS_EXTENDED
    )
      return 0
  }
  const model = renderer._model
  const cells = model.cells
  const colors = renderer._cellColorResolver.result
  const glyphs = renderer._glyphRenderer.value
  let length = 0
  let changed = false
  for (let x = 0, p = 0, m = y * cols * 4; x < cols; x++, p += 3, m += 4) {
    const content = data[p]
    const code = content & CODEPOINT_MASK
    const fg = data[p + 1]
    const bg = data[p + 2]
    const lastBg = colors.bg
    colors.fg = fg
    colors.bg = bg
    colors.ext = 0
    if (code !== 0) length = x + 1
    if (cells[m] === code && cells[m + 1] === bg && cells[m + 2] === fg && cells[m + 3] === 0)
      continue
    cells[m] = code
    cells[m + 1] = bg
    cells[m + 2] = fg
    cells[m + 3] = 0
    glyphs.updateCell(x, y, code, bg, fg, 0, ASCII_CHARS[code], content >> 22, lastBg)
    changed = true
  }
  model.lineLengths[y] = length
  // xterm reuses this same work cell across rows, including subsequent stock rows.
  if (cols > 0) line.loadCell(cols - 1, renderer._workCell)
  return changed ? 2 : 1
}

export function webglCellChars(renderer: WebglRenderer, cell: CharacterCell): string {
  const code = cell.content & CODEPOINT_MASK
  // JoinedCellData and combined/non-ASCII characters retain xterm's exact decoding.
  if (
    renderer.ompFastCells &&
    cell === renderer._workCell &&
    !(cell.content & IS_COMBINED_MASK) &&
    code < ASCII_CHARS.length
  )
    return ASCII_CHARS[code]
  return cell.getChars()
}

export function webglGlyph(
  cache: GlyphCache,
  key: string | number,
  bg: number,
  fg: number,
  ext: number,
): unknown {
  if (!cache.ompAsciiGlyphsEnabled || typeof key !== "number" || key !== (key & 127))
    return cache.get(key, bg, fg, ext)
  let recent = cache.ompAsciiGlyphs
  if (!recent) {
    recent = cache.ompAsciiGlyphs = {
      keys: new Array<number | undefined>(ASCII_STYLE_SLOTS * 3),
      glyphs: new Array<unknown>(ASCII_STYLE_SLOTS * ASCII_CHARS.length),
      last: -1,
      next: 0,
    }
  }
  const keys = recent.keys
  let slot = recent.last
  let offset = slot * 3
  if (slot < 0 || keys[offset] !== bg || keys[offset + 1] !== fg || keys[offset + 2] !== ext) {
    slot = -1
    for (let candidate = 0; candidate < ASCII_STYLE_SLOTS; candidate++) {
      offset = candidate * 3
      if (keys[offset] === bg && keys[offset + 1] === fg && keys[offset + 2] === ext) {
        slot = candidate
        break
      }
    }
    if (slot < 0) {
      slot = recent.next
      recent.next = (slot + 1) % ASCII_STYLE_SLOTS
      offset = slot * 3
      keys[offset] = bg
      keys[offset + 1] = fg
      keys[offset + 2] = ext
      recent.glyphs.fill(undefined, slot * ASCII_CHARS.length, (slot + 1) * ASCII_CHARS.length)
    }
    recent.last = slot
  }
  const index = slot * ASCII_CHARS.length + key
  const glyph = recent.glyphs[index]
  if (glyph !== undefined) return glyph
  return (recent.glyphs[index] = cache.get(key, bg, fg, ext))
}

export function invalidateWebglGlyphs(
  cache: GlyphCache,
  key?: string | number,
  bg?: number,
  fg?: number,
  ext?: number,
): void {
  const recent = cache.ompAsciiGlyphs
  if (!recent) return
  if (key === undefined) {
    recent.keys.fill(undefined)
    recent.glyphs.fill(undefined)
    recent.last = -1
    recent.next = 0
  } else if (typeof key === "number" && key === (key & 127)) {
    for (let slot = 0; slot < ASCII_STYLE_SLOTS; slot++) {
      const offset = slot * 3
      if (
        recent.keys[offset] === bg &&
        recent.keys[offset + 1] === fg &&
        recent.keys[offset + 2] === ext
      ) {
        recent.glyphs[slot * ASCII_CHARS.length + key] = undefined
        return
      }
    }
  }
}

export function reuseWebglAtlasTextures(renderer: AtlasRenderer, atlas: TextureAtlas): boolean {
  if (!renderer._terminal.element?.hasAttribute(WEBGL_SIMPLE_COLOR_ATTRIBUTE)) return false
  let canvases = renderer.ompAtlasCanvases
  let unchanged = renderer._atlas === atlas && canvases?.length === atlas.pages.length
  if (unchanged) {
    for (let index = 0; index < atlas.pages.length; index++) {
      if (canvases![index] !== atlas.pages[index].canvas) {
        unchanged = false
        break
      }
    }
  }
  if (unchanged) return true
  // Page versions still trigger normal uploads; only redundant setAtlas resets are skipped.
  if (!canvases) canvases = renderer.ompAtlasCanvases = []
  canvases.length = atlas.pages.length
  for (let index = 0; index < atlas.pages.length; index++)
    canvases[index] = atlas.pages[index].canvas
  return false
}
