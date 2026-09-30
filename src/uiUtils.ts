import { t, type Lang } from "./i18n"
import type {
  BootstrapPayload,
  PtyExitEvent,
  SessionSummary,
  TerminalStarted,
  TerminalTab,
} from "./types"

type SessionIdentity = Pick<SessionSummary, "id" | "filePath">

export function localeTag(lang: Lang): string {
  return lang === "en" ? "en" : "ru"
}

export function formatTerminalExitLine(event: PtyExitEvent, language: Lang): string {
  if (event.error) {
    return `\r\n\x1b[38;2;239;112;112m${t(language, "ompTerminated")}: ${event.error}\x1b[0m\r\n`
  }
  const color = event.success ? "129;201;149" : "239;170;103"
  const code = event.exitCode ?? "?"
  return `\r\n\x1b[38;2;${color}m${t(language, "ompExitedCode").replace("{code}", String(code))}\x1b[0m\r\n`
}

const relativeFormatters = {
  en: {
    relative: new Intl.RelativeTimeFormat("en", { numeric: "auto" }),
    date: new Intl.DateTimeFormat("en", { day: "numeric", month: "short" }),
  },
  ru: {
    relative: new Intl.RelativeTimeFormat("ru", { numeric: "auto" }),
    date: new Intl.DateTimeFormat("ru", { day: "numeric", month: "short" }),
  },
} satisfies Record<Lang, { relative: Intl.RelativeTimeFormat; date: Intl.DateTimeFormat }>

export function formatRelative(timestamp: number, lang: Lang): string {
  if (!timestamp) {
    return lang === "en" ? "no runs" : "нет запусков"
  }
  const { relative: relativeTime, date: calendarDate } = relativeFormatters[lang]
  const seconds = Math.round((timestamp - Date.now()) / 1000)
  const absolute = Math.abs(seconds)
  if (absolute < 60) return relativeTime.format(seconds, "second")
  if (absolute < 3_600) return relativeTime.format(Math.round(seconds / 60), "minute")
  if (absolute < 86_400) return relativeTime.format(Math.round(seconds / 3_600), "hour")
  if (absolute < 604_800) return relativeTime.format(Math.round(seconds / 86_400), "day")
  return calendarDate.format(timestamp)
}

export function normalizedPath(path: string, platform: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "")
  return platform === "windows" ? normalized.toLocaleLowerCase("en-US") : normalized
}

export function tabMatchesSession(
  tab: TerminalTab,
  session: SessionIdentity,
  platform: string,
): boolean {
  return (
    tab.sessionId === session.id ||
    Boolean(
      tab.sessionPath &&
      normalizedPath(tab.sessionPath, platform) === normalizedPath(session.filePath, platform),
    )
  )
}

export function reorderTerminalTabs(
  tabs: TerminalTab[],
  draggedId: string,
  targetId: string,
): TerminalTab[] {
  if (draggedId === targetId) return tabs
  const draggedIndex = tabs.findIndex((tab) => tab.id === draggedId)
  const targetIndex = tabs.findIndex((tab) => tab.id === targetId)
  if (draggedIndex < 0 || targetIndex < 0) return tabs
  const reordered = [...tabs]
  const [moved] = reordered.splice(draggedIndex, 1)
  reordered.splice(targetIndex, 0, moved)
  return reordered
}

export function mergeSessionIntoPayload(
  payload: BootstrapPayload,
  session: SessionSummary,
  platform: string,
): BootstrapPayload {
  const sessionPath = normalizedPath(session.filePath, platform)
  const sessions = [
    session,
    ...payload.sessions.filter(
      (candidate) =>
        candidate.id !== session.id && normalizedPath(candidate.filePath, platform) !== sessionPath,
    ),
  ].sort((left, right) => right.updatedAt - left.updatedAt)

  return { ...payload, sessions }
}

