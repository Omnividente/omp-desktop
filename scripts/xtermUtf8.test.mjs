import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { patchXtermUtf8 } from "./xtermUtf8.mjs"

const bundlePath = join(
  dirname(createRequire(import.meta.url).resolve("@xterm/xterm")),
  "xterm.mjs",
)
const original = readFileSync(bundlePath, "utf8")
const corrected = patchXtermUtf8(original, bundlePath)

// Run the actual npm browser bundle's parser/buffer, without opening a DOM or PTY.
// A child imports the supplied transformed bytes, not the installed unpatched module.
const probe = `
import { readFileSync } from "node:fs";
const { code, cases } = JSON.parse(readFileSync(0, "utf8"));
const { Terminal } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const results = [];
for (const chunks of cases) {
  const terminal = new Terminal({ cols: 120, rows: 24, allowProposedApi: true });
  const replies = [];
  terminal.onData(data => replies.push(data));
  try {
    for (const chunk of chunks) {
      await new Promise(resolve => terminal.write(Uint8Array.from(chunk), resolve));
    }
    const buffer = terminal.buffer.active;
    results.push({
      text: buffer.getLine(0).translateToString(true),
      cursor: [buffer.cursorX, buffer.cursorY],
      replies,
    });
  } finally {
    terminal.dispose();
  }
}
process.stdout.write(JSON.stringify(results));
`

function run(code, cases) {
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", probe], {
      input: JSON.stringify({ code, cases }),
      encoding: "utf8",
      timeout: 15_000,
    }),
  )
}

describe("pinned xterm UTF-8 backport", () => {
  it("reproduces the shipped split failure and corrects only the decoder site", () => {
    const chunks = [
      [0x41, 0xe2, 0x80],
      [0x94, 0x42],
    ]
    assert.equal(run(original, [chunks])[0].text, "AB")
    assert.equal(run(corrected, [chunks])[0].text, "A—B")
    assert.equal(
      corrected,
      original.replace(
        "for(;(f=this.interim[++m]&63)&&m<4;)p<<=6,p|=f;",
        "for(;(f=this.interim[++m])&&m<4;)p<<=6,p|=f&63;",
      ),
    )
  })

  it("keeps legal UTF-8 text, cursor and parser replies independent of write boundaries", () => {
    const values = ["A—B", "A’B", "A\u4000B", "A\u{10000}B", "A👩‍🚀B"]
    const cases = []
    for (const value of values) {
      const bytes = Array.from(new TextEncoder().encode(value + "\x1b[6n"))
      cases.push([bytes])
      for (let split = 1; split < bytes.length; split++) {
        cases.push([bytes.slice(0, split), bytes.slice(split)])
      }
      cases.push(bytes.map((byte) => [byte]))
    }
    const results = run(corrected, cases)
    let index = 0
    for (const value of values) {
      const bytes = new TextEncoder().encode(value + "\x1b[6n")
      const expected = results[index]
      assert.equal(expected.text, value)
      assert.equal(expected.replies.length, 1)
      assert.match(expected.replies[0], /^\x1b\[1;\d+R$/)
      for (let count = 0; count <= bytes.length; count++) {
        assert.deepEqual(results[index++], expected)
      }
    }
  })

  it("retains xterm's malformed-sequence and BOM behavior", () => {
    const cases = [
      [[0x41, 0xc0], [0xaf, 0x42]],
      [[0x41, 0xed, 0xa0], [0x80, 0x42]],
      [[0x41, 0xf4, 0x90], [0x80, 0x80, 0x42]],
      [[0x41, 0x80, 0x42]],
      [[0x41, 0xe2], [0x42]],
      [[0xef], [0xbb], [0xbf, 0x41]],
    ]
    assert.deepEqual(run(corrected, cases), run(original, cases))
  })

  it("accepts the pinned ESM path on both platforms and with Vite query suffixes", () => {
    for (const id of [
      "/node_modules/@xterm/xterm/lib/xterm.mjs",
      "C:\\synthetic\\node_modules\\@xterm\\xterm\\lib\\xterm.mjs",
      "/node_modules/@xterm/xterm/lib/xterm.mjs?v=synthetic",
    ]) {
      assert.equal(patchXtermUtf8(original, id), corrected)
    }
  })

  it("leaves other modules untouched", () => {
    for (const id of [
      "/node_modules/@xterm/xterm/lib/xterm.js",
      "/node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs",
      "/src/xterm.mjs",
      "/node_modules/@xterm/xterm/lib/xterm.mjs.map",
    ]) {
      assert.equal(patchXtermUtf8(original, id), null)
    }
  })

  it("fails closed on missing, repeated, or already-corrected decoder sites", () => {
    for (const code of ["", original + original, corrected, original + corrected]) {
      assert.throws(() => patchXtermUtf8(code, bundlePath), /Unsupported xterm UTF-8 decoder/)
    }
  })
})
