import assert from "node:assert/strict"
import { createHash } from "node:crypto"

// This harness admits only the exact maintenance candidate above the pinned base.
export const TARGET_VERSION = "0.9.14"
export const TARGET_TAG = `v${TARGET_VERSION}`

// Treat a response as data until both its byte budget and pinned digest pass.
export async function readPinnedInstaller(response, { maxBytes, digest }) {
  assert(Number.isSafeInteger(maxBytes) && maxBytes > 0, "Invalid installer byte limit")
  assert(/^[a-f0-9]{64}$/.test(digest), "Invalid installer digest pin")
  const declared = response.headers.get("content-length")
  if (
    response.status !== 200 ||
    !response.body ||
    (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
  ) {
    await response.body?.cancel().catch(() => {})
    throw new Error("Installer response failed status or byte limit checks")
  }
  const chunks = []
  const hash = createHash("sha256")
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    assert(size <= maxBytes, "Installer response exceeded byte limit")
    hash.update(chunk)
    chunks.push(chunk)
  }
  assert.equal(hash.digest("hex"), digest, "Installer digest does not match pin")
  return Buffer.concat(chunks, size)
}

export function webviewValue(response) {
  assert(
    !response.exceptionDetails && response.result?.subtype !== "error",
    "Native WebView evaluation failed",
  )
  return response.result?.value
}

// The caller supplies a local function literal. Selector, preferences and
// fixture values travel as CDP CallArguments and never enter its source text.
export async function callWebviewFunction(send, objectId, fn, values) {
  const response = await send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: Function.prototype.toString.call(fn),
    arguments: values.map((value) => ({ value })),
    awaitPromise: true,
    returnByValue: true,
  })
  return webviewValue(response)
}
