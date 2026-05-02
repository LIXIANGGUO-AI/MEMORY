import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import './Gallery.css'

export type GalleryItem = {
  id: string
  layoutId: string
  imageSrc?: string
  textBody?: string | null
  caption: string
  filter: 'none' | 'budapest' | 'grain' | 'fade'
  displayMode?: 'classic' | 'original'
  aspectRatio?: number
}

const LAYOUT_SPRING = { type: 'spring' as const, stiffness: 200, damping: 15 }

type GalleryProps = {
  items: GalleryItem[]
  initialIndex: number
  openLayoutId: string
  cityName: string
  emojis: string
  captionById?: Record<string, string>
  onCaptionChange?: (itemId: string, value: string) => void
  onClose: () => void
}

export function Gallery({
  items,
  initialIndex,
  openLayoutId,
  cityName,
  emojis: _emojis,
  captionById,
  onCaptionChange,
  onClose,
}: GalleryProps) {
  const [idx, setIdx] = useState(initialIndex)
  const [bridge, setBridge] = useState(true)
  const [dir, setDir] = useState(1)
  const hasNavigated = useRef(false)
  const swipeStartXRef = useRef<number | null>(null)
  const swipeActiveRef = useRef(false)

  const item = items[idx]!
  const editableText = captionById?.[item.id] ?? item.caption ?? ''
  const prevItem = items[(idx - 1 + items.length) % items.length]!
  const nextItem = items[(idx + 1) % items.length]!

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goPrev()
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        goNext()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const goPrev = useCallback(() => {
    if (bridge) return
    hasNavigated.current = true
    setDir(-1)
    setIdx((i) => (i <= 0 ? items.length - 1 : i - 1))
  }, [bridge, items.length])

  const goNext = useCallback(() => {
    if (bridge) return
    hasNavigated.current = true
    setDir(1)
    setIdx((i) => (i >= items.length - 1 ? 0 : i + 1))
  }, [bridge, items.length])

  const onStagePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    swipeStartXRef.current = e.clientX
    swipeActiveRef.current = true
  }, [])

  const onStagePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!swipeActiveRef.current || swipeStartXRef.current === null) return
      const deltaX = e.clientX - swipeStartXRef.current
      swipeActiveRef.current = false
      swipeStartXRef.current = null
      if (Math.abs(deltaX) < 40) return
      if (deltaX > 0) goPrev()
      else goNext()
    },
    [goNext, goPrev],
  )

  useEffect(() => {
    const t = window.setTimeout(() => setBridge(false), 1800)
    return () => window.clearTimeout(t)
  }, [])

  return (
    <motion.div
      className="gallery-root"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
    >
      <div className="gallery-bg" aria-hidden />

      <button type="button" className="gallery-close" onClick={onClose} aria-label="关闭画廊">
        <span aria-hidden>×</span>
      </button>

      <div
        className="gallery-main"
        onPointerDown={onStagePointerDown}
        onPointerUp={onStagePointerUp}
        onPointerCancel={onStagePointerUp}
      >
        <button type="button" className="vision-side-nav vision-side-nav--left" onClick={goPrev} disabled={bridge} aria-label="Previous photo">
          ‹
        </button>
        <button type="button" className="vision-side-nav vision-side-nav--right" onClick={goNext} disabled={bridge} aria-label="Next photo">
          ›
        </button>

        <div className="vision-stage">
          <button type="button" className="vision-panel vision-panel--side vision-panel--left" onClick={goPrev} disabled={bridge}>
            <GalleryPanel item={prevItem} />
          </button>

          <div className="vision-panel vision-panel--center">
          {bridge ? (
            <motion.div
              layoutId={openLayoutId}
              transition={{ layout: LAYOUT_SPRING }}
              onLayoutAnimationComplete={() => setBridge(false)}
                className="vision-center-card"
            >
                <GalleryPanel item={item} center />
            </motion.div>
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={item.id}
                  className="vision-center-card"
                  initial={hasNavigated.current ? { x: dir > 0 ? 80 : -80, opacity: 0 } : false}
                animate={{ x: 0, opacity: 1 }}
                  exit={{ x: dir > 0 ? -80 : 80, opacity: 0 }}
                transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              >
                  <GalleryPanel item={item} center />
              </motion.div>
            </AnimatePresence>
          )}
          </div>

          <button type="button" className="vision-panel vision-panel--side vision-panel--right" onClick={goNext} disabled={bridge}>
            <GalleryPanel item={nextItem} />
          </button>
        </div>

        <div className="vision-caption-bar" aria-live="polite">
          <div className="vision-caption-title">{cityName}</div>
          <textarea
            className="vision-caption-editor"
            value={editableText}
            onChange={(e) => {
              const value = e.target.value
              onCaptionChange?.(item.id, value)
            }}
            placeholder="在这里编辑描述..."
          />
          <div className="vision-dots" aria-hidden>
            {items.map((it, i) => (
              <span key={it.id} className={`vision-dot ${i === idx ? 'vision-dot--active' : ''}`} />
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  )
}

function GalleryPanel({ item, center = false }: { item: GalleryItem; center?: boolean }) {
  const isOriginal = item.displayMode === 'original'
  const [glowRgb, setGlowRgb] = useState('138, 162, 204')

  const deriveGlowColorFromImage = useCallback((img: HTMLImageElement) => {
    try {
      const w = img.naturalWidth || img.width
      const h = img.naturalHeight || img.height
      if (!w || !h) return
      const sampleW = 20
      const sampleH = 20
      const canvas = document.createElement('canvas')
      canvas.width = sampleW
      canvas.height = sampleH
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      ctx.drawImage(img, 0, 0, sampleW, sampleH)
      const { data } = ctx.getImageData(0, 0, sampleW, sampleH)
      let rSum = 0
      let gSum = 0
      let bSum = 0
      let count = 0
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3] ?? 0
        if (a < 120) continue
        const r = data[i] ?? 0
        const g = data[i + 1] ?? 0
        const b = data[i + 2] ?? 0
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
        if (luma < 10 || luma > 245) continue
        rSum += r
        gSum += g
        bSum += b
        count += 1
      }
      if (!count) return
      const r = Math.round(rSum / count)
      const g = Math.round(gSum / count)
      const b = Math.round(bSum / count)
      setGlowRgb(`${r}, ${g}, ${b}`)
    } catch {
      // Keep previous glow color when canvas read is blocked.
    }
  }, [])

  const onOriginalMainImageLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      deriveGlowColorFromImage(e.currentTarget)
    },
    [deriveGlowColorFromImage],
  )

  const panelStyle =
    center && isOriginal
      ? ({
          ['--vision-glow-rgb' as string]: glowRgb,
        } as CSSProperties)
      : undefined

  return (
    <div className={`vision-card ${center ? 'vision-card--center' : ''} ${isOriginal ? 'vision-card--original' : ''}`} style={panelStyle}>
      {item.textBody ? (
        <div className="vision-text">{item.textBody}</div>
      ) : item.imageSrc ? (
        isOriginal && center ? (
          <>
            <img
              src={item.imageSrc}
              alt=""
              draggable={false}
              loading="eager"
              decoding="async"
              className="vision-card-img--original-bg"
            />
            <img
              src={item.imageSrc}
              alt=""
              draggable={false}
              loading="eager"
              decoding="async"
              className="vision-card-img--original-main"
              onLoad={onOriginalMainImageLoad}
            />
          </>
        ) : (
          <img
            src={item.imageSrc}
            alt=""
            draggable={false}
            loading="eager"
            decoding="async"
            className={isOriginal ? 'vision-card-img--original-side' : ''}
          />
        )
      ) : (
        <div className="vision-text">No preview</div>
      )}
    </div>
  )
}
