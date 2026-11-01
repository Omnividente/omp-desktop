/** CSS reduced-motion rules cannot control xterm's JavaScript scroll scheduler. */
export function terminalMotion(platform: string) {
  let query: MediaQueryList | undefined
  if (platform !== "linux") {
    try {
      query = window.matchMedia("(prefers-reduced-motion: reduce)")
    } catch {
      // Unsupported media queries retain the existing platform behavior.
    }
  }
  const duration = () => (platform === "linux" || query?.matches ? 0 : 90)
  return {
    duration,
    subscribe(apply: (duration: number) => void): () => void {
      let disposed = false
      const update = () => {
        if (!disposed) apply(duration())
      }
      let unsubscribe: (() => void) | undefined
      if (typeof query?.addEventListener === "function") {
        query.addEventListener("change", update)
        unsubscribe = () => query.removeEventListener("change", update)
      }
      update()
      return () => {
        disposed = true
        unsubscribe?.()
      }
    },
  }
}
