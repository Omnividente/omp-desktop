import { useCallback, useMemo, useRef, useState } from "react"
import { errorMessage, readSessionTranscript } from "./api"
import { t, type Lang } from "./i18n"
import { localeTag } from "./uiUtils"
import type { SessionSummary, SessionTranscript } from "./types"

type TranscriptMode = "dialogue" | "all"

export interface TranscriptState {
  transcriptSession: SessionSummary | null
  transcript: SessionTranscript | null
  transcriptLoading: boolean
  transcriptError: string | null
  transcriptSearch: string
  transcriptMode: TranscriptMode
  visibleEntries: SessionTranscript["entries"]
  loadTranscript: (session: SessionSummary) => Promise<void>
  closeTranscript: () => void
  setSearch: (value: string) => void
  setMode: (value: TranscriptMode) => void
}

function transcriptRoleLabel(role: string, language: Lang): string {
  switch (role.trim().toLocaleLowerCase("en-US")) {
    case "user":
      return t(language, "transcriptRoleUser")
    case "assistant":
      return t(language, "transcriptRoleAssistant")
    case "tool":
    case "toolresult":
      return t(language, "transcriptRoleTool")
    case "system":
      return t(language, "transcriptRoleSystem")
    default:
      return role
  }
}

export function useTranscript(language: Lang): TranscriptState {
  const requestRef = useRef(0)
  const [transcriptSession, setTranscriptSession] = useState<SessionSummary | null>(null)
  const [transcript, setTranscript] = useState<SessionTranscript | null>(null)
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const [transcriptSearch, setTranscriptSearch] = useState("")
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>("all")

  const loadTranscript = useCallback(
    async (session: SessionSummary) => {
      const requestId = requestRef.current + 1
      requestRef.current = requestId
      setTranscriptSession(session)
      setTranscript(null)
      setTranscriptError(null)
      setTranscriptLoading(true)
      try {
        const next = await readSessionTranscript(session.filePath)
        if (requestRef.current === requestId) {
          setTranscript(next)
          setTranscriptSession(next.session)
        }
      } catch (error) {
        if (requestRef.current === requestId) {
          setTranscriptError(errorMessage(error, language))
        }
      } finally {
        if (requestRef.current === requestId) {
          setTranscriptLoading(false)
        }
      }
    },
    [language],
  )

  const closeTranscript = useCallback(() => {
    requestRef.current += 1
    setTranscriptSession(null)
    setTranscript(null)
    setTranscriptError(null)
    setTranscriptLoading(false)
    setTranscriptSearch("")
    setTranscriptMode("all")
  }, [])

  const visibleEntries = useMemo(() => {
    const query = transcriptSearch.trim().toLocaleLowerCase(localeTag(language))
    return (transcript?.entries ?? []).filter((entry) => {
      const visibleText = transcriptMode === "dialogue" ? entry.dialogueText : entry.text
      if (!visibleText) return false
      if (!query) return true
      return [
        visibleText,
        entry.kind ?? "",
        entry.model ?? "",
        transcriptRoleLabel(entry.role, language),
      ]
        .join("\n")
        .toLocaleLowerCase(localeTag(language))
        .includes(query)
    })
  }, [language, transcript, transcriptMode, transcriptSearch])

  return {
    transcriptSession,
    transcript,
    transcriptLoading,
    transcriptError,
    transcriptSearch,
    transcriptMode,
    visibleEntries,
    loadTranscript,
    closeTranscript,
    setSearch: setTranscriptSearch,
    setMode: setTranscriptMode,
  }
}
