import type { Plugin } from "vite"

export function patchXtermUtf8(code: string, id: string): string | null
export function terminalUtf8Plugin(): Plugin
