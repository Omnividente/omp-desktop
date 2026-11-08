/**
 * Experimental consumer of OMP's local Collab registry v1.
 * Source contract: oh-my-pi@cb4801a7d6db666946a1b65fce5cdf50d2947b96,
 * packages/coding-agent/src/collab/registry.ts. No runtime mutation API exists.
 */
import { constants } from "node:fs"
import { lstat, open, opendir } from "node:fs/promises"
import net from "node:net"
import path from "node:path"

const VERSION = 1
const MAX_METADATA_BYTES = 4096
const MAX_REQUEST_BYTES = 4096
const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_ENTRIES = 256
const CONCURRENCY = 8
const ID_PATTERN = /^[a-z0-9-]{8,64}$/
const ENTRY_PATTERN = /^[a-z0-9-]{8,64}\.json$/
const HOST_ERRORS = new Set([
  "unsupported_protocol",
  "authentication_failed",
  "snapshot_unavailable",
  "invalid_operation",
  "invalid_access",
  "stale_generation",
  "access_unavailable",
  "malformed_request",
])

export const RUNTIME_CAPABILITIES = Object.freeze({
  inspect: true,
  generationBoundLink: true,
  start: false,
  stop: false,
  setAccess: false,
})

/** Fixed codes only: never retain an endpoint, raw response, token or cause. */
export class ProbeError extends Error {
  constructor(code) {
    super(code)
    this.name = "ProbeError"
    this.code = code
  }
}

const fail = (code) => {
  throw new ProbeError(code)
}
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0
const boundedText = (value) => typeof value === "string" && value.length <= 1024
const accessLevel = (value) => value === "view" || value === "control"

function optionsOf(options) {
  if (!record(options) || typeof options.registryDir !== "string") fail("invalid_arguments")
  if (!path.isAbsolute(options.registryDir) || options.registryDir.includes("\0")) {
    fail("invalid_arguments")
  }
  const timeoutMs = options.timeoutMs ?? 1500
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 10_000) {
    fail("invalid_arguments")
  }
  return { registryDir: options.registryDir, timeoutMs }
}

function privateOwner(stat) {
  return (
    process.platform === "win32" ||
    (stat.uid === process.getuid() && (stat.mode & 0o077) === 0)
  )
}

function validateMetadata(value) {
  if (!record(value)) fail("invalid_metadata")
  if (value.version !== VERSION) fail("unsupported_protocol")
  if (
    typeof value.instanceId !== "string" ||
    !ID_PATTERN.test(value.instanceId) ||
    !positiveInteger(value.pid) ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt < 0 ||
    typeof value.token !== "string" ||
    value.token.length === 0 ||
    value.token.length > 256 ||
    typeof value.endpoint !== "string" ||
    value.endpoint.length === 0 ||
    value.endpoint.length > 4096 ||
    value.endpoint.includes("\0")
  ) {
    fail("invalid_metadata")
  }
  const localEndpoint =
    process.platform === "win32"
      ? value.endpoint.startsWith("\\\\.\\pipe\\")
      : path.isAbsolute(value.endpoint)
  if (!localEndpoint) fail("invalid_endpoint")
  return {
    version: VERSION,
    instanceId: value.instanceId,
    pid: value.pid,
    endpoint: value.endpoint,
    token: value.token,
  }
}

async function readMetadata(filename) {
  let handle
  try {
    const before = await lstat(filename)
    if (!before.isFile() || before.isSymbolicLink() || !privateOwner(before)) {
      fail("unsafe_metadata")
    }
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = await handle.stat()
    if (!stat.isFile() || !privateOwner(stat) || before.ino !== stat.ino || before.dev !== stat.dev) {
      fail("unsafe_metadata")
    }
    if (stat.size > MAX_METADATA_BYTES) fail("metadata_limit")
    const bytes = Buffer.alloc(MAX_METADATA_BYTES + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > MAX_METADATA_BYTES) fail("metadata_limit")
    let parsed
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)))
    } catch {
      fail("invalid_metadata")
    }
    return validateMetadata(parsed)
  } catch (error) {
    if (error instanceof ProbeError) throw error
    fail("metadata_unavailable")
  } finally {
    await handle?.close().catch(() => {})
  }
}

function addSkipped(skipped, error) {
  const code = error instanceof ProbeError ? error.code : "probe_failed"
  skipped.set(code, (skipped.get(code) ?? 0) + 1)
}

