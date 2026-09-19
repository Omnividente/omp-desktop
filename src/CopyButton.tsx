import { useEffect, useRef, useState } from "react"
import { writeText } from "@tauri-apps/plugin-clipboard-manager"
import { errorMessage } from "./api"
import { t, type Lang } from "./i18n"
import "./MarkdownContent.css"

interface CopyButtonProps {
  text: string
  label: string
  lang: Lang
  onError: (message: string) => void
}

export function CopyButton({ text, label, lang, onError }: CopyButtonProps) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied">("idle")
  const request = useRef({ generation: 0 })
  const pending = useRef(false)
  const resetTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    const scope = request.current
    scope.generation++
    pending.current = false
    setStatus("idle")
    return () => {
      scope.generation++
      clearTimeout(resetTimer.current)
    }
  }, [text])

  const copy = async () => {
    if (pending.current) return
    const current = ++request.current.generation
    pending.current = true
    clearTimeout(resetTimer.current)
    setStatus("copying")
    try {
      await writeText(text)
      if (request.current.generation !== current) return
      setStatus("copied")
      resetTimer.current = window.setTimeout(() => setStatus("idle"), 2000)
    } catch (error) {
      if (request.current.generation !== current) return
      setStatus("idle")
      onError(errorMessage(error, lang))
    } finally {
      if (request.current.generation === current) pending.current = false
    }
  }

  return (
    <button
      className="markdown-copy-button"
      type="button"
      disabled={status === "copying"}
      onClick={() => void copy()}
      aria-label={label}
      title={label}
    >
      <span role="status" aria-live="polite">
        {status === "copied"
          ? t(lang, "clipboardCopied")
          : status === "copying"
            ? t(lang, "copying")
            : label}
      </span>
    </button>
  )
}
