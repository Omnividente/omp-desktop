import { createHash } from "node:crypto"
import {
  inspectRegistry,
  ProbeError,
  requestPolicyChange,
  RUNTIME_CAPABILITIES,
  withCapability,
} from "./registry-client.mjs"

const HELP = `OMP Remote Collab compatibility probe (experimental, local IPC only)

  node tools/remote-collab-spike/probe.mjs inspect --registry-dir ABSOLUTE_PATH
  node tools/remote-collab-spike/probe.mjs check-link --registry-dir ABSOLUTE_PATH \\
    --instance INSTANCE_ID --session SESSION_ID --generation NUMBER --access view|control

Optional: --timeout-ms NUMBER (10..10000; default 1500 per request).
No default registry directory, relay connection, browser launch or runtime mutation.
inspect hashes session IDs; titles, paths, tokens and capability URLs are never printed.
start, stop and set-access report runtime_control_unavailable.
Use an explicitly prepared isolated test registry; see this directory's README.md.
`

function parseArgs(args) {
  const [command, ...rest] = args
  if (["start", "stop", "set-access"].includes(command)) requestPolicyChange()
  if (!["inspect", "check-link"].includes(command)) throw new ProbeError("invalid_arguments")
  const allowed = command === "inspect"
    ? ["registry-dir", "timeout-ms"]
    : ["registry-dir", "timeout-ms", "instance", "session", "generation", "access"]
  const values = Object.create(null)
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]?.slice(2)
    if (
      !rest[i]?.startsWith("--") || !allowed.includes(flag) ||
      values[flag] !== undefined || rest[i + 1] === undefined
    ) throw new ProbeError("invalid_arguments")
    values[flag] = rest[i + 1]
  }
  if (!values["registry-dir"]) throw new ProbeError("invalid_arguments")
  for (const numeric of ["timeout-ms", "generation"]) {
    if (values[numeric] !== undefined && !/^[1-9][0-9]*$/.test(values[numeric])) {
      throw new ProbeError("invalid_arguments")
    }
  }
  return { command, values }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && ["--help", "help"].includes(args[0])) {
    process.stdout.write(HELP)
    return
  }
  const { command, values } = parseArgs(args)
  const options = {
    registryDir: values["registry-dir"],
    ...(values["timeout-ms"] ? { timeoutMs: Number(values["timeout-ms"]) } : {}),
  }
  let result
  if (command === "inspect") {
    const inspected = await inspectRegistry(options)
    result = {
      ...inspected,
      hosts: inspected.hosts.map(({ sessionId, ...host }) => ({
        ...host,
        sessionFingerprint: createHash("sha256").update(sessionId).digest("hex"),
      })),
    }
  } else {
    result = await withCapability({
      ...options,
      expected: {
        instanceId: values.instance,
        sessionId: values.session,
        generation: Number(values.generation),
      },
      access: values.access,
    }, () => {})
  }
  process.stdout.write(JSON.stringify({ ok: true, ...result, capabilities: RUNTIME_CAPABILITIES }) + "\n")
}

try {
  await main()
} catch (error) {
  const code = error instanceof ProbeError ? error.code : "probe_failed"
  process.stderr.write(JSON.stringify({ ok: false, code }) + "\n")
  process.exitCode = code === "invalid_arguments" ? 2 : code === "runtime_control_unavailable" ? 3 : 1
}