async function readRegistry(registryDir) {
  try {
    const stat = await lstat(registryDir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !privateOwner(stat)) fail("unsafe_registry")
  } catch (error) {
    if (error?.code === "ENOENT") return { registryState: "missing", entries: [], skipped: new Map() }
    if (error instanceof ProbeError) throw error
    fail("registry_unavailable")
  }
  const names = []
  try {
    const directory = await opendir(registryDir)
    let count = 0
    for await (const entry of directory) {
      if (++count > MAX_ENTRIES) fail("registry_limit")
      if (entry.name.endsWith(".json")) names.push(entry.name)
    }
  } catch (error) {
    if (error instanceof ProbeError) throw error
    fail("registry_unavailable")
  }
  const entries = []
  const skipped = new Map()
  for (const name of names.sort()) {
    try {
      if (!ENTRY_PATTERN.test(name)) fail("invalid_metadata")
      entries.push(await readMetadata(path.join(registryDir, name)))
    } catch (error) {
      addSkipped(skipped, error)
    }
  }
  return { registryState: "ready", entries, skipped }
}

async function query(metadata, request, timeoutMs) {
  if (process.platform !== "win32") {
    try {
      const stat = await lstat(metadata.endpoint)
      if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid()) {
        fail("unsafe_endpoint")
      }
    } catch (error) {
      if (error instanceof ProbeError) throw error
      fail("host_unreachable")
    }
  }
  const payload = JSON.stringify({ v: VERSION, token: metadata.token, ...request }) + "\n"
  if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) fail("request_limit")
  return new Promise((resolve, reject) => {
    let socket
    let settled = false
    let response = Buffer.alloc(0)
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      if (error) reject(new ProbeError(error))
      else resolve(result)
    }
    const timer = setTimeout(() => finish("host_timeout"), timeoutMs)
    try {
      socket = net.createConnection({ path: metadata.endpoint })
      socket.on("error", () => finish("host_unreachable"))
      socket.on("end", () => finish("incomplete_response"))
      socket.on("close", () => finish("host_unreachable"))
      socket.on("connect", () => socket.write(payload))
      socket.on("data", (chunk) => {
        if (settled) return
        if (response.length + chunk.length > MAX_RESPONSE_BYTES + 1) return finish("response_limit")
        response = Buffer.concat([response, chunk])
        const newline = response.indexOf(10)
        if (newline < 0) return
        if (newline > MAX_RESPONSE_BYTES || newline !== response.length - 1) {
          return finish("invalid_response")
        }
        let value
        try {
          value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.subarray(0, newline)))
        } catch {
          return finish("invalid_response")
        }
        if (!record(value) || typeof value.ok !== "boolean") return finish("invalid_response")
        if (value.v !== VERSION) return finish("unsupported_protocol")
        if (!value.ok) return finish(HOST_ERRORS.has(value.error) ? value.error : "host_refused")
        finish(null, value)
      })
    } catch {
      finish("host_unreachable")
    }
  })
}

function parseSnapshot(value, metadata) {
  if (
    !record(value) ||
    typeof value.instanceId !== "string" ||
    !ID_PATTERN.test(value.instanceId) ||
    !positiveInteger(value.pid) ||
    !positiveInteger(value.generation) ||
    !boundedText(value.sessionId) ||
    !(value.sessionName === null || boundedText(value.sessionName)) ||
    !boundedText(value.cwd) ||
    !(value.model === null || (record(value.model) && boundedText(value.model.provider) && boundedText(value.model.id))) ||
    !Number.isFinite(value.startedAt) ||
    value.startedAt < 0 ||
    !Number.isSafeInteger(value.participants) ||
    value.participants < 0 ||
    typeof value.relayConnected !== "boolean" ||
    typeof value.inputRequired !== "boolean" ||
    !(value.busy === undefined || value.busy === null || typeof value.busy === "boolean") ||
    !accessLevel(value.access)
  ) {
    fail("invalid_snapshot")
  }
  if (value.instanceId !== metadata.instanceId || value.pid !== metadata.pid) fail("identity_mismatch")
  // Drop titles, directories and model fields before returning caller-visible state.
  return {
    instanceId: value.instanceId,
    pid: value.pid,
    generation: value.generation,
    sessionId: value.sessionId,
    startedAt: value.startedAt,
    participants: value.participants,
    relayConnected: value.relayConnected,
    inputRequired: value.inputRequired,
    busy: value.busy ?? null,
    access: value.access,
  }
}

async function snapshots(entries, timeoutMs, skipped) {
  const live = []
  let next = 0
  const worker = async () => {
    while (next < entries.length) {
      const metadata = entries[next++]
      try {
        const response = await query(metadata, { op: "snapshot" }, timeoutMs)
        live.push({ metadata, snapshot: parseSnapshot(response.snapshot, metadata) })
      } catch (error) {
        addSkipped(skipped, error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker))
  return live.sort((a, b) => a.snapshot.instanceId.localeCompare(b.snapshot.instanceId) || a.snapshot.generation - b.snapshot.generation)
}

/** Read only the explicitly supplied registry. Never remove stale metadata. */
export async function inspectRegistry(options) {
  const { registryDir, timeoutMs } = optionsOf(options)
  const { registryState, entries, skipped } = await readRegistry(registryDir)
  const live = await snapshots(entries, timeoutMs, skipped)
  return {
    version: VERSION,
    registryState,
    hosts: live.map(({ snapshot }) => snapshot),
    skipped: [...skipped].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count })),
  }
}

