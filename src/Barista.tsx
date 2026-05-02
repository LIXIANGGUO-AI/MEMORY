import { AnimatePresence, motion } from 'framer-motion'
import { Howl } from 'howler'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import './Barista.css'

type FloatingCard = {
  slotId: string
  photoId: string
  url: string
  x: number
  y: number
  baseRotate: number
  floatDuration: number
  floatDelay: number
  scale: number
  depth: number
  opacity: number
}

const LOFI_URL =
  'https://cdn.pixabay.com/download/audio/2023/11/06/audio_67d9fdf310.mp3?filename=night-lofi-183931.mp3'

const PHOTO_SEEDS = [
  'kyoto-a',
  'kyoto-b',
  'kyoto-c',
  'kyoto-d',
  'kyoto-e',
  'ice-a',
  'ice-b',
  'ice-c',
  'ice-d',
  'paris-a',
  'paris-b',
  'paris-c',
  'paris-d',
  'paris-e',
  'ny-a',
  'ny-b',
  'ny-c',
  'ny-d',
  'def-a',
  'def-b',
  'def-c',
] as const

const PHOTO_POOL = PHOTO_SEEDS.map((seed) => ({
  id: seed,
  url: `https://picsum.photos/seed/${encodeURIComponent(seed)}/520/520`,
}))

const MAX_VISIBLE = 7
const SLOT_ANCHORS = [
  { x: 0.12, y: 0.18 },
  { x: 0.82, y: 0.2 },
  { x: 0.2, y: 0.72 },
  { x: 0.84, y: 0.7 },
  { x: 0.5, y: 0.12 },
  { x: 0.08, y: 0.48 },
  { x: 0.9, y: 0.48 },
] as const

function rand(min: number, max: number) {
  return min + Math.random() * (max - min)
}

function pickUnique(pool: readonly { id: string }[], n: number) {
  const copy = [...pool]
  const out: string[] = []
  while (copy.length > 0 && out.length < n) {
    const i = Math.floor(Math.random() * copy.length)
    out.push(copy[i]!.id)
    copy.splice(i, 1)
  }
  return out
}

function buildCard(photoId: string, slotId: string, slotIndex: number, viewport: { w: number; h: number }): FloatingCard {
  const depth = Math.round(rand(1, 8))
  const p = PHOTO_POOL.find((x) => x.id === photoId) ?? PHOTO_POOL[0]!
  const anchor = SLOT_ANCHORS[slotIndex % SLOT_ANCHORS.length]!
  const cx = viewport.w * 0.5
  const cy = viewport.h * 0.56
  let x = anchor.x * viewport.w + rand(-70, 70)
  let y = anchor.y * viewport.h + rand(-54, 54)

  let guard = 0
  while (guard < 20) {
    const dx = x - cx
    const dy = y - cy
    if (Math.hypot(dx, dy) > 200) break
    x = anchor.x * viewport.w + rand(-110, 110)
    y = anchor.y * viewport.h + rand(-90, 90)
    guard += 1
  }

  x = Math.max(16, Math.min(viewport.w - 142, x))
  y = Math.max(20, Math.min(viewport.h - 180, y))

  const scale = rand(0.75, 1.1)
  const depthOpacity = 0.9 - depth * 0.05
  const opacity = Math.max(0.55, Math.min(0.85, rand(0.55, 0.85) * depthOpacity))

  return {
    slotId,
    photoId,
    url: p.url,
    x,
    y,
    baseRotate: rand(-15, 15),
    floatDuration: rand(6, 10),
    floatDelay: -rand(0, 8),
    scale,
    depth,
    opacity,
  }
}

