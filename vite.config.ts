import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import ts from "typescript"

// Keep the npm package untouched; adapt the pinned xterm 6.0.0 DOM renderer.
// A dependency upgrade must be reviewed rather than silently losing this fix.
function terminalDomRowsPlugin(): Plugin {
  return {
    name: "omp-xterm-dom-row-reuse",
    enforce: "pre",
    config: () => ({ optimizeDeps: { exclude: ["@xterm/xterm"] } }),
    transform(code, id) {
      if (!/[/\\]@xterm[/\\]xterm[/\\]lib[/\\]xterm\.mjs(?:\?.*)?$/.test(id)) {
        return null
      }
      const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
      const changes: Array<{ start: number; end: number; text: string }> = []
      const invalidations = new Set([
        "_injectCss",
        "_updateDimensions",
        "_setDefaultSpacing",
        "handleDevicePixelRatioChange",
        "handleSelectionChanged",
        "clear",
      ])
      let rowSites = 0
      let frameSites = 0
      let invalidationSites = 0
      const properties = new Set<string>()
      const visitProperties = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node)) properties.add(node.name.text)
        ts.forEachChild(node, visitProperties)
      }
      visitProperties(source)
      const visitCall = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "replaceChildren" &&
          node.arguments.length === 1 &&
          ts.isSpreadElement(node.arguments[0])
        ) {
          const factory = node.arguments[0].expression
          if (
            ts.isCallExpression(factory) &&
            ts.isPropertyAccessExpression(factory.expression) &&
            factory.expression.name.text === "createRow" &&
            factory.expression.expression.getText(source) === "this._rowFactory"
          ) {
            if (factory.arguments.length !== 11) {
              this.error("Unsupported xterm DOM renderer: createRow parameters changed")
            }
            rowSites += 1
            changes.push({
              start: node.getStart(source),
              end: node.getEnd(),
              text: `__ompRenderTerminalRow(${node.expression.expression.getText(source)},this,${factory.arguments.map((argument) => argument.getText(source)).join(",")})`,
            })
          }
        }
        ts.forEachChild(node, visitCall)
      }
      const visitClass = (node: ts.Node): void => {
        if (
          (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
          node.members.some((member) => member.name?.getText(source) === "renderRows") &&
          node.members.some((member) => member.name?.getText(source) === "_setCellUnderline")
        ) {
          for (const member of node.members) {
            if (!ts.isMethodDeclaration(member) || !member.body) continue
            const name = member.name.getText(source)
            if (name === "renderRows" || name === "_setCellUnderline") {
              frameSites += 1
              changes.push({
                start: member.body.getStart(source) + 1,
                end: member.body.getStart(source) + 1,
                text: "__ompBeginTerminalRows(this);",
              })
              ts.forEachChild(member, visitCall)
            } else if (invalidations.has(name)) {
              invalidationSites += 1
              changes.push({
                start: member.body.getStart(source) + 1,
                end: member.body.getStart(source) + 1,
                text: "__ompInvalidateTerminalRows(this);",
              })
            }
          }
        }
        ts.forEachChild(node, visitClass)
      }
      visitClass(source)
      if (rowSites !== 2 || frameSites !== 2 || invalidationSites !== invalidations.size) {
        this.error(
          `Unsupported xterm DOM renderer: row/frame/invalidation sites ${rowSites}/${frameSites}/${invalidationSites}`,
        )
      }
      for (const property of [
        "_data",
        "_combined",
        "_extendedAttrs",
        "ext",
        "urlId",
        "_rowContainer",
        "_coreService",
        "isCursorHidden",
        "isCursorInitialized",
        "_coreBrowserService",
        "isFocused",
        "_characterJoinerService",
        "_characterJoiners",
        "_decorationService",
        "decorations",
      ]) {
        if (!properties.has(property))
          this.error(`Unsupported xterm DOM renderer: missing ${property}`)
      }
      for (const change of changes.sort((left, right) => right.start - left.start)) {
        code = code.slice(0, change.start) + change.text + code.slice(change.end)
      }
      return {
        code:
          'import { renderTerminalRow as __ompRenderTerminalRow, beginTerminalRows as __ompBeginTerminalRows, invalidateTerminalRows as __ompInvalidateTerminalRows } from "/src/terminalDomRows.ts";\n' +
          code,
        map: null,
      }
    },
  }
}