/**
 * Validate current generated browser-link syntax and the encoded access level.
 * This is not a general legacy join-link parser and never contacts the relay.
 */
export function validateCapability(raw, access) {
  if (
    typeof raw !== "string" || raw.length > 16 * 1024 || !accessLevel(access) ||
    /[\s\\\u0000-\u001f\u007f]/.test(raw) || /%23/i.test(raw) ||
    raw.indexOf("#") < 0 || raw.indexOf("#") !== raw.lastIndexOf("#")
  ) fail("invalid_capability")
  let url
  try {
    url = new URL(raw)
  } catch {
    fail("invalid_capability")
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
    url.username || url.password || url.search || !url.hash
  ) fail("invalid_capability")
  // Upstream parseCollabLink gives a dot key in /r/<room>.<key>
  // precedence over a later fragment. Checking only the suffix could therefore
  // label a control link as view. Accept one complete, unambiguous inner link.
  // Upstream globally replaces %23 before parsing; reject that escape even in
  // the outer path so it cannot introduce an earlier fragment boundary.
  const fragment = url.hash.slice(1)
  if (fragment.includes("%")) fail("invalid_capability")
  let match = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]+)$/.exec(fragment)
  if (!match) {
    const explicitScheme = fragment.includes("://")
    let relay
    try {
      relay = new URL(explicitScheme ? fragment : "wss://" + fragment)
    } catch {
      fail("invalid_capability")
    }
    const localRelay = ["localhost", "127.0.0.1", "[::1]"].includes(relay.hostname)
    if (
      !(relay.protocol === "wss:" || (relay.protocol === "ws:" && localRelay)) ||
      !relay.hostname || relay.username || relay.password || relay.search || relay.hash
    ) fail("invalid_capability")
    match = /^\/r\/([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]+)$/.exec(relay.pathname)
    // Canonical equality also rejects URL-normalized extra/dot segments, empty
    // credentials/query delimiters and other spellings not emitted by OMP.
    const canonical = (explicitScheme ? relay.protocol + "//" : "") + relay.host + relay.pathname
    if (fragment !== canonical) fail("invalid_capability")
  }
  if (!match) fail("invalid_capability")
  const room = Buffer.from(match[1], "base64url")
  const key = Buffer.from(match[2], "base64url")
  if (
    room.length !== 16 || room.toString("base64url") !== match[1] ||
    key.length !== (access === "view" ? 32 : 48) || key.toString("base64url") !== match[2]
  ) fail("invalid_capability")
}

/**
 * Request exactly the caller's approved generation. A capability is passed only
 * to the in-memory callback; its return value is deliberately not propagated.
 * The callback is trusted to handle the secret and must not log or persist it.
 */
export async function withCapability(options, consume) {
  const { registryDir, timeoutMs } = optionsOf(options)
  if (!record(options.expected)) fail("invalid_arguments")
  // Capture the approved request before any await. Caller/UI objects may change
  // while discovery is in flight; they must not retarget or upgrade this request.
  const expected = {
    instanceId: options.expected.instanceId,
    sessionId: options.expected.sessionId,
    generation: options.expected.generation,
  }
  const access = options.access
  if (
    typeof expected.instanceId !== "string" ||
    !ID_PATTERN.test(expected.instanceId) || !boundedText(expected.sessionId) ||
    expected.sessionId.length === 0 || expected.sessionId.length >= 1024 ||
    !positiveInteger(expected.generation) || !accessLevel(access) ||
    typeof consume !== "function"
  ) fail("invalid_arguments")
  const { entries } = await readRegistry(registryDir)
  const candidates = entries.filter((entry) => entry.instanceId === expected.instanceId)
  if (candidates.length === 0) fail("host_not_found")
  const skipped = new Map()
  const live = await snapshots(candidates, timeoutMs, skipped)
  if (live.length === 0) {
    if (skipped.size === 1) fail(skipped.keys().next().value)
    fail("host_unreachable")
  }
  if (live.length !== 1) fail("ambiguous_host")
  const { metadata, snapshot } = live[0]
  if (snapshot.generation !== expected.generation) fail("stale_generation")
  if (snapshot.sessionId !== expected.sessionId) fail("session_mismatch")
  if (!snapshot.relayConnected) fail("relay_unavailable")
  if (access === "control" && snapshot.access !== "control") fail("access_unavailable")
  const response = await query(metadata, {
    op: "link",
    access,
    generation: expected.generation,
  }, timeoutMs)
  validateCapability(response.url, access)
  try {
    await consume(response.url)
  } catch {
    fail("consumer_failed")
  }
  return {
    instanceId: expected.instanceId,
    generation: expected.generation,
    access,
    capabilityChecked: true,
  }
}

export function requestPolicyChange() {
  fail("runtime_control_unavailable")
}
