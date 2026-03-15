import { useEffect, useRef, useState, useCallback } from 'react'
import { VRMScene } from './components/VRMScene'
import type { VRMSceneHandle, TouchRegion } from './components/VRMScene'
import { TextBubble } from './components/TextBubble'
import type { OnVrmMessage } from './components/TextBubble'
import { ChatInput } from './components/ChatInput'
import { ResizeHandles } from './components/ResizeHandles'
import { SettingsPanel } from './components/SettingsPanel'
import { usePassThrough } from './hooks/usePassThrough'
import { LipSync } from './lip-sync'
import { bindScene } from './api'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { HistoryPanel } from './components/HistoryPanel'
import { Menu, Pin, Move, RotateCcw, Rotate3D, EyeOff, Settings } from 'lucide-react'

const DEFAULT_MODEL = '/model1.vrm'
const OPENCLAW_URL = 'http://127.0.0.1:18789'

// Module-level to survive any component remount
let lastTouchChatTime = 0
const TOUCH_CHAT_COOLDOWN = 30_000

// 情绪 → 动作映射
const emotionActionMap: Record<string, string> = {
  think: 'scratchHead',
  question: 'scratchHead',
  curious: 'scratchHead',
  happy: 'stretch',
  surprised: 'stretch',
  angry: 'akimbo',
  awkward: 'playFingers',
  sad: 'playFingers',
}


const btnStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  border: 'none',
  borderRadius: 6,
  background: 'rgba(125, 125, 125, 0.28)',
  backdropFilter: 'blur(6px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'rgba(255, 255, 255, 0.8)',
  fontSize: 16,
  cursor: 'pointer',
}

