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
  transcriptInitialPosition: "start" | "end"
  visibleEntries: SessionTranscript["entries"]
  loadTranscript: (session: SessionSummary) => Promise<void>
  loadTranscriptPath: (path: string) => Promise<void>
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
  const [transcriptInitialPosition, setTranscriptInitialPosition] = useState<"start" | "end">(
    "start",
  )

  useEffect(
    () => () => {
      requestRef.current += 1
    },
    [],
  )

  const load = useCallback(
    async (path: string, session?: SessionSummary) => {
      const requestId = ++requestRef.current
      if (!session || sessionPathRef.current !== path) {
        setTranscriptSearch("")
        setTranscriptMode(session ? "all" : "dialogue")
        setTranscriptInitialPosition(session ? "start" : "end")
      }
      sessionPathRef.current = session ? path : null
      setTranscriptSession(session ?? null)
      setTranscript(null)
      setTranscriptError(null)
      setTranscriptLoading(true)
      try {
        const next = await readSessionTranscript(path)
        if (requestRef.current === requestId) {
          sessionPathRef.current = path
          setTranscript(next)
          setTranscriptSession(next.session)
        }
      } catch (error) {
        if (requestRef.current === requestId) {
          if (!session) throw error
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

  const loadTranscript = useCallback(
    (session: SessionSummary) => load(session.filePath, session),
    [load],
  )

  const loadTranscriptPath = useCallback((path: string) => load(path), [load])

  const closeTranscript = useCallback(() => {
    requestRef.current += 1
    sessionPathRef.current = null
    setTranscriptSession(null)
    setTranscript(null)
    setTranscriptError(null)
    setTranscriptLoading(false)
    setTranscriptSearch("")
    setTranscriptMode("all")
    setTranscriptInitialPosition("start")
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
    transcriptInitialPosition,
    visibleEntries,
    loadTranscript,
    loadTranscriptPath,
    closeTranscript,
    setSearch: setTranscriptSearch,
    setMode: setTranscriptMode,
  }
}