export function replaceTerminalAfterRestart(
  tab: TerminalTab,
  previousTerminalId: string,
  started: TerminalStarted,
  primaryProviderPinned: boolean,
): TerminalTab {
  if (tab.id !== previousTerminalId) return tab
  return {
    ...tab,
    id: started.terminalId,
    cwd: started.cwd,
    processId: started.processId,
    status: "running",
    activity: "idle",
    exitCode: null,
    success: null,
    switching: false,
    switchRecovery: null,
    primaryProviderPinned,
    primaryProviderPinPending: false,
  }
}

export interface SessionTreeNode {
  session: SessionSummary
  children: SessionTreeNode[]
}

export interface FlattenedSessionTreeItem {
  session: SessionSummary
  depth: number
  hasChildren: boolean
  expanded: boolean
}

function latestTreeActivity(node: SessionTreeNode, cache: Map<string, number>): number {
  const cached = cache.get(node.session.id)
  if (cached !== undefined) return cached
  const stack = [{ node, nextChild: 0, latest: node.session.updatedAt }]
  let latest = node.session.updatedAt
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (frame.nextChild < frame.node.children.length) {
      const child = frame.node.children[frame.nextChild++]
      const childActivity = cache.get(child.session.id)
      if (childActivity !== undefined) {
        frame.latest = Math.max(frame.latest, childActivity)
      } else {
        stack.push({ node: child, nextChild: 0, latest: child.session.updatedAt })
      }
      continue
    }
    latest = frame.latest
    cache.set(frame.node.session.id, latest)
    stack.pop()
    if (stack.length > 0) {
      const parent = stack[stack.length - 1]
      parent.latest = Math.max(parent.latest, latest)
    }
  }
  return latest
}

export function latestSessionInTree(node: SessionTreeNode): SessionSummary {
  const stack = [{ node, nextChild: 0, latest: node.session }]
  let latest = node.session
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (frame.nextChild < frame.node.children.length) {
      const child = frame.node.children[frame.nextChild++]
      stack.push({ node: child, nextChild: 0, latest: child.session })
      continue
    }
    latest = frame.latest
    stack.pop()
    if (stack.length > 0) {
      const parent = stack[stack.length - 1]
      if (latest.updatedAt > parent.latest.updatedAt) parent.latest = latest
    }
  }
  return latest
}

export function buildSessionTree(sessions: SessionSummary[], platform: string): SessionTreeNode[] {
  const nodes = sessions.map<SessionTreeNode>((session) => ({ session, children: [] }))
  const nodesByPath = new Map(
    nodes.map((node) => [normalizedPath(node.session.filePath, platform), node]),
  )
  const nodesById = new Map(nodes.map((node) => [node.session.id, node]))
  const previousById = new Map<string, SessionTreeNode>()

  for (const node of nodes) {
    const parentReference = node.session.parentSessionPath?.trim()
    if (!parentReference) continue
    const previous =
      nodesByPath.get(normalizedPath(parentReference, platform)) ?? nodesById.get(parentReference)
    if (previous && previous.session.id !== node.session.id) {
      previousById.set(node.session.id, previous)
    }
  }

  // Each previous-session edge is visited once. Mark the whole path, not only
  // cycle members: sessions leading into a cycle must also remain unlinked.
  const lineageState = new Map<string, "visiting" | "acyclic" | "cyclic">()
  for (const node of nodes) {
    if (lineageState.has(node.session.id)) continue
    const path: string[] = []
    let current: SessionTreeNode | undefined = node
    while (current && !lineageState.has(current.session.id)) {
      const id = current.session.id
      lineageState.set(id, "visiting")
      path.push(id)
      current = previousById.get(id)
    }
    const state = current && lineageState.get(current.session.id)
    const settled = state === "visiting" || state === "cyclic" ? "cyclic" : "acyclic"
    for (const id of path) lineageState.set(id, settled)
  }

  // OMP stores the previous session in child.parentSession. The UI puts the
  // newest session at the group root and displays archived predecessors below it.
  const newerByPreviousId = new Map<string, SessionTreeNode[]>()
  for (const node of nodes) {
    const previous = previousById.get(node.session.id)
    if (!previous || lineageState.get(node.session.id) === "cyclic") continue
    const newerSessions = newerByPreviousId.get(previous.session.id)
    if (newerSessions) newerSessions.push(node)
    else newerByPreviousId.set(previous.session.id, [node])
  }

  const hasDisplayParent = new Set<string>()
  for (const [previousId, newerSessions] of newerByPreviousId) {
    newerSessions.sort(
      (left, right) =>
        right.session.updatedAt - left.session.updatedAt ||
        left.session.id.localeCompare(right.session.id),
    )
    const newest = newerSessions[0]
    const previous = nodesById.get(previousId)
    if (!newest || !previous) continue
    newest.children.push(previous)
    hasDisplayParent.add(previousId)
  }

  const roots = nodes.filter((node) => !hasDisplayParent.has(node.session.id))
  const activityCache = new Map<string, number>()
  const sortByLatestActivity = (left: SessionTreeNode, right: SessionTreeNode): number =>
    latestTreeActivity(right, activityCache) - latestTreeActivity(left, activityCache) ||
    right.session.updatedAt - left.session.updatedAt ||
    left.session.id.localeCompare(right.session.id)
  const pending = [...roots]
  while (pending.length > 0) {
    const node = pending.pop()!
    node.children.sort(sortByLatestActivity)
    for (const child of node.children) pending.push(child)
  }
  roots.sort(sortByLatestActivity)
  return roots
}