export default function App() {
  const sceneRef = useRef<VRMSceneHandle>(null)
  const [pinned, setPinned] = useState(true)
  const [tracking, setTracking] = useState<'mouse' | 'camera'>('mouse')
  const [showText, setShowText] = useState(true)
  const [collapsed, setCollapsed] = useState(false)

  const [ttsEnabled, setTtsEnabled] = useState(true)
  const [modelPath, setModelPath] = useState(DEFAULT_MODEL)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [hideUI, setHideUI] = useState(false)
  const [volume, setVolume] = useState(1)
  const [uiAlign, setUiAlign] = useState<'left' | 'right'>('right')
  const [screenObserve, setScreenObserve] = useState(false)
  const [screenObserveInterval, setScreenObserveInterval] = useState(60)
  usePassThrough(!settingsOpen && !historyOpen)

  // Load persisted settings on mount
  useEffect(() => {
    fetch(`${OPENCLAW_URL}/plugins/claw-sama/settings`)
      .then((r) => r.json())
      .then((s) => {
        if (s.modelPath) setModelPath(s.modelPath)
        if (s.ttsEnabled !== undefined) setTtsEnabled(s.ttsEnabled)
        if (s.showText !== undefined) setShowText(s.showText)
        if (s.hideUI !== undefined) setHideUI(s.hideUI)
        if (s.tracking) { setTracking(s.tracking); sceneRef.current?.setTrackingMode(s.tracking) }
        if (s.volume !== undefined) { setVolume(s.volume); LipSync.getInstance().setVolume(s.volume) }
        if (s.uiAlign) setUiAlign(s.uiAlign)
        if (s.screenObserve !== undefined) setScreenObserve(s.screenObserve)
        if (s.screenObserveInterval !== undefined) setScreenObserveInterval(s.screenObserveInterval)
      })
      .catch(() => {})
  }, [])

  const saveSettings = (patch: Record<string, unknown>) => {
    fetch(`${OPENCLAW_URL}/plugins/claw-sama/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => {})
  }

  useEffect(() => {
    const unlisten = listen('open-settings', () => setSettingsOpen(true))
    return () => { unlisten.then((f) => f()) }
  }, [])

  useEffect(() => {
    bindScene(sceneRef.current)
    return () => bindScene(null)
  })

  const handleVolumeChange = useCallback((v: number) => {
    setVolume(v)
    LipSync.getInstance().setVolume(v)
    saveSettings({ volume: v })
  }, [])

  const handleTrackingChange = useCallback((mode: 'mouse' | 'camera') => {
    sceneRef.current?.setTrackingMode(mode)
    setTracking(mode)
    saveSettings({ tracking: mode })
  }, [])

  const handleVrmMessage: OnVrmMessage = useCallback((msg) => {
    if (msg.emotion && sceneRef.current) {
      const action = emotionActionMap[msg.emotion]
      if (msg.text) {
        // 回复消息：表情和动作同时触发（文字出现1s后由TextBubble延迟调用）
        sceneRef.current.setEmotionWithReset(msg.emotion, msg.emotionDuration ?? 5000, msg.emotionIntensity)
        if (action) sceneRef.current.playAction(action)
      } else {
        // 思考阶段：hold 动作，10s 后自动 reset
        sceneRef.current.setEmotionWithReset(msg.emotion, msg.emotionDuration ?? 10000, msg.emotionIntensity)
        if (action) sceneRef.current.playAction(action, true)
      }
    }
  }, [])

  // ── Idle fidget: random emotion + action every ~60s when idle ──────────────
  const lastActivityRef = useRef(Date.now())
  // Reset idle timer whenever a VRM message arrives
  const originalHandleVrmMessage = handleVrmMessage
  const handleVrmMessageWithActivity: OnVrmMessage = useCallback((msg) => {
    lastActivityRef.current = Date.now()
    originalHandleVrmMessage(msg)
  }, [originalHandleVrmMessage])

  useEffect(() => {
    const fidgetEmotions = ['happy', 'curious', 'awkward', 'surprised', 'think'] as const
    const IDLE_THRESHOLD_MS = 60_000
    const FIDGET_CHECK_MS = 15_000 // check every 15s, randomness inside

    const timer = setInterval(() => {
      const idleMs = Date.now() - lastActivityRef.current
      if (idleMs < IDLE_THRESHOLD_MS) return
      // 50% chance each check to avoid being too predictable
      if (Math.random() > 0.5) return

      const emotion = fidgetEmotions[Math.floor(Math.random() * fidgetEmotions.length)]
      const action = emotionActionMap[emotion]
      const intensity = 0.4 + Math.random() * 0.4 // 0.4–0.8
      sceneRef.current?.setEmotionWithReset(emotion, 3000 + Math.random() * 2000, intensity)
      if (action) sceneRef.current?.playAction(action)
      lastActivityRef.current = Date.now() // reset so we don't spam
    }, FIDGET_CHECK_MS)

    return () => clearInterval(timer)
  }, [])

  // ── Screen observation: capture desktop & send to LLM periodically ─────────
  useEffect(() => {
    if (!screenObserve) return
    const intervalMs = screenObserveInterval * 1000

    const doObserve = () => {
      fetch(`${OPENCLAW_URL}/plugins/claw-sama/screen/observe`, { method: 'POST' })
        .catch(() => {})
    }

    const timer = setInterval(doObserve, intervalMs)
    // Also fire once immediately on enable
    doObserve()

    return () => clearInterval(timer)
  }, [screenObserve, screenObserveInterval])

  const clearContext = async () => {
    try {
      await fetch(`${OPENCLAW_URL}/plugins/claw-sama/context/clear`, { method: 'POST' })
    } catch { /* ignore */ }
  }

  // 全局快捷键: Tab 展开/折叠菜单
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'Tab') {
        e.preventDefault()
        setCollapsed((v) => !v)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // ── Touch interaction: immediate reaction + verbal response ──────────
  const touchVisuals: Record<TouchRegion, { emotion: string; action?: string }> = {
    head:  { emotion: 'happy',     action: 'stretch' },
    body:  { emotion: 'surprised', action: 'playFingers' },
    hand:  { emotion: 'happy',     action: 'playFingers' },
    leg:   { emotion: 'awkward',   action: 'playFingers' },
  }

  // Track touch counts per region within the cooldown window
  const touchCountsRef = useRef<Record<string, number>>({})

  const regionLabels: Record<TouchRegion, string> = {
    head: '头', body: '身体', hand: '手', leg: '腿',
  }

  const handleTouch = useCallback((region: TouchRegion) => {
    const visual = touchVisuals[region]
    if (!visual) return

    // Immediate visual feedback (always)
    lastActivityRef.current = Date.now()
    sceneRef.current?.setEmotionWithReset(visual.emotion, 3000, 0.8)
    if (visual.action) sceneRef.current?.playAction(visual.action)

    // Accumulate touch counts
    touchCountsRef.current[region] = (touchCountsRef.current[region] || 0) + 1

    // Send to backend for verbal response (rate-limited, module-level cooldown)
    const now = Date.now()
    if (now - lastTouchChatTime > TOUCH_CHAT_COOLDOWN) {
      lastTouchChatTime = now

      // Build summary prompt from accumulated counts
      const parts = Object.entries(touchCountsRef.current)
        .filter(([, count]) => count > 0)
        .map(([r, count]) => `${regionLabels[r as TouchRegion]}${count}次`)
      const summary = parts.join('、')
      const prompt = `[用户摸了你的${summary}]`
      touchCountsRef.current = {}

      fetch(`${OPENCLAW_URL}/plugins/claw-sama/touch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region, prompt }),
      }).catch(() => {})
    }
  }, [])

  const togglePin = async () => {
    const win = getCurrentWindow()
    const next = !pinned
    await win.setAlwaysOnTop(next)
    setPinned(next)
  }

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background: 'transparent',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <ResizeHandles />
      <VRMScene ref={sceneRef} modelPath={modelPath} onTouch={handleTouch} />
      <TextBubble onMessage={handleVrmMessageWithActivity} enabled={showText} ttsEnabled={ttsEnabled} />
      {!hideUI && <ChatInput uiAlign={uiAlign} onHistoryOpen={() => setHistoryOpen(true)} onNewSession={clearContext} />}
      <HistoryPanel
        visible={historyOpen}
        onClose={() => setHistoryOpen(false)}
      />
      <SettingsPanel
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        currentModel={modelPath}
        onModelChange={(m) => { setModelPath(m); saveSettings({ modelPath: m }) }}
        hideUI={hideUI}
        onHideUIChange={(v) => { setHideUI(v); saveSettings({ hideUI: v }) }}
        showText={showText}
        onShowTextChange={(v) => { setShowText(v); saveSettings({ showText: v }) }}
        ttsEnabled={ttsEnabled}
        onTtsEnabledChange={(v) => { setTtsEnabled(v); saveSettings({ ttsEnabled: v }) }}
        tracking={tracking}
        onTrackingChange={handleTrackingChange}
        volume={volume}
        onVolumeChange={handleVolumeChange}
        uiAlign={uiAlign}
        onUiAlignChange={(v) => { setUiAlign(v); saveSettings({ uiAlign: v }) }}
        screenObserve={screenObserve}
        onScreenObserveChange={(v) => { setScreenObserve(v); saveSettings({ screenObserve: v }) }}
        screenObserveInterval={screenObserveInterval}
        onScreenObserveIntervalChange={(v) => { setScreenObserveInterval(v); saveSettings({ screenObserveInterval: v }) }}
        captureVrmScreenshot={() => sceneRef.current?.captureScreenshot() ?? null}
      />
      {!hideUI && <div
        style={{
          position: 'absolute',
          top: 8,
          ...(uiAlign === 'left' ? { left: 8 } : { right: 8 }),
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <button
          onClick={() => setCollapsed((v) => !v)}
          style={btnStyle}
          title={collapsed ? '展开菜单 (Tab)' : '折叠菜单 (Tab)'}
        >
          <Menu size={16} />
        </button>
        {!collapsed && <>
          <button
            onClick={() => setSettingsOpen(true)}
            style={btnStyle}
            title="设置"
          >
            <Settings size={16} />
          </button>
          <button
            onClick={() => getCurrentWindow().hide()}
            style={btnStyle}
            title="隐藏窗口"
          >
            <EyeOff size={16} />
          </button>
          <button
            onClick={togglePin}
            style={{ ...btnStyle, opacity: pinned ? 1 : 0.5 }}
            title={pinned ? '取消置顶' : '置顶窗口'}
          >
            <Pin size={16} />
          </button>
          <button
            onMouseDown={(e) => {
              e.preventDefault()
              ;(window as any).__clawDragging = true
              let lastX = e.clientX
              let lastY = e.clientY
              const onMove = (ev: MouseEvent) => {
                sceneRef.current?.panCamera(ev.clientX - lastX, ev.clientY - lastY)
                lastX = ev.clientX
                lastY = ev.clientY
              }
              const onUp = () => {
                ;(window as any).__clawDragging = false
                window.removeEventListener('mousemove', onMove)
                window.removeEventListener('mouseup', onUp)
              }
              window.addEventListener('mousemove', onMove)
              window.addEventListener('mouseup', onUp)
            }}
            style={{ ...btnStyle, cursor: 'grab' }}
            title="拖动移动人物位置"
          >
            <Move size={16} />
          </button>
          <button
            onMouseDown={(e) => {
              e.preventDefault()
              ;(window as any).__clawDragging = true
              let lastX = e.clientX
              let lastY = e.clientY
              const onMove = (ev: MouseEvent) => {
                sceneRef.current?.rotateCamera(ev.clientX - lastX, ev.clientY - lastY)
                lastX = ev.clientX
                lastY = ev.clientY
              }
              const onUp = () => {
                ;(window as any).__clawDragging = false
                window.removeEventListener('mousemove', onMove)
                window.removeEventListener('mouseup', onUp)
              }
              window.addEventListener('mousemove', onMove)
              window.addEventListener('mouseup', onUp)
            }}
            style={{ ...btnStyle, cursor: 'grab' }}
            title="拖动旋转视角"
          >
            <Rotate3D size={16} />
          </button>
          <button
            onClick={() => sceneRef.current?.resetCamera()}
            style={btnStyle}
            title="重置视角"
          >
            <RotateCcw size={16} />
          </button>
        </>}
      </div>}
    </div>
  )
}
