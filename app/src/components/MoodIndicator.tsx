import { useState, useEffect, useRef, useCallback } from 'react'

interface MoodBubble {
  id: number
  delta: number
}

interface MoodIndicatorProps {
  language?: 'zh' | 'en'
}

const OPENCLAW_URL = 'http://127.0.0.1:18789'

const BAR_W = 160
const BAR_H = 28
const DPR = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1

// Wave parameters
const WAVE_LENGTH = 20  // one full wave cycle in px
const WAVE_HEIGHT = 3   // wave amplitude in px

// 5 tiers: 90+ pink, 70+ orange, 50+ green, 20+ blue, 0+ grey
function moodColor(percent: number): { primary: string; secondary: string; border: string } {
  let r: number, g: number, b: number
  if (percent >= 90)      { r = 255; g = 107; b = 157 }  // pink
  else if (percent >= 70)  { r = 255; g = 165; b = 70 }   // orange
  else if (percent >= 50)  { r = 72; g = 199; b = 142 }   // green
  else if (percent >= 30)  { r = 78; g = 168; b = 222 }   // blue
  else                     { r = 160; g = 168; b = 180 }   // grey
  return {
    primary: `rgb(${r},${g},${b})`,
    secondary: `rgba(${r},${g},${b},0.35)`,
    border: `rgba(${r},${g},${b},0.6)`,
  }
}

