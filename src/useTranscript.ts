import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { errorMessage, readSessionTranscript } from "./api"
import { type Lang } from "./i18n"
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

export function useTranscript(language: Lang): TranscriptState {
  const requestRef = useRef(0)
  const sessionPathRef = useRef<string | null>(null)
  const [transcriptSession, setTranscriptSession] = useState<SessionSummary | null>(null)
  const [transcript, setTranscript] = useState<SessionTranscript | null>(null)
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const [transcriptSearch, setTranscriptSearch] = useState("")
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>("all")

  useEffect(
    () => () => {
      requestRef.current += 1
    },
    [],
  )

  const loadTranscript = useCallback(
    async (session: SessionSummary) => {
      const requestId = requestRef.current + 1
      requestRef.current = requestId
      if (sessionPathRef.current !== session.filePath) {
        setTranscriptSearch("")
        setTranscriptMode("all")
      }
      sessionPathRef.current = session.filePath
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
    sessionPathRef.current = null
    setTranscriptSession(null)
    setTranscript(null)
    setTranscriptError(null)
    setTranscriptLoading(false)
    setTranscriptSearch("")
    setTranscriptMode("all")
  }, [])

  const visibleEntries = useMemo(
    () =>
      (transcript?.entries ?? []).filter((entry) =>
        Boolean(transcriptMode === "dialogue" ? entry.dialogueText : entry.text),
      ),
    [transcript, transcriptMode],
  )

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
