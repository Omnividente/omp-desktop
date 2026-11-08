// Synthetic registry v1 peer for cross-process tests. Never launches OMP or a relay.
import { randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

if (!process.send) throw new Error("fixture_requires_parent_ipc")

const dir = await mkdtemp(path.join(os.tmpdir(), "ompr-"))
if (process.platform !== "win32") await chmod(dir, 0o700)
const instanceId = randomBytes(8).toString("hex")
const metadataPath = path.join(dir, randomBytes(8).toString("hex") + ".json")
const endpoint = process.platform === "win32"
  ? "\\\\.\\pipe\\omp-remote-spike-" + randomBytes(8).toString("hex")
  : path.join(dir, "host.sock")
const token = randomBytes(32).toString("hex")
const room = randomBytes(16).toString("base64url")
const roomKey = randomBytes(32)
const writeToken = randomBytes(16)
const secretUrl = (access) => "https://example.invalid/#" + room + "." +
  (access === "view" ? roomKey : Buffer.concat([roomKey, writeToken])).toString("base64url")

let state = {
  generation: 1,
  sessionId: "synthetic-session-a",
  access: "control",
  busy: false,
  relayConnected: true,
  inputRequired: false,
  behavior: "normal",
}
let afterSnapshot = null
let stopping = false
const requests = []
const sockets = new Set()
const authMatches = (value) => {
  if (typeof value !== "string") return false
  const actual = Buffer.from(value)
  const expected = Buffer.from(token)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
const snapshot = () => ({
  instanceId: state.snapshotInstanceId ?? instanceId,
  generation: state.generation,
  pid: state.snapshotPid ?? process.pid,
  sessionId: state.sessionId,
  sessionName: "private-fixture-title",
  cwd: "/private-fixture-working-directory",
  model: { provider: "synthetic", id: "no-inference" },
  startedAt: 1_000,
  participants: 1,
  relayConnected: state.relayConnected,
  inputRequired: state.inputRequired,
  ...(state.behavior === "omit_busy" ? {} : { busy: state.busy }),
  access: state.access,
})

const server = net.createServer((socket) => {
  sockets.add(socket)
  socket.on("error", () => {})
  socket.on("close", () => sockets.delete(socket))
  let received = ""
  let handled = false
  socket.on("data", (chunk) => {
    if (handled) return
    received += chunk.toString("utf8")
    if (Buffer.byteLength(received) > 4096) return socket.destroy()
    const newline = received.indexOf("\n")
    if (newline < 0) return
    handled = true
    let request
    try {
      request = JSON.parse(received.slice(0, newline))
    } catch {
      socket.end(JSON.stringify({ ok: false, v: 1, error: "malformed_request" }) + "\n")
      return
    }
    const authenticated = authMatches(request.token)
    requests.push({ op: request.op, access: request.access, generation: request.generation, authenticated })
    if (request.v !== 1 || !authenticated) {
      socket.end(JSON.stringify({ ok: false, v: 1, error: request.v !== 1 ? "unsupported_protocol" : "authentication_failed" }) + "\n")
      return
    }
    if (state.behavior === "timeout") return
    if (state.behavior === "malformed") return socket.end("{not-json}\n")
    if (state.behavior === "oversized") return socket.end("x".repeat(64 * 1024 + 2) + "\n")
    if (state.behavior === "missing_newline") return socket.end('{"ok":true,"v":1}')
    if (state.behavior === "unsupported_version") return socket.end('{"ok":true,"v":2}\n')
    if (state.behavior === "secret_error") {
      return socket.end(JSON.stringify({ ok: false, v: 1, error: secretUrl("control") }) + "\n")
    }
    let response
    if (request.op === "snapshot") {
      response = { ok: true, v: 1, snapshot: snapshot() }
    } else if (request.op === "link") {
      if (request.generation !== state.generation) response = { ok: false, v: 1, error: "stale_generation" }
      else if (!["view", "control"].includes(request.access)) response = { ok: false, v: 1, error: "invalid_access" }
      else if (request.access === "control" && state.access !== "control") response = { ok: false, v: 1, error: "access_unavailable" }
      else {
        let url = secretUrl(state.behavior === "wrong_access_key" ? "control" : request.access)
        if (state.behavior === "invalid_capability") url = "http://example.invalid/#" + url.split("#")[1]
        if (state.behavior === "custom_web_url") url = "https://viewer.example.invalid/collab/#relay.example.invalid/r/" + url.split("#")[1]
        if (["nested_fragment", "encoded_nested_fragment"].includes(state.behavior)) {
          const delimiter = state.behavior === "nested_fragment" ? "#" : "%23"
          url = "https://viewer.example.invalid/#relay.example.invalid/r/" + secretUrl("control").split("#")[1] +
            delimiter + "x/" + secretUrl("view").split("#")[1]
        }
        response = { ok: true, v: 1, url }
      }
    } else response = { ok: false, v: 1, error: "invalid_operation" }
    const line = JSON.stringify(response) + "\n"
    if (state.behavior === "fragmented") {
      socket.write(line.slice(0, 13))
      setTimeout(() => socket.end(line.slice(13)), 10)
    } else socket.end(line)
    if (request.op === "snapshot" && afterSnapshot) {
      state = { ...state, ...afterSnapshot }
      afterSnapshot = null
    }
  })
})

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(endpoint, resolve)
  })
  if (process.platform !== "win32") await chmod(endpoint, 0o600)
  await writeFile(metadataPath, JSON.stringify({
    version: 1, instanceId, pid: process.pid, endpoint, createdAt: 1_000, token,
  }), { mode: 0o600 })
} catch (error) {
  await rm(dir, { recursive: true, force: true })
  const code = ["EPERM", "EACCES"].includes(error?.code) ? error.code : "unavailable"
  await new Promise((resolve) => process.send({ type: "setup_error", code }, resolve))
  process.exit(1)
}

async function shutdown() {
  if (stopping) return
  stopping = true
  for (const socket of sockets) socket.destroy()
  await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
  if (process.connected) process.disconnect()
}

process.on("message", async (message) => {
  try {
    if (message.type === "set") state = { ...state, ...message.patch }
    else if (message.type === "after_snapshot") afterSnapshot = message.patch
    else if (message.type === "stop") return void shutdown()
    else if (message.type === "close_endpoint") {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    } else if (message.type !== "stats") throw new Error("unknown_fixture_command")
    process.send({ type: "reply", id: message.id, requests: message.type === "stats" ? requests : undefined })
  } catch {
    process.send({ type: "reply", id: message.id, error: "fixture_failed" })
  }
})
process.on("SIGTERM", () => void shutdown())
process.on("disconnect", () => void shutdown())
process.send({
  type: "ready", registryDir: dir, metadataPath, endpoint, instanceId,
  sessionId: state.sessionId, generation: 1, pid: process.pid, token,
  viewUrl: secretUrl("view"), controlUrl: secretUrl("control"),
})