function terminalWebglCellsPlugin(): Plugin {
  return {
    name: "omp-xterm-webgl-cell-reuse",
    enforce: "pre",
    config: () => ({ optimizeDeps: { exclude: ["@xterm/addon-webgl"] } }),
    transform(code, id) {
      if (!/[/\\]@xterm[/\\]addon-webgl[/\\]lib[/\\]addon-webgl\.mjs(?:\?.*)?$/.test(id))
        return null
      const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
      const changes: Array<{ start: number; end?: number; text: string }> = []
      let frameSites = 0
      let resolverSites = 0
      let extendedMaskSites = 0
      let charSites = 0
      let glyphSites = 0
      let glyphInvalidationSites = 0
      let combinedMaskSites = 0
      let codepointMaskSites = 0
      let rowSites = 0
      let atlasAssignmentSites = 0
      const visit = (node: ts.Node): void => {
        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
          const renderer = node.members.some(
            (member) => member.name?.getText(source) === "_updateModel",
          )
          const properties = new Set<string>()
          const visitProperties = (child: ts.Node): void => {
            if (
              ts.isPropertyAccessExpression(child) &&
              child.expression.kind === ts.SyntaxKind.ThisKeyword
            )
              properties.add(child.name.text)
            ts.forEachChild(child, visitProperties)
          }
          visitProperties(node)
          const colorResolver =
            properties.has("_selectionRenderModel") &&
            properties.has("_decorationService") &&
            properties.has("result")
          const atlas = properties.has("_cacheMap") && properties.has("_cacheMapCombined")
          const atlasRenderer =
            properties.has("_atlas") &&
            properties.has("_atlasTextures") &&
            properties.has("_vertices")
          const glyphMap =
            properties.has("_data") &&
            node.members.some(
              (member) =>
                ts.isMethodDeclaration(member) &&
                member.name.getText(source) === "set" &&
                member.parameters.length === 5,
            ) &&
            node.members.some(
              (member) =>
                ts.isMethodDeclaration(member) &&
                member.name.getText(source) === "get" &&
                member.parameters.length === 4,
            )
          for (const member of node.members) {
            if (!ts.isMethodDeclaration(member) || !member.body) continue
            if (renderer && member.name.getText(source) === "renderRows") {
              frameSites += 1
              changes.push({
                start: member.body.getStart(source) + 1,
                text: "__ompBeginWebglCells(this);",
              })
            } else if (renderer && member.name.getText(source) === "_updateModel") {
              let dirty: ts.Identifier | undefined
              const findDirty = (child: ts.Node): void => {
                if (
                  ts.isBinaryExpression(child) &&
                  child.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
                  ts.isIdentifier(child.left) &&
                  ts.isCallExpression(child.right) &&
                  child.right.expression.getText(source) ===
                    "this._rectangleRenderer.value.updateBackgrounds"
                )
                  dirty = child.left
                ts.forEachChild(child, findDirty)
              }
              findDirty(member.body)
              const visitRows = (child: ts.Node): void => {
                if (
                  ts.isForStatement(child) &&
                  child.initializer &&
                  child.condition &&
                  ts.isBinaryExpression(child.condition) &&
                  child.condition.operatorToken.kind === ts.SyntaxKind.LessThanToken &&
                  ts.isPropertyAccessExpression(child.condition.right) &&
                  child.condition.right.name.text === "cols"
                ) {
                  let line: ts.Identifier | undefined
                  let bufferRow: ts.Expression | undefined
                  let viewRow: ts.Expression | undefined
                  let cursor: ts.Identifier | undefined
                  let joined: ts.Identifier | undefined
                  const findInitializers = (part: ts.Node): void => {
                    if (
                      ts.isBinaryExpression(part) &&
                      part.operatorToken.kind === ts.SyntaxKind.EqualsToken
                    ) {
                      if (
                        ts.isIdentifier(part.left) &&
                        ts.isCallExpression(part.right) &&
                        ts.isPropertyAccessExpression(part.right.expression)
                      ) {
                        if (
                          part.right.expression.name.text === "get" &&
                          ts.isPropertyAccessExpression(part.right.expression.expression) &&
                          part.right.expression.expression.name.text === "lines"
                        ) {
                          line = part.left
                          bufferRow = part.right.arguments[0]
                        } else if (
                          part.right.expression.getText(source) ===
                          "this._characterJoinerService.getJoinedCharacters"
                        )
                          joined = part.left
                      } else if (
                        ts.isElementAccessExpression(part.left) &&
                        part.left.expression.getText(source) === "this._model.lineLengths"
                      )
                        viewRow = part.left.argumentExpression
                      else if (
                        ts.isIdentifier(part.left) &&
                        ts.isBinaryExpression(part.right) &&
                        part.right.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
                      )
                        cursor = part.left
                    }
                    ts.forEachChild(part, findInitializers)
                  }
                  findInitializers(child.initializer)
                  if (!dirty || !line || !bufferRow || !viewRow || !cursor || !joined)
                    this.error("Unsupported xterm WebGL row loop initializers")
                  rowSites += 1
                  // Keep all stock initializers and the complete complex-cell loop.
                  // The helper's changed result feeds the original frame-end rectangle
                  // update; cursor and joined rows still run entirely inside xterm.
                  changes.push({
                    start: child.getStart(source),
                    text: `{${child.initializer.getText(source)};const __ompRow=__ompUpdateSimpleWebglRow(this,${line.getText(source)},${viewRow.getText(source)},${cursor.getText(source)},${joined.getText(source)}.length);if(__ompRow){if(__ompRow===2)${dirty.getText(source)}=true;}else `,
                  })
                  changes.push({
                    start: child.initializer.getStart(source),
                    end: child.initializer.getEnd(),
                    text: "",
                  })
                  changes.push({ start: child.getEnd(), text: "}" })
                  return
                }
                ts.forEachChild(child, visitRows)
              }
              visitRows(member.body)
              const visitChars = (child: ts.Node): void => {
                if (
                  ts.isCallExpression(child) &&
                  ts.isPropertyAccessExpression(child.expression) &&
                  child.expression.name.text === "getChars" &&
                  child.arguments.length === 0
                ) {
                  charSites += 1
                  changes.push({
                    start: child.getStart(source),
                    end: child.getEnd(),
                    text: `__ompWebglCellChars(this,${child.expression.expression.getText(source)})`,
                  })
                }
                ts.forEachChild(child, visitChars)
              }
              visitChars(member.body)
            } else if (atlasRenderer && member.name.getText(source) === "setAtlas") {
              if (member.parameters.length !== 1)
                this.error("Unsupported xterm WebGL atlas assignment parameters")
              const atlas = member.parameters[0].name.getText(source)
              atlasAssignmentSites += 1
              changes.push({
                start: member.body.getStart(source) + 1,
                text: `if(__ompReuseWebglAtlasTextures(this,${atlas}))return;`,
              })
            } else if (atlas && member.name.getText(source) === "_getFromCacheMap") {
              if (member.parameters.length !== 7)
                this.error("Unsupported xterm WebGL glyph lookup parameters")
              const cache = member.parameters[0].name.getText(source)
              const visitGlyph = (child: ts.Node): void => {
                if (
                  ts.isCallExpression(child) &&
                  ts.isPropertyAccessExpression(child.expression) &&
                  child.expression.name.text === "get" &&
                  child.expression.expression.getText(source) === cache &&
                  child.arguments.length === 4
                ) {
                  glyphSites += 1
                  changes.push({
                    start: child.getStart(source),
                    end: child.getEnd(),
                    text: `__ompWebglGlyph(${cache},${child.arguments.map((argument) => argument.getText(source)).join(",")})`,
                  })
                }
                ts.forEachChild(child, visitGlyph)
              }
              visitGlyph(member.body)
            } else if (
              glyphMap &&
              (member.name.getText(source) === "set" || member.name.getText(source) === "clear")
            ) {
              glyphInvalidationSites += 1
              const keys =
                member.name.getText(source) === "set"
                  ? `,${member.parameters
                      .slice(0, 4)
                      .map((parameter) => parameter.name.getText(source))
                      .join(",")}`
                  : ""
              changes.push({
                start: member.body.getStart(source) + 1,
                text: `__ompInvalidateWebglGlyphs(this${keys});`,
              })
            } else if (member.name.getText(source) === "getChars" && properties.has("content")) {
              const checkContentMasks = (child: ts.Node): void => {
                if (
                  ts.isBinaryExpression(child) &&
                  child.operatorToken.kind === ts.SyntaxKind.AmpersandToken &&
                  child.left.getText(source) === "this.content" &&
                  ts.isNumericLiteral(child.right)
                ) {
                  if (Number(child.right.text) === 0x200000) combinedMaskSites += 1
                  if (Number(child.right.text) === 0x1fffff) codepointMaskSites += 1
                }
                ts.forEachChild(child, checkContentMasks)
              }
              checkContentMasks(member.body)
            } else if (colorResolver && member.name.getText(source) === "resolve") {
              if (member.parameters.length !== 4)
                this.error("Unsupported xterm WebGL color resolver parameters")
              const cell = member.parameters[0].name.getText(source)
              const checkMask = (child: ts.Node): void => {
                if (
                  ts.isConditionalExpression(child) &&
                  ts.isBinaryExpression(child.condition) &&
                  child.condition.operatorToken.kind === ts.SyntaxKind.AmpersandToken &&
                  child.condition.left.getText(source) === `${cell}.bg` &&
                  ts.isNumericLiteral(child.condition.right) &&
                  Number(child.condition.right.text) === 0x10000000
                )
                  extendedMaskSites += 1
                ts.forEachChild(child, checkMask)
              }
              checkMask(member.body)
              resolverSites += 1
              changes.push({
                start: member.body.getStart(source) + 1,
                text: `if(__ompResolveSimpleCellColors(this,${cell}))return;`,
              })
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      if (
        frameSites !== 1 ||
        resolverSites !== 1 ||
        extendedMaskSites !== 1 ||
        charSites !== 1 ||
        glyphSites !== 1 ||
        glyphInvalidationSites !== 2 ||
        combinedMaskSites !== 1 ||
        rowSites !== 1 ||
        atlasAssignmentSites !== 1 ||
        codepointMaskSites !== 2
      )
        this.error(
          `Unsupported xterm WebGL renderer: frame/resolver/extended/char/glyph/invalidation/combined/codepoint/row/atlas sites ${frameSites}/${resolverSites}/${extendedMaskSites}/${charSites}/${glyphSites}/${glyphInvalidationSites}/${combinedMaskSites}/${codepointMaskSites}/${rowSites}/${atlasAssignmentSites}`,
        )
      for (const change of changes.sort((left, right) => right.start - left.start))
        code = code.slice(0, change.start) + change.text + code.slice(change.end ?? change.start)
      return {
        code:
          'import { beginWebglCells as __ompBeginWebglCells, resolveSimpleCellColors as __ompResolveSimpleCellColors, webglCellChars as __ompWebglCellChars, webglGlyph as __ompWebglGlyph, invalidateWebglGlyphs as __ompInvalidateWebglGlyphs, updateSimpleWebglRow as __ompUpdateSimpleWebglRow, reuseWebglAtlasTextures as __ompReuseWebglAtlasTextures } from "/src/terminalWebglCells.ts";\n' +
          code,
        map: null,
      }
    },
  }
}

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), terminalDomRowsPlugin(), terminalWebglCellsPlugin()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "react", test: /[/\\]node_modules[/\\](?:react|react-dom)(?:[/\\]|$)/ },
            { name: "xterm", test: /[/\\]node_modules[/\\]@xterm[/\\](?:xterm|addon-fit)(?:[/\\]|$)/ },
          ],
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}))
