import { useState, useRef, useCallback, useEffect } from 'react'
import { MessageCircle, Send, Loader, Mic, ChevronDown, History, SquarePen, Plus } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

const OPENCLAW_URL = 'http://127.0.0.1:18789/plugins/claw-sama/chat'

// Inject input bar animation keyframes once
const INPUT_STYLE_ID = 'claw-input-keyframes'
if (!document.getElementById(INPUT_STYLE_ID)) {
  const style = document.createElement('style')
  style.id = INPUT_STYLE_ID
  style.textContent = `
    @keyframes claw-input-slide-up {
      0% { opacity: 0; transform: translateY(20px) scale(0.95); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes claw-input-slide-down {
      0% { opacity: 1; transform: translateY(0) scale(1); }
      100% { opacity: 0; transform: translateY(20px) scale(0.95); }
    }
  `
  document.head.appendChild(style)
}

const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
const USE_NATIVE_STT = !SpeechRecognition

export function ChatInput({ visible = true, onActiveChange, uiAlign = 'right', onHistoryOpen, onNewSession }: { visible?: boolean; onActiveChange?: (hasText: boolean) => void; uiAlign?: 'left' | 'right'; onHistoryOpen?: () => void; onNewSession?: () => void }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [recording, setRecording] = useState(false)
  const [closing, setClosing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const recognitionRef = useRef<any>(null)
  const unlistenRef = useRef<UnlistenFn | null>(null)

  const closeBar = useCallback(() => {
    if (closing) return
    setClosing(true)
    setTimeout(() => { setOpen(false); setClosing(false) }, 220)
  }, [closing])

  const send = useCallback(async (msg?: string) => {
    const finalMsg = (msg ?? text).trim()
    if (!finalMsg || sending) return
    setSending(true)
    setText('')
    onActiveChange?.(false)
    try {
      await fetch(OPENCLAW_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: finalMsg }),
      })
    } catch (err) {
      console.error('Failed to send message:', err)
    } finally {
      setSending(false)
    }
  }, [text, sending])

  const startRecording = useCallback(async () => {
    if (USE_NATIVE_STT) {
      // macOS: use Tauri native SFSpeechRecognizer
      try {
        const unlisten = await listen<{ text: string; isFinal: boolean }>('speech-result', (event) => {
          setText(event.payload.text)
          onActiveChange?.(event.payload.text.length > 0)
        })
        unlistenRef.current = unlisten
        await invoke('start_speech_recognition')
        setRecording(true)
        setOpen(true)
      } catch (err) {
        console.error('Native speech recognition error:', err)
        unlistenRef.current?.()
        unlistenRef.current = null
      }
      return
    }

    // Windows: use Web Speech API
    if (!SpeechRecognition) {
      console.error('SpeechRecognition not supported')
      return
    }

    const recognition = new SpeechRecognition()
    recognition.lang = 'zh-CN'
    recognition.interimResults = true
    recognition.continuous = true

    recognition.onresult = (event: any) => {
      let transcript = ''
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript
      }
      setText(transcript)
      onActiveChange?.(transcript.length > 0)
    }

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error)
      setRecording(false)
    }

    recognition.onend = () => {
      setRecording(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }

    recognition.start()
    recognitionRef.current = recognition
    setRecording(true)
    setOpen(true)
  }, [])

  const stopRecording = useCallback(() => {
    if (USE_NATIVE_STT) {
      invoke('stop_speech_recognition').catch(console.error)
      unlistenRef.current?.()
      unlistenRef.current = null
      setRecording(false)
      return
    }

    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }
    setRecording(false)
  }, [])

  // 鼠标移出按钮时也停止录音
  const handleMouseLeave = useCallback(() => {
    if (recording) stopRecording()
  }, [recording, stopRecording])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
    if (e.key === 'Escape') {
      closeBar()
    }
    if ((e.key === 'Delete') || (e.key === 'd' && e.ctrlKey)) {
      e.preventDefault()
      setText('')
      onActiveChange?.(false)
    }

  }

  // 全局快捷键
  useEffect(() => {
    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if (!visible) return
      const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement

      // Enter: 唤起输入框 / 聚焦输入框
      if (e.key === 'Enter' && !e.shiftKey && !inInput) {
        e.preventDefault()
        if (!open) {
          setOpen(true)
        }
        setTimeout(() => inputRef.current?.focus(), 50)
      }

      // Escape: 收起输入框
      if (e.key === 'Escape' && open && !inInput) {
        e.preventDefault()
        closeBar()
      }

      // F2: 按住说话
      if (e.key === 'F2' && !recording) {
        e.preventDefault()
        startRecording()
      }
    }
    const onGlobalKeyUp = (e: KeyboardEvent) => {
      if (recording && e.key === 'F2') {
        stopRecording()
      }
    }
    window.addEventListener('keydown', onGlobalKeyDown)
    window.addEventListener('keyup', onGlobalKeyUp)
    return () => {
      window.removeEventListener('keydown', onGlobalKeyDown)
      window.removeEventListener('keyup', onGlobalKeyUp)
    }
  }, [open, visible, recording, startRecording, stopRecording, closeBar])

  if (!visible) return null

  if (!open) {
    return (
      <div style={{ position: 'absolute', bottom: 12, ...(uiAlign === 'left' ? { left: 12 } : { right: 12 }), zIndex: 300, pointerEvents: 'auto' }}>
        <button
          onClick={() => {
            setOpen(true)
            setTimeout(() => inputRef.current?.focus(), 50)
          }}
          style={fabStyle}
          title="发送消息 (Enter)"
        >
          <MessageCircle size={16} />
        </button>
      </div>
    )
  }

  return (
    <div
      key={closing ? 'closing' : 'open'}
      style={{
        ...barStyle,
        animation: closing
          ? 'claw-input-slide-down 0.2s ease-in forwards'
          : 'claw-input-slide-up 0.25s ease-out both',
      }}
    >
      <div style={{ flex: 1, position: 'relative' }}>
        {/* 左侧 + 号按钮 */}
        <button
          onClick={() => setMenuOpen((v) => !v)}
          style={{ ...inlineBtnLeft, color: menuOpen ? 'rgba(100, 160, 255, 0.9)' : 'rgba(255, 255, 255, 0.45)' }}
          title="更多"
        >
          <Plus size={20} />
        </button>
        {/* 弹出菜单 */}
        {menuOpen && (
          <div style={popupMenuStyle}>
            <button onClick={() => { setMenuOpen(false); onHistoryOpen?.() }} style={popupItemStyle}>
              <History size={14} />
              <span>对话历史</span>
            </button>
            <button onClick={() => { setMenuOpen(false); onNewSession?.() }} style={popupItemStyle}>
              <SquarePen size={14} />
              <span>新会话</span>
            </button>
          </div>
        )}
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            onActiveChange?.(e.target.value.length > 0)
          }}
          onKeyDown={handleKeyDown}
          placeholder={sending ? '思考中...' : ''}
          disabled={sending}
          style={{ ...inputStyle, paddingLeft: 48, paddingRight: 80 }}
          autoFocus
        />
        {/* 右侧：发送/收起 */}
        <button
          onMouseDown={startRecording}
          onMouseUp={stopRecording}
          onMouseLeave={handleMouseLeave}
          style={{ ...inlineBtnRight, right: 44, color: recording ? 'rgba(255, 80, 80, 0.9)' : 'rgba(255, 255, 255, 0.45)' }}
          title="按住说话 (F2)"
        >
          <Mic size={20} />
        </button>
        <button
          onClick={() => text.trim() ? send() : closeBar()}
          disabled={sending}
          style={{ ...inlineBtnRight, right: 12, color: text.trim() ? 'rgba(100, 160, 255, 0.9)' : 'rgba(255, 255, 255, 0.45)' }}
          title={text.trim() ? '发送 (Enter)' : '收起 (Esc)'}
        >
          {sending ? <Loader size={18} style={{ animation: 'spin 1s linear infinite' }} /> : text.trim() ? <Send size={18} /> : <ChevronDown size={20} />}
        </button>
      </div>
    </div>
  )
}

const fabStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  border: 'none',
  borderRadius: 6,
  background: 'rgba(125, 125, 125, 0.28)',
  backdropFilter: 'blur(6px)',
  color: 'rgba(255, 255, 255, 0.8)',
  fontSize: 16,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 300,
  pointerEvents: 'auto',
}

const barStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 12,
  left: 12,
  right: 12,
  display: 'flex',
  gap: 4,
  zIndex: 300,
  pointerEvents: 'auto',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 50,
  boxSizing: 'border-box' as const,
  border: '1px solid rgba(255, 255, 255, 0.2)',
  borderRadius: 25,
  background: 'rgba(0, 0, 0, 0.4)',
  backdropFilter: 'blur(6px)',
  color: '#fff',
  fontSize: 18,
  padding: '0 10px',
  outline: 'none',
  fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
}

const inlineBtnLeft: React.CSSProperties = {
  position: 'absolute',
  left: 12,
  top: '50%',
  transform: 'translateY(-50%)',
  width: 32,
  height: 32,
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  zIndex: 2,
}

const inlineBtnRight: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  transform: 'translateY(-50%)',
  width: 32,
  height: 32,
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  zIndex: 1,
}

const popupMenuStyle: React.CSSProperties = {
  position: 'absolute',
  left: 4,
  bottom: '100%',
  marginBottom: 6,
  background: 'rgba(30, 30, 40, 0.95)',
  backdropFilter: 'blur(12px)',
  borderRadius: 10,
  border: '1px solid rgba(255, 255, 255, 0.15)',
  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
  padding: 4,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  zIndex: 1000,
}

const popupItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 14px',
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  color: 'rgba(255, 255, 255, 0.8)',
  fontSize: 13,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
}
