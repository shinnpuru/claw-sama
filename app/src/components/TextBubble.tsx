import { useEffect, useState, useRef, useCallback } from 'react'
import { LipSync } from '../lip-sync'

interface VrmMessage {
  text?: string
  emotion?: string
  emotionDuration?: number
  emotionIntensity?: number
  duration?: number
  audioUrl?: string
  audioIndex?: number
  audioTotal?: number
  streaming?: boolean
}

export type OnVrmMessage = (msg: VrmMessage) => void

const CHAR_RATE_MS = 60
const AUDIO_BUFFER_MS = 2000
const MAX_EXTRA_WAIT_MS = 8_000 // max extra time to wait for TTS beyond text duration
const POP_DURATION_MS = 300

// Grapheme segmenter singleton
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// Inject pop animation keyframes once
const STYLE_ID = 'claw-pop-keyframes'
if (!document.getElementById(STYLE_ID)) {
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    @keyframes claw-pop-in {
      0% { opacity: 0; transform: scale(0) translateY(0.5em); }
      60% { opacity: 1; transform: scale(1.15) translateY(-0.05em); }
      100% { opacity: 1; transform: scale(1) translateY(0); }
    }
  `
  document.head.appendChild(style)
}

export function TextBubble({ onMessage, enabled = true, ttsEnabled = true }: { onMessage?: OnVrmMessage; enabled?: boolean; ttsEnabled?: boolean }) {
  const [text, setText] = useState('')
  const [visible, setVisible] = useState(false)
  const [charCount, setCharCount] = useState(0) // how many chars are "revealed"
  const [thinking, setThinking] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null) // hard ceiling — never cancelled by audio
  const typewriterRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Split text into grapheme clusters
  const chars = useRef<string[]>([])

  // Track previously revealed count for incremental streaming
  const prevRevealedRef = useRef<number>(0)

  // Audio queue for sequential playback — keyed by index for ordering
  const audioQueueRef = useRef<Map<number, string>>(new Map())
  const audioPlayingRef = useRef<boolean>(false)
  const audioNextIndexRef = useRef<number>(0)
  const audioTotalRef = useRef<number>(0)
  const audioReceivedRef = useRef<number>(0)

  // Auto-scroll to bottom on char reveal
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [charCount])

  const scheduleHideAfterAudio = useCallback(() => {
    // All audio played — hide bubble after a short buffer
    if (timerRef.current) clearTimeout(timerRef.current)
    if (maxTimerRef.current) { clearTimeout(maxTimerRef.current); maxTimerRef.current = null }
    timerRef.current = setTimeout(() => setVisible(false), AUDIO_BUFFER_MS)
  }, [])

  const playNextAudio = useCallback(() => {
    if (audioPlayingRef.current) return
    const nextIdx = audioNextIndexRef.current
    const url = audioQueueRef.current.get(nextIdx)
    if (!url) return // next index hasn't arrived yet — wait
    audioQueueRef.current.delete(nextIdx)
    audioNextIndexRef.current = nextIdx + 1
    audioPlayingRef.current = true
    const lipSync = LipSync.getInstance()
    const onDone = () => {
      audioPlayingRef.current = false
      if (audioQueueRef.current.has(audioNextIndexRef.current)) {
        playNextAudio()
      } else if (audioReceivedRef.current >= audioTotalRef.current && audioTotalRef.current > 0) {
        scheduleHideAfterAudio()
      }
    }
    lipSync.playAudio(url).then((durationMs) => {
      setTimeout(onDone, durationMs)
    }).catch(onDone)
  }, [scheduleHideAfterAudio])

  const handleMessage = useCallback((msg: VrmMessage) => {
    // Audio-only message (from TTS queue broadcast)
    if (!msg.text && msg.audioUrl) {
      if (msg.audioTotal) audioTotalRef.current = msg.audioTotal
      audioReceivedRef.current++
      // Cancel text-based hide timer — let audio completion handle it
      if (timerRef.current) clearTimeout(timerRef.current)
      // Tighten maxTimer: audio arrived, so cap remaining wait at 15s from now
      if (maxTimerRef.current) {
        clearTimeout(maxTimerRef.current)
        maxTimerRef.current = setTimeout(() => setVisible(false), 15_000)
      }
      const idx = msg.audioIndex ?? audioReceivedRef.current - 1
      audioQueueRef.current.set(idx, msg.audioUrl)
      playNextAudio()
      return
    }

    // Emotion-only message
    if (!msg.text) {
      if (msg.emotion) {
        onMessage?.({ ...msg, emotionDuration: msg.emotionDuration ?? 10000 })
        if (thinking) {
          setThinking(false)
          setVisible(false)
          setText('')
        }
      }
      return
    }

    if (timerRef.current) clearTimeout(timerRef.current)
    if (maxTimerRef.current) { clearTimeout(maxTimerRef.current); maxTimerRef.current = null }
    if (typewriterRef.current) clearInterval(typewriterRef.current)

    // Reset audio tracking for new message
    audioTotalRef.current = 0
    audioReceivedRef.current = 0
    audioNextIndexRef.current = 0

    const fullText = msg.text
    const graphemes = [...segmenter.segment(fullText)].map((s) => s.segment)
    chars.current = graphemes

    setText(fullText)
    setThinking(false)
    setVisible(true)

    // Incremental streaming: keep previously revealed chars visible
    const isStreaming = msg.streaming === true
    const previouslyRevealed = prevRevealedRef.current
    const startFrom = isStreaming && previouslyRevealed <= graphemes.length
      ? Math.min(previouslyRevealed, graphemes.length)
      : 0
    setCharCount(startFrom)

    const fallbackDuration = msg.duration || (graphemes.length * CHAR_RATE_MS + 5000)

    const startTypewriter = (duration: number, audioDurationMs?: number) => {
      setTimeout(() => onMessage?.({ ...msg, emotionDuration: duration }), 1000)
      const remainingChars = graphemes.length - startFrom
      const charInterval = audioDurationMs
        ? Math.max(20, (audioDurationMs * 0.8) / (remainingChars || 1))
        : CHAR_RATE_MS
      let idx = startFrom
      typewriterRef.current = setInterval(() => {
        idx++
        if (idx >= graphemes.length) {
          setCharCount(graphemes.length)
          prevRevealedRef.current = graphemes.length
          if (typewriterRef.current) clearInterval(typewriterRef.current)
        } else {
          setCharCount(idx)
          prevRevealedRef.current = idx
        }
      }, charInterval)

      // Only set auto-hide timer on final (non-streaming) messages
      if (!isStreaming) {
        // Normal hide timer (may be cancelled/replaced by audio callbacks)
        timerRef.current = setTimeout(() => setVisible(false), duration)
        if (ttsEnabled) {
          // Hard ceiling: text duration + extra wait, in case TTS partially fails
          maxTimerRef.current = setTimeout(() => setVisible(false), duration + MAX_EXTRA_WAIT_MS)
        }
      }
    }

    if (ttsEnabled && msg.audioUrl) {
      // First text+audio message: play directly and start typewriter
      audioQueueRef.current.clear() // reset queue for new message
      audioPlayingRef.current = false
      const lipSync = LipSync.getInstance()
      lipSync.playAudio(msg.audioUrl).then((audioDurationMs) => {
        const duration = Math.max(audioDurationMs + AUDIO_BUFFER_MS, fallbackDuration)
        startTypewriter(duration, audioDurationMs)
      }).catch((err) => {
        console.error('Audio play failed:', err)
        startTypewriter(fallbackDuration)
      })
      setTimeout(() => {
        if (!typewriterRef.current) startTypewriter(fallbackDuration)
      }, 3000)
    } else {
      startTypewriter(fallbackDuration)
    }
  }, [onMessage, ttsEnabled, playNextAudio])

  useEffect(() => {
    const es = new EventSource('http://127.0.0.1:18789/plugins/claw-sama/events')
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.clearText) {
          if (timerRef.current) clearTimeout(timerRef.current)
          if (maxTimerRef.current) { clearTimeout(maxTimerRef.current); maxTimerRef.current = null }
          if (typewriterRef.current) clearInterval(typewriterRef.current)
          setText('')
          setCharCount(0)
          setThinking(false)
          setVisible(false)
          prevRevealedRef.current = 0
          audioQueueRef.current.clear()
          audioPlayingRef.current = false
          audioNextIndexRef.current = 0
          audioTotalRef.current = 0
          audioReceivedRef.current = 0
          return
        }
        const msg: VrmMessage = data
        handleMessage(msg)
      } catch { /* ignore malformed */ }
    }
    return () => {
      es.close()
      if (timerRef.current) clearTimeout(timerRef.current)
      if (maxTimerRef.current) clearTimeout(maxTimerRef.current)
      if (typewriterRef.current) clearInterval(typewriterRef.current)
    }
  }, [handleMessage])

  if (!enabled || !visible || !text) return null

  return (
    <div style={containerStyle}>
      <div ref={scrollRef} style={boxStyle} data-no-passthrough>
        <div style={textStyle}>
          {chars.current.map((ch, i) => (
            i < charCount ? (
              <span key={i} style={popCharStyle}>{ch === '\n' ? <br /> : ch}</span>
            ) : null
          ))}
        </div>
      </div>
    </div>
  )
}

const popCharStyle: React.CSSProperties = {
  display: 'inline-block',
  animation: `claw-pop-in ${POP_DURATION_MS}ms ease-out both`,
  whiteSpace: 'pre',
}

const containerStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 76,
  left: 0,
  width: '100%',
  zIndex: 9000,
  pointerEvents: 'none',
  padding: 8,
  boxSizing: 'border-box',
}

const boxStyle: React.CSSProperties = {
  background: 'rgba(0, 0, 0, 0.35)',
  backdropFilter: 'blur(6px)',
  borderRadius: 12,
  border: '1px solid rgba(255, 255, 255, 0.15)',
  boxShadow: '0 0 12px rgba(100, 160, 255, 0.25), 0 0 24px rgba(100, 160, 255, 0.1)',
  padding: '8px 12px',
  height: 140,
  overflowY: 'auto' as const,
  pointerEvents: 'auto',
  userSelect: 'text',
  cursor: 'text',
}

const textStyle: React.CSSProperties = {
  color: '#fff',
  fontSize: 22,
  lineHeight: 1.6,
  wordBreak: 'break-word',
  fontFamily: '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
  textShadow: '0 0 6px rgba(255,255,255,0.5)',
}
