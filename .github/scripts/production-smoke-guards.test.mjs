import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { Session } from "node:inspector/promises"
import test from "node:test"
import { callWebviewFunction, readPinnedInstaller } from "./production-smoke-guards.mjs"

const fixture = Buffer.from("Text fixture – проверка\n", "utf8")
const digestOf = (value) => createHash("sha256").update(value).digest("hex")
const pin = { maxBytes: fixture.length, digest: digestOf(fixture) }

function chunks(...values) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const value of values) controller.enqueue(value)
        controller.close()
      },
    }),
  )
}

test("accepts only the expected complete bytes, with or without a length header", async () => {
  const declared = { headers: { "content-length": String(fixture.length) } }
  assert.deepEqual(await readPinnedInstaller(new Response(fixture, declared), pin), fixture)
  assert.deepEqual(
    await readPinnedInstaller(chunks(fixture.subarray(0, 8), fixture.subarray(8)), pin),
    fixture,
  )
})

test("rejects declared oversize and stops reading an over-budget response stream", async () => {
  await assert.rejects(
    readPinnedInstaller(new Response(fixture, { headers: { "content-length": "4096" } }), pin),
    /byte limit/,
  )
  let cancelled = false
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(fixture)
      controller.enqueue(Buffer.from(" "))
    },
    cancel() {
      cancelled = true
    },
  })
  await assert.rejects(readPinnedInstaller(new Response(stream), pin), /byte limit/)
  assert.equal(cancelled, true)
})

test("rejects mismatching content and non-success status before use", async () => {
  await assert.rejects(
    readPinnedInstaller(new Response(Buffer.from("Different text")), pin),
    /digest does not match/,
  )
  await assert.rejects(readPinnedInstaller(new Response(null, { status: 404 }), pin), /status/)
})

async function withIsolatedInspector(run) {
  // In-process V8 session only: no debug server or connection to a user browser.
  const session = new Session()
  session.connect()
  try {
    const send = session.post.bind(session)
    const response = await send("Runtime.evaluate", { expression: "globalThis" })
    return await run(send, response.result.objectId)
  } finally {
    session.disconnect()
  }
}

test("round-trips Unicode, quotes and structured arguments through the runtime protocol", async () => {
  const values = ['Проект "Север"', ["Line 1\nLine 2", "日本語"], { dark: true }]
  const result = await withIsolatedInspector((send, objectId) =>
    callWebviewFunction(send, objectId, (title, lines, settings) => ({ title, lines, settings }), values),
  )
  assert.deepEqual(result, { title: values[0], lines: values[1], settings: values[2] })
})

test("rejects an evaluation exception instead of treating it as an observation", async () => {
  await assert.rejects(
    withIsolatedInspector((send, objectId) =>
      callWebviewFunction(send, objectId, () => { throw new Error("fixture unavailable") }, []),
    ),
    /Native WebView evaluation failed/,
  )
})
