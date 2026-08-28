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

export function formatRelative(timestamp: number, lang: Lang): string {
  if (!timestamp) {
    return lang === "en" ? "no runs" : "нет запусков"
  }
  const relativeTime = new Intl.RelativeTimeFormat(localeTag(lang), { numeric: "auto" })
  const calendarDate = new Intl.DateTimeFormat(localeTag(lang), {
    day: "numeric",
    month: "short",
  })
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
  const latest = node.children.reduce(
    (current, child) => Math.max(current, latestTreeActivity(child, cache)),
    node.session.updatedAt,
  )
  cache.set(node.session.id, latest)
  return latest
}

export function latestSessionInTree(node: SessionTreeNode): SessionSummary {
  let latest = node.session
  for (const child of node.children) {
    const candidate = latestSessionInTree(child)
    if (candidate.updatedAt > latest.updatedAt) latest = candidate
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
    const parentPath = node.session.parentSessionPath?.trim()
    if (!parentPath) continue
    const previous = nodesByPath.get(normalizedPath(parentPath, platform))
    if (previous && previous.session.id !== node.session.id) {
      previousById.set(node.session.id, previous)
    }
  }

  const createsCycle = (sessionId: string): boolean => {
    const seen = new Set([sessionId])
    let previous = previousById.get(sessionId)
    while (previous) {
      if (seen.has(previous.session.id)) return true
      seen.add(previous.session.id)
      previous = previousById.get(previous.session.id)
    }
    return false
  }

  // OMP stores the previous session in child.parentSession. The UI puts the
  // newest session at the group root and displays archived predecessors below it.
  const newerByPreviousId = new Map<string, SessionTreeNode[]>()
  for (const node of nodes) {
    const previous = previousById.get(node.session.id)
    if (!previous || createsCycle(node.session.id)) continue
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
  const sortChildren = (node: SessionTreeNode) => {
    node.children.forEach(sortChildren)
    node.children.sort(sortByLatestActivity)
  }
  roots.forEach(sortChildren)
  roots.sort(sortByLatestActivity)
  return roots
}

export function filterSessionTree(
  nodes: SessionTreeNode[],
  matchingSessionIds: ReadonlySet<string>,
): SessionTreeNode[] {
  return nodes.flatMap((node) => {
    const children = filterSessionTree(node.children, matchingSessionIds)
    if (!matchingSessionIds.has(node.session.id) && children.length === 0) return []
    return [{ session: node.session, children }]
  })
}

export function flattenSessionTree(
  nodes: SessionTreeNode[],
  expandedSessionIds: ReadonlySet<string>,
  forceExpand = false,
): FlattenedSessionTreeItem[] {
  const items: FlattenedSessionTreeItem[] = []
  const visit = (node: SessionTreeNode, depth: number) => {
    const hasChildren = node.children.length > 0
    const expanded = hasChildren && (forceExpand || expandedSessionIds.has(node.session.id))
    items.push({ session: node.session, depth, hasChildren, expanded })
    if (expanded) node.children.forEach((child) => visit(child, depth + 1))
  }
  nodes.forEach((node) => visit(node, 0))
  return items
}

export function sessionAncestorIds(nodes: SessionTreeNode[], sessionId: string): string[] {
  const visit = (node: SessionTreeNode): string[] | null => {
    if (node.session.id === sessionId) return []
    for (const child of node.children) {
      const descendants = visit(child)
      if (descendants) return [node.session.id, ...descendants]
    }
    return null
  }

  for (const node of nodes) {
    const ancestors = visit(node)
    if (ancestors) return ancestors
  }
  return []
}