export function Barista() {
  const navigate = useNavigate()
  const [closing, setClosing] = useState(false)
  const [volume, setVolume] = useState(0.6)
  const [playing, setPlaying] = useState(false)
  const [showControl, setShowControl] = useState(false)
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }))
  const soundRef = useRef<Howl | null>(null)
  const replaceTimerRef = useRef<number | null>(null)

  const [cards, setCards] = useState<FloatingCard[]>(() => {
    const selected = pickUnique(PHOTO_POOL, MAX_VISIBLE)
    return selected.map((id, i) =>
      buildCard(id, `slot-${i}`, i, { w: window.innerWidth, h: window.innerHeight }),
    )
  })

  const triggerClose = useCallback(() => {
    if (closing) return
    setClosing(true)
  }, [closing])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') triggerClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [triggerClose])

  useEffect(() => {
    const onResize = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const threshold = window.innerHeight - 80
      setShowControl(e.clientY >= threshold)
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  useEffect(() => {
    const sound = new Howl({
      src: [LOFI_URL],
      html5: true,
      loop: true,
      volume: 0,
    })
    soundRef.current = sound

    const startTimer = window.setTimeout(() => {
      sound.play()
      sound.fade(0, volume, 3000)
      setPlaying(true)
    }, 2000)

    return () => {
      window.clearTimeout(startTimer)
      sound.stop()
      sound.unload()
      soundRef.current = null
    }
  }, [volume])

  useEffect(() => {
    if (!soundRef.current) return
    soundRef.current.volume(volume)
  }, [volume])

  const togglePlay = useCallback(() => {
    const s = soundRef.current
    if (!s) return
    if (s.playing()) {
      s.pause()
      setPlaying(false)
    } else {
      s.play()
      setPlaying(true)
    }
  }, [])

  useEffect(() => {
    replaceTimerRef.current = window.setInterval(() => {
      setCards((prev) => {
        if (prev.length === 0) return prev
        const next = [...prev]
        const idx = Math.floor(Math.random() * next.length)
        const slot = next[idx]!
        const currentlyUsed = new Set(next.map((c) => c.photoId))
        const candidatePool = PHOTO_POOL.filter((p) => !currentlyUsed.has(p.id))
        const candidate =
          candidatePool[Math.floor(Math.random() * candidatePool.length)] ??
          PHOTO_POOL[Math.floor(Math.random() * PHOTO_POOL.length)]!
        next[idx] = buildCard(candidate.id, slot.slotId, idx, viewport)
        return next
      })
    }, 6000)

    return () => {
      if (replaceTimerRef.current) window.clearInterval(replaceTimerRef.current)
    }
  }, [viewport])

  return (
    <motion.main
      className="barista-root"
      initial={{ opacity: 0, scale: 1.08 }}
      animate={closing ? { opacity: 0, scale: 0.08 } : { opacity: 1, scale: 1 }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      onAnimationComplete={() => {
        if (closing) navigate('/')
      }}
    >
      <div className="barista-bg-glow" aria-hidden />

      <button type="button" className="close-btn" aria-label="Close barista mode" onClick={triggerClose}>
        ×
      </button>

      <section className="barista-cup-area" aria-hidden>
        <svg className="barista-cup" width="160" height="180" viewBox="0 0 160 180" fill="none">
          <ellipse
            cx="80"
            cy="158"
            rx="55"
            ry="8"
            fill="none"
            stroke="rgba(210,160,80,0.5)"
            strokeWidth="1.5"
          />
          <path
            d="M 35 70 Q 30 140 45 150 L 115 150 Q 130 140 125 70 Z"
            fill="none"
            stroke="rgba(210,160,80,0.7)"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <ellipse
            cx="80"
            cy="70"
            rx="45"
            ry="10"
            fill="rgba(180,100,30,0.15)"
            stroke="rgba(210,160,80,0.7)"
            strokeWidth="1.5"
          />
          <clipPath id="cupClip">
            <path d="M 36 71 Q 31 140 46 149 L 114 149 Q 129 140 124 71 Z" />
          </clipPath>
          <rect
            className="barista-cup-fill"
            x="35"
            y="0"
            width="90"
            height="150"
            fill="url(#coffeeGrad)"
            clipPath="url(#cupClip)"
          />
          <defs>
            <linearGradient id="coffeeGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6B3520" stopOpacity="0.9" />
              <stop offset="100%" stopColor="#3D1A00" stopOpacity="0.95" />
            </linearGradient>
          </defs>
          <path
            d="M 124 90 Q 148 90 148 115 Q 148 140 124 135"
            fill="none"
            stroke="rgba(210,160,80,0.7)"
            strokeWidth="1.5"
          />
          <path
            className="barista-steam-line barista-steam-line--a"
            d="M 65 55 Q 60 45 65 35 Q 70 25 65 15"
            fill="none"
            stroke="rgba(255,255,255,0.25)"
            strokeWidth="1.2"
          />
          <path
            className="barista-steam-line barista-steam-line--b"
            d="M 80 50 Q 75 40 80 30 Q 85 20 80 10"
            fill="none"
            stroke="rgba(255,255,255,0.2)"
            strokeWidth="1.2"
          />
          <path
            className="barista-steam-line barista-steam-line--c"
            d="M 95 55 Q 90 45 95 35 Q 100 25 95 15"
            fill="none"
            stroke="rgba(255,255,255,0.25)"
            strokeWidth="1.2"
          />
        </svg>
      </section>
      <div className="barista-grain" aria-hidden />

      <section className="barista-float-layer">
        <AnimatePresence initial={false}>
          {cards.map((card) => (
            <motion.article
              key={`${card.slotId}-${card.photoId}`}
              className="barista-photo"
              initial={{ opacity: 0 }}
              animate={{ opacity: card.opacity }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.5 }}
              style={
                {
                  left: `${card.x}px`,
                  top: `${card.y}px`,
                  zIndex: card.depth,
                  '--base-rotate': `${card.baseRotate}deg`,
                  '--float-duration': `${card.floatDuration}s`,
                  '--float-delay': `${card.floatDelay}s`,
                  '--photo-scale': card.scale,
                } as CSSProperties
              }
            >
              <img src={card.url} alt="" draggable={false} loading="lazy" />
            </motion.article>
          ))}
        </AnimatePresence>
      </section>

      <motion.section
        className="barista-control"
        initial={false}
        animate={{ y: showControl ? 0 : 80, opacity: showControl ? 1 : 0 }}
        transition={{ duration: 0.28 }}
      >
        <button type="button" className="barista-control-btn" onClick={togglePlay}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <input
          className="barista-volume"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
        />
        <span className="barista-track-title">正在播放：旅途氛围曲</span>
      </motion.section>

      <div className="barista-footer">LUMINARY ATLAS · 旅途的温度</div>
    </motion.main>
  )
}

