/**
 * Bounded, coalescing toast delivery (SYN-04).
 *
 * The queue is a plain data structure and every mutation takes an explicit
 * `now`, so runtime-event storms can be replayed deterministically in tests.
 *
 * Invariants:
 * - `items` never holds more than `MAX_TOASTS` entries, so a burst cannot build
 *   a hidden backlog that is replayed wave after wave once the visible toasts
 *   disappear.
 * - Exact repeats (same explicit `dedupeKey`) coalesce into the live toast and
 *   only bump its counter. Coalescing never extends the lifetime, so a
 *   continuous stream cannot pin a permanent notification on screen.
 * - A dismissed key stays muted for `TOAST_MUTE_MS`, so neither a manual nor an
 *   automatic dismissal is undone by the events that are still arriving.
 * - Coalescing and mute protection apply only to requests with an explicit
 *   `dedupeKey`. Plain notice/error requests stay independent: two manual
 *   actions with the same outcome produce two separate notifications, and the
 *   same message may resurface immediately after a dismissal.
 */

export type ToastKind = "error" | "notice"

/** Upper bound on toasts kept in state. The container renders all of them. */
export const MAX_TOASTS = 4

/** How long a toast stays on screen before it dismisses itself. */
export const TOAST_TTL_MS = 5_500

/** How long a dismissed key stays suppressed before it may surface again. */
export const TOAST_MUTE_MS = 8_000

/** Upper bound on the suppressed-key bookkeeping. */
export const MAX_MUTED_KEYS = 64

/** Display bounds for long or multi-line runtime errors. */
export const MAX_TOAST_LINES = 3
export const MAX_TOAST_CHARS = 220

export interface ToastRequest {
  kind: ToastKind
  message: string
  /**
   * Identity used to coalesce exact repeats and to mute a dismissed toast
   * against replay. Callers that know more about the source event (terminal,
   * role, fallback edge, reason) pass a key that keeps those variants apart.
   * When omitted, the toast is fully independent: it never merges with other
   * toasts and is never suppressed after a dismissal, so plain
   * showNotice/showError keep behaving like ordinary standalone notifications.
   */
  dedupeKey?: string
}

export interface ToastItem {
  id: string
  kind: ToastKind
  /** Clamped text that is safe to render in the toast. */
  message: string
  /** Untouched text, surfaced through the title attribute when clamped. */
  fullMessage: string
  truncated: boolean
  /** Occurrences coalesced into this toast, including the first one. */
  count: number
  /** Explicit coalescing/mute identity, or null for a standalone toast. */
  dedupeKey: string | null
  createdAt: number
  updatedAt: number
}

interface MutedToastKey {
  key: string
  until: number
}

export interface ToastState {
  items: ToastItem[]
  muted: MutedToastKey[]
  sequence: number
}

export function createToastState(): ToastState {
  return { items: [], muted: [], sequence: 0 }
}

/**
 * Coalescing identity of a request. Requests without an explicit key return
 * null and skip both coalescing and mute/replay protection entirely.
 */
export function toastDedupeKey(request: ToastRequest): string | null {
  return request.dedupeKey ?? null
}

/**
 * Reduces a message to a few short lines. A multi-line provider error keeps its
 * first lines instead of stretching the toast over the whole window.
 */
export function clampToastMessage(message: string): { message: string; truncated: boolean } {
  const lines = message
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  let truncated = lines.length > MAX_TOAST_LINES
  let text = lines.slice(0, MAX_TOAST_LINES).join("\n")

  if (text.length > MAX_TOAST_CHARS) {
    text = `${text.slice(0, MAX_TOAST_CHARS).trimEnd()}…`
    truncated = true
  }

  return { message: text, truncated }
}

function pruneMuted(muted: MutedToastKey[], now: number): MutedToastKey[] {
  const active = muted.filter((entry) => entry.until > now)
  return active.length > MAX_MUTED_KEYS ? active.slice(active.length - MAX_MUTED_KEYS) : active
}

function isMuted(muted: MutedToastKey[], key: string, now: number): boolean {
  return muted.some((entry) => entry.key === key && entry.until > now)
}

export function enqueueToast(state: ToastState, request: ToastRequest, now: number): ToastState {
  const dedupeKey = toastDedupeKey(request)

  if (dedupeKey !== null) {
    const liveIndex = state.items.findIndex((item) => item.dedupeKey === dedupeKey)

    if (liveIndex >= 0) {
      const live = state.items[liveIndex]
      const items = state.items.slice()
      items[liveIndex] = { ...live, count: live.count + 1, updatedAt: now }
      return { ...state, items }
    }

    if (isMuted(state.muted, dedupeKey, now)) {
      // Same reference on purpose: a suppressed repeat must not re-render the UI.
      return state
    }
  }

  const sequence = state.sequence + 1
  const clamped = clampToastMessage(request.message)
  const items: ToastItem[] = [
    ...state.items,
    {
      id: `toast-${sequence}`,
      kind: request.kind,
      message: clamped.message,
      fullMessage: request.message,
      truncated: clamped.truncated,
      count: 1,
      dedupeKey,
      createdAt: now,
      updatedAt: now,
    },
  ]

  return {
    items: items.length > MAX_TOASTS ? items.slice(items.length - MAX_TOASTS) : items,
    muted: pruneMuted(state.muted, now),
    sequence,
  }
}

export function dismissToast(state: ToastState, id: string, now: number): ToastState {
  const dismissed = state.items.find((item) => item.id === id)
  if (!dismissed) return state

  const items = state.items.filter((item) => item.id !== id)
  const dismissedKey = dismissed.dedupeKey

  if (dismissedKey === null) {
    // A standalone toast has no identity to protect, so there is nothing to
    // mute: the same plain notice/error may resurface immediately.
    return { items, muted: pruneMuted(state.muted, now), sequence: state.sequence }
  }

  return {
    items,
    muted: pruneMuted(
      [
        ...state.muted.filter((entry) => entry.key !== dismissedKey),
        { key: dismissedKey, until: now + TOAST_MUTE_MS },
      ],
      now,
    ),
    sequence: state.sequence,
  }
}

/**
 * Mirrors the per-toast timeout owned by the container: a toast that reached its
 * lifetime is dismissed exactly like a manual dismissal, muting included for
 * toasts with an explicit dedupe key.
 */
export function expireToasts(state: ToastState, now: number): ToastState {
  return state.items
    .filter((item) => now - item.createdAt >= TOAST_TTL_MS)
    .reduce((next, item) => dismissToast(next, item.id, now), state)
}