/** Draw a horizontal wave-filled rounded-rect progress bar onto a canvas */
function drawWaveBar(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  percent: number,
  phase: number,
  colors: { primary: string; secondary: string; border: string },
) {
  const radius = h / 2
  ctx.clearRect(0, 0, w, h)

  // -- Background rounded rect (clip region) --
  ctx.save()
  ctx.beginPath()
  roundRect(ctx, 0, 0, w, h, radius)
  ctx.clip()

  // Fill background
  ctx.fillStyle = 'rgba(233, 236, 239, 0.85)'
  ctx.fillRect(0, 0, w, h)

  // The fill edge x position
  const fillX = (percent / 100) * w

  // -- Second (lighter) wave layer --
  ctx.beginPath()
  const secondPhase = phase + Math.PI * 0.7  // offset from primary wave
  ctx.moveTo(0, h)
  ctx.lineTo(0, 0)
  // Wave edge goes top-to-bottom along x = fillX
  for (let y = 0; y <= h; y += 1) {
    const waveOffset = Math.sin((y / WAVE_LENGTH) * Math.PI * 2 + secondPhase) * WAVE_HEIGHT
    ctx.lineTo(fillX + waveOffset, y)
  }
  ctx.lineTo(0, h)
  ctx.closePath()
  ctx.fillStyle = colors.secondary
  ctx.fill()

  // -- Primary wave layer --
  ctx.beginPath()
  ctx.moveTo(0, h)
  ctx.lineTo(0, 0)
  for (let y = 0; y <= h; y += 1) {
    const waveOffset = Math.sin((y / WAVE_LENGTH) * Math.PI * 2 + phase) * WAVE_HEIGHT
    ctx.lineTo(fillX + waveOffset, y)
  }
  ctx.lineTo(0, h)
  ctx.closePath()
  ctx.fillStyle = colors.primary
  ctx.fill()

  ctx.restore()

  // -- Border --
  ctx.beginPath()
  roundRect(ctx, 0.5, 0.5, w - 1, h - 1, radius - 0.5)
  ctx.strokeStyle = colors.border
  ctx.lineWidth = 1.5
  ctx.stroke()
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

let bubbleIdCounter = 0

export function MoodIndicator({ language = 'zh' }: MoodIndicatorProps) {
  const t = (zh: string, en: string) => language === 'en' ? en : zh
  const [mood, setMood] = useState(60)
  const [bubbles, setBubbles] = useState<MoodBubble[]>([])
  const [visible, setVisible] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: window.innerWidth / 2, y: 6 })
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>(0)
  const phaseRef = useRef(0)
  const displayPercentRef = useRef(60) // smoothed percent for animation

  useEffect(() => {
    fetch(`${OPENCLAW_URL}/plugins/claw-sama/settings`)
      .then((r) => r.json())
      .then((s) => { if (s.moodIndex !== undefined) { setMood(s.moodIndex); displayPercentRef.current = s.moodIndex } })
      .catch(() => {})
  }, [])

  const showBriefly = useCallback(() => {
    setVisible(true)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => setVisible(false), 5000)
  }, [])

  useEffect(() => {
    const es = new EventSource(`${OPENCLAW_URL}/plugins/claw-sama/events`)
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.moodIndex !== undefined && data.moodDelta !== undefined) {
          setMood(data.moodIndex)
          showBriefly()
          const id = ++bubbleIdCounter
          setBubbles((prev) => [...prev, { id, delta: data.moodDelta }])
          setTimeout(() => setBubbles((prev) => prev.filter((b) => b.id !== id)), 2000)
        }
      } catch { /* ignore */ }
    }
    return () => es.close()
  }, [showBriefly])

  // Canvas wave animation loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    canvas.width = BAR_W * DPR
    canvas.height = BAR_H * DPR
    ctx.scale(DPR, DPR)

    let running = true
    const animate = () => {
      if (!running) return
      // Smoothly interpolate display percent toward target mood
      const target = Math.max(2, mood)
      const diff = target - displayPercentRef.current
      displayPercentRef.current += diff * 0.08

      // Advance wave phase
      phaseRef.current += 0.06

      const colors = moodColor(displayPercentRef.current)
      drawWaveBar(ctx, BAR_W, BAR_H, displayPercentRef.current, phaseRef.current, colors)
      animRef.current = requestAnimationFrame(animate)
    }
    animate()
    return () => { running = false; cancelAnimationFrame(animRef.current) }
  }, [mood])

  // Drag to reposition
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragging(true)
    setVisible(true)
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null }

    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const offsetX = e.clientX - rect.left - rect.width / 2
    const offsetY = e.clientY - rect.top

    const onMove = (ev: PointerEvent) => {
      setPos({ x: ev.clientX - offsetX, y: ev.clientY - offsetY })
    }

    const onUp = () => {
      setDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      hideTimerRef.current = setTimeout(() => setVisible(false), 3000)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  const handleMouseEnter = useCallback(() => {
    setVisible(true)
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null }
  }, [])

  const handleMouseLeave = useCallback(() => {
    if (!dragging) {
      hideTimerRef.current = setTimeout(() => setVisible(false), 2000)
    }
  }, [dragging])

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        top: pos.y,
        left: pos.x,
        transform: 'translateX(-50%)',
        zIndex: 250,
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        transition: 'opacity 0.5s ease',
        opacity: visible || bubbles.length > 0 ? 1 : 0.2,
        cursor: dragging ? 'grabbing' : 'grab',
        userSelect: 'none',
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onPointerDown={handlePointerDown}
      data-no-passthrough
    >
      {/* Floating bubbles */}
      <div style={{ position: 'relative', width: BAR_W + 40, height: 22, overflow: 'visible' }}>
        {bubbles.map((b) => (
          <span
            key={b.id}
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 0,
              fontSize: 13,
              fontWeight: 700,
              color: b.delta > 0 ? '#FF6B9D' : '#A0A8B4',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              animation: 'mood-bubble-float 1.8s ease-out forwards',
              fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
              textShadow: '0 1px 4px rgba(0,0,0,0.3)',
            }}
          >
            {t('心情', 'Mood')}{b.delta > 0 ? `+${b.delta}` : b.delta}
          </span>
        ))}
      </div>

      {/* Wave progress bar (canvas) */}
      <div style={{ position: 'relative', width: BAR_W, height: BAR_H }}>
        <canvas
          ref={canvasRef}
          width={BAR_W * DPR}
          height={BAR_H * DPR}
          style={{ width: BAR_W, height: BAR_H, display: 'block' }}
        />
        {/* Centered percentage text overlay */}
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          color: '#fff',
          fontWeight: 700,
          fontSize: 12,
          whiteSpace: 'nowrap',
          fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
          lineHeight: 1.4,
          letterSpacing: 0.3,
          pointerEvents: 'none',
          textShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
        }}>
          {t('心情', 'Mood')} {mood}%
        </div>
      </div>
    </div>
  )
}