export function filterSessionTree(
  nodes: SessionTreeNode[],
  matchingSessionIds: ReadonlySet<string>,
): SessionTreeNode[] {
  const filtered: SessionTreeNode[] = []
  for (const node of nodes) {
    const stack = [{ node, nextChild: 0, children: [] as SessionTreeNode[] }]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      if (frame.nextChild < frame.node.children.length) {
        const child = frame.node.children[frame.nextChild++]
        stack.push({ node: child, nextChild: 0, children: [] })
        continue
      }
      stack.pop()
      if (!matchingSessionIds.has(frame.node.session.id) && frame.children.length === 0) continue
      const target = stack.length > 0 ? stack[stack.length - 1].children : filtered
      target.push({ session: frame.node.session, children: frame.children })
    }
  }
  return filtered
}

export function flattenSessionTree(
  nodes: SessionTreeNode[],
  expandedSessionIds: ReadonlySet<string>,
  forceExpand = false,
): FlattenedSessionTreeItem[] {
  const items: FlattenedSessionTreeItem[] = []
  const stack = [{ nodes, index: 0 }]
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (frame.index === frame.nodes.length) {
      stack.pop()
      continue
    }
    const node = frame.nodes[frame.index++]
    const hasChildren = node.children.length > 0
    const expanded = hasChildren && (forceExpand || expandedSessionIds.has(node.session.id))
    items.push({ session: node.session, depth: stack.length - 1, hasChildren, expanded })
    if (expanded) stack.push({ nodes: node.children, index: 0 })
  }
  return items
}

function sessionTreePath(nodes: SessionTreeNode[], sessionId: string): SessionTreeNode[] {
  const path: SessionTreeNode[] = []
  const stack = [{ nodes, index: 0 }]
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (frame.index === frame.nodes.length) {
      stack.pop()
      path.pop()
      continue
    }
    const node = frame.nodes[frame.index++]
    path.push(node)
    if (node.session.id === sessionId) return path
    if (node.children.length > 0) stack.push({ nodes: node.children, index: 0 })
    else path.pop()
  }
  return path
}

export function sessionAncestorIds(nodes: SessionTreeNode[], sessionId: string): string[] {
  const path = sessionTreePath(nodes, sessionId)
  path.pop()
  return path.map((node) => node.session.id)
}

export function sessionGroupExpansionIds(nodes: SessionTreeNode[], sessionId: string): string[] {
  const path = sessionTreePath(nodes, sessionId)
  if (path.length > 0 && path[path.length - 1].children.length === 0) path.pop()
  return path.map((node) => node.session.id)
}
