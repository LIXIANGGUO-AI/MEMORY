import { AnimatePresence, LayoutGroup, motion, useMotionValue } from 'framer-motion'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'
import { flushSync } from 'react-dom'
import { useNavigate, useParams } from 'react-router-dom'
import { getCityById } from './data/cityStore'
import {
  deletePhotoFromCloud,
  insertImagePhoto,
  insertTextPhoto,
  listCaptionsForCity,
  listPhotosForCity,
  mergeLocalCaptionsToCloud,
  parseUserPhotoUuid,
  persistGalleryCaption,
  updatePhotoPosition,
  type CloudPolaroid,
} from './data/photoStore'
import { DEFAULT_CITY_EMOJI, titleFromId, type CityTheme } from './data/cities'
import { supabaseEnabled } from './lib/supabase'
import { Gallery, type GalleryItem } from './Gallery'
import './Album.css'

type AlbumTheme = CityTheme
type FilterKey = 'none' | 'budapest' | 'grain' | 'fade'
type UploadFlow = 'closed' | 'menu' | 'filters' | 'writing'
type PhotoDisplayMode = 'classic' | 'original'

type AlbumMeta = {
  theme: AlbumTheme
  coverTitle: string
  emoji: string
  photoCount: number
}

function metaForCityId(cityId: string | undefined): AlbumMeta {
  if (!cityId) {
    return {
      theme: 'default',
      coverTitle: 'Album',
      emoji: DEFAULT_CITY_EMOJI,
      photoCount: 0,
    }
  }
  const city = getCityById(cityId)
  if (city) {
    return {
      theme: city.theme ?? 'default',
      coverTitle: city.coverTitle,
      emoji: city.emoji || DEFAULT_CITY_EMOJI,
      photoCount: city.photoCount || 12,
    }
  }
  return {
    theme: 'default',
    coverTitle: titleFromId(cityId),
    emoji: DEFAULT_CITY_EMOJI,
    photoCount: 12,
  }
}

const TAPE_COLORS = [
  '#c4a574',
  '#9b6b5c',
  '#7d9b8c',
  '#8b7ba8',
  '#b89a6a',
  '#7a8b9c',
  '#a67c52',
  '#6b8c7a',
] as const

const POLAROID_PAD_X = 18
const POLAROID_PAD_TOP = 20
const POLAROID_PHOTO_GAP = 10
const POLAROID_CAPTION_H = 40
const POLAROID_PAD_BOTTOM = 20
const MIN_ORIGINAL_RATIO = 0.45

export type PolaroidMetrics = {
  polaroidW: number
  polaroidInner: number
  classicFrameH: number
}

/** Desktop 272px wide；≤430px 视口缩小拍立得，避免撑出屏幕 */
export function computePolaroidMetrics(viewportWidth: number): PolaroidMetrics {
  const polaroidW =
    viewportWidth > 0 && viewportWidth <= 430
      ? Math.max(200, Math.min(268, Math.round(viewportWidth * 0.82)))
      : 272
  const polaroidInner = polaroidW - 2 * POLAROID_PAD_X
  const classicFrameH =
    POLAROID_PAD_TOP + polaroidInner + POLAROID_PHOTO_GAP + POLAROID_CAPTION_H + POLAROID_PAD_BOTTOM
  return { polaroidW, polaroidInner, classicFrameH }
}
const MAX_ORIGINAL_RATIO = 2.4

const LAYOUT_SPRING = { type: 'spring' as const, stiffness: 200, damping: 15 }

const FILTERS: {
  key: FilterKey
  name: string
  style?: CSSProperties
  className?: string
}[] = [
  { key: 'none', name: '原片' },
  {
    key: 'budapest',
    name: '布达佩斯粉',
    style: {
      filter: 'sepia(0.3) saturate(0.8) hue-rotate(-10deg) brightness(1.05)',
    },
  },
  {
    key: 'grain',
    name: '春光颗粒',
    className: 'album-filter-grain-wrap',
    style: {
      filter: 'contrast(1.2) saturate(1.1) brightness(0.95)',
    },
  },
  {
    key: 'fade',
    name: '褪色记忆',
    style: {
      filter: 'saturate(0.4) brightness(1.1) sepia(0.25) hue-rotate(190deg)',
    },
  },
]

function randBetween(min: number, max: number) {
  return min + Math.random() * (max - min)
}

function pickTapeColor() {
  return TAPE_COLORS[Math.floor(Math.random() * TAPE_COLORS.length)]!
}

type TapeSlot = { top: string; left: string; rot: number }

const TAPE_SLOTS: TapeSlot[] = [
  { top: '-6px', left: '4%', rot: -16 },
  { top: '-5px', left: '52%', rot: 19 },
  { top: '-4px', left: '28%', rot: -8 },
  { top: '22%', left: '-10px', rot: -86 },
  { top: '38%', left: '-8px', rot: -92 },
  { top: '12%', left: '88%', rot: 88 },
  { top: '48%', left: '92%', rot: 84 },
  { top: '72%', left: '6%', rot: -12 },
]

function pickTwoDistinctSlots(): [TapeSlot, TapeSlot] {
  const a = Math.floor(Math.random() * TAPE_SLOTS.length)
  let b = Math.floor(Math.random() * TAPE_SLOTS.length)
  let guard = 0
  while (b === a && guard++ < 20) {
    b = Math.floor(Math.random() * TAPE_SLOTS.length)
  }
  return [TAPE_SLOTS[a]!, TAPE_SLOTS[b]!]
}

type TapeFields = {
  tapeCount: 1 | 2
  tapeW: number
  tapeH: number
  tape1: { slot: TapeSlot; color: string }
  tape2?: { slot: TapeSlot; color: string }
}

type UserPolaroid = {
  id: string
  layoutId: string
  kind: 'image' | 'text'
  src?: string
  textBody?: string
  caption: string
  filter: FilterKey
  displayMode: PhotoDisplayMode
  aspectRatio: number
  x: number
  y: number
  baseRotate: number
} & TapeFields

function cloudPolaroidToUser(c: CloudPolaroid): UserPolaroid {
  const raw = c.tape
  const tapeOk = raw && typeof raw === 'object' && 'tapeCount' in raw && 'tape1' in raw
  const tape: TapeFields = tapeOk ? (raw as TapeFields) : buildTapeFields()
  if (c.kind === 'image') {
    return {
      id: c.clientId,
      layoutId: c.layoutId,
      kind: 'image',
      src: c.imageUrl,
      caption: c.caption,
      filter: c.filter as FilterKey,
      displayMode: c.displayMode as PhotoDisplayMode,
      aspectRatio: c.aspectRatio,
      x: c.x,
      y: c.y,
      baseRotate: c.baseRotate,
      ...tape,
    }
  }
  return {
    id: c.clientId,
    layoutId: c.layoutId,
    kind: 'text',
    textBody: c.textBody,
    caption: c.caption,
    filter: 'none',
    displayMode: 'classic',
    aspectRatio: 1,
    x: c.x,
    y: c.y,
    baseRotate: c.baseRotate,
    ...tape,
  }
}

function buildTapeFields(): TapeFields {
  const tapeCount: 1 | 2 = Math.random() < 0.45 ? 1 : 2
  const [s1, s2] = pickTwoDistinctSlots()
  return {
    tapeCount,
    tapeW: Math.round(randBetween(56, 78)),
    tapeH: Math.round(randBetween(14, 20)),
    tape1: { slot: s1, color: pickTapeColor() },
    tape2: tapeCount === 2 ? { slot: s2, color: pickTapeColor() } : undefined,
  }
}

function polaroidTapeStyle(t: TapeFields): CSSProperties {
  const tape2Opacity = t.tapeCount === 2 ? 0.75 : 0
  const vars: Record<string, string | number> = {
    '--tape-w': `${t.tapeW}px`,
    '--tape-h': `${t.tapeH}px`,
    '--tape1-bg': t.tape1.color,
    '--tape1-top': t.tape1.slot.top,
    '--tape1-left': t.tape1.slot.left,
    '--tape1-rot': `${t.tape1.slot.rot}deg`,
    '--tape2-opacity': tape2Opacity,
  }
  if (t.tape2) {
    vars['--tape2-bg'] = t.tape2.color
    vars['--tape2-top'] = t.tape2.slot.top
    vars['--tape2-left'] = t.tape2.slot.left
    vars['--tape2-rot'] = `${t.tape2.slot.rot}deg`
  }
  return vars as CSSProperties
}

function filterStyle(filter: FilterKey): CSSProperties | undefined {
  const f = FILTERS.find((x) => x.key === filter)
  return f?.style
}

function normalizeAspectRatio(ratio: number | undefined) {
  if (!ratio || !Number.isFinite(ratio) || ratio <= 0) return 1
  return Math.min(MAX_ORIGINAL_RATIO, Math.max(MIN_ORIGINAL_RATIO, ratio))
}

function getPhotoWindowHeight(displayMode: PhotoDisplayMode, aspectRatio: number, polaroidInner: number) {
  if (displayMode === 'classic') return polaroidInner
  const ratio = normalizeAspectRatio(aspectRatio)
  return Math.round(polaroidInner / ratio)
}

function getPolaroidFrameHeight(
  displayMode: PhotoDisplayMode,
  aspectRatio: number,
  polaroidInner: number,
) {
  return (
    POLAROID_PAD_TOP +
    getPhotoWindowHeight(displayMode, aspectRatio, polaroidInner) +
    POLAROID_PHOTO_GAP +
    POLAROID_CAPTION_H +
    POLAROID_PAD_BOTTOM
  )
}

function readImageAspectRatio(src: string): Promise<number> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const w = (img as HTMLImageElement).naturalWidth || img.width
      const h = (img as HTMLImageElement).naturalHeight || img.height
      if (!w || !h) {
        resolve(1)
        return
      }
      resolve(w / h)
    }
    img.onerror = () => resolve(1)
    img.src = src
  })
}

function centerDeskPosition(panelW: number, panelH: number, m: PolaroidMetrics) {
  const maxX = Math.max(8, panelW - m.polaroidW - 8)
  const maxY = Math.max(8, panelH - m.classicFrameH - 8)
  const cx = (panelW - m.polaroidW) / 2 + randBetween(-50, 50)
  const cy = (panelH - m.classicFrameH) / 2 + randBetween(-40, 40)
  return {
    x: Math.round(Math.min(maxX, Math.max(8, cx))),
    y: Math.round(Math.min(maxY, Math.max(8, cy))),
  }
}

function clampDeskXY(
  nx: number,
  ny: number,
  deskW: number,
  deskH: number,
  frameHeight: number,
  polaroidW: number,
): { x: number; y: number } {
  const maxX = Math.max(8, deskW - polaroidW - 8)
  const maxY = Math.max(8, deskH - frameHeight - 8)
  return {
    x: Math.round(Math.min(maxX, Math.max(8, nx))),
    y: Math.round(Math.min(maxY, Math.max(8, ny))),
  }
}

const menuContainer = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.08, delayChildren: 0.06 },
  },
}

const menuItem = {
  hidden: { opacity: 0, y: 14 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  },
}

function PhotoNoiseOverlay({ noiseId }: { noiseId: string }) {
  return (
    <svg
      className="album-photo-noise-svg"
      aria-hidden
      preserveAspectRatio="none"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        opacity: 0.12,
      }}
    >
      <defs>
        <filter id={noiseId} x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="4" result="n" />
          <feColorMatrix in="n" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.35 0" />
        </filter>
      </defs>
      <rect width="100%" height="100%" filter={`url(#${noiseId})`} opacity={1} />
    </svg>
  )
}

function PolaroidPhotoBlock({
  imageSrc,
  textBody,
  filter,
  layoutId,
  grainNoiseId,
  displayMode,
  aspectRatio,
  polaroidInner,
}: {
  imageSrc?: string
  textBody?: string | null
  filter: FilterKey
  layoutId?: string
  grainNoiseId: string
  displayMode: PhotoDisplayMode
  aspectRatio: number
  polaroidInner: number
}) {
  const f = FILTERS.find((x) => x.key === filter)
  const windowHeight = getPhotoWindowHeight(displayMode, aspectRatio, polaroidInner)
  const wrapClass =
    filter === 'grain' ? `album-polaroid-photo-inner ${f?.className ?? ''}`.trim() : 'album-polaroid-photo-inner'

  const inner = (
    <div className={wrapClass} style={filterStyle(filter)}>
      {textBody ? (
        <div className="album-polaroid-textfill">{textBody}</div>
      ) : imageSrc ? (
        displayMode === 'original' ? (
          <>
            <img
              src={imageSrc}
              alt=""
              loading="eager"
              decoding="async"
              draggable={false}
              className="album-polaroid-bgfill"
            />
            <img
              src={imageSrc}
              alt=""
              loading="eager"
              decoding="async"
              draggable={false}
              className="album-polaroid-mainimg"
            />
          </>
        ) : (
          <img src={imageSrc} alt="" loading="eager" decoding="async" draggable={false} />
        )
      ) : null}
      {filter === 'grain' && <PhotoNoiseOverlay noiseId={grainNoiseId} />}
    </div>
  )

  if (layoutId) {
    return (
      <motion.div
        className={`album-polaroid-photo album-polaroid-photo--layout ${displayMode === 'original' ? 'album-polaroid-photo--original' : ''}`}
        layoutId={layoutId}
        transition={{ layout: LAYOUT_SPRING }}
        style={{
          width: polaroidInner,
          height: windowHeight,
          borderRadius: 2,
          overflow: 'hidden',
          position: 'relative',
          background: '#1a1916',
        }}
      >
        {inner}
      </motion.div>
    )
  }

  return (
    <div
      className={`album-polaroid-photo ${displayMode === 'original' ? 'album-polaroid-photo--original' : ''}`}
      style={{ ['--photo-h' as string]: `${windowHeight}px` }}
    >
      <div className="album-polaroid-photo-slot">
        {inner}
      </div>
    </div>
  )
}

function DraggablePolaroid({
  constraintsRef,
  id,
  x,
  y,
  baseRotate,
  caption,
  imageSrc,
  textBody,
  filter,
  displayMode,
  aspectRatio,
  tape,
  photoLayoutId,
  grainNoiseId,
  onOpenGallery,
  onDelete,
  onDragCommit,
  polaroidW,
  polaroidInner,
}: {
  constraintsRef: RefObject<HTMLElement | null>
  id: string
  x: number
  y: number
  baseRotate: number
  caption: string
  imageSrc?: string
  textBody?: string | null
  filter: FilterKey
  displayMode: PhotoDisplayMode
  aspectRatio: number
  tape: TapeFields
  photoLayoutId?: string
  grainNoiseId: string
  polaroidW: number
  polaroidInner: number
  onOpenGallery?: () => void
  onDelete?: () => void
  onDragCommit?: (nextX: number, nextY: number) => void
}) {
  const mx = useMotionValue(0)
  const my = useMotionValue(0)
  const dragStarted = useRef(false)
  const pointerDown = useRef({ x: 0, y: 0 })
  const frameHeight = getPolaroidFrameHeight(displayMode, aspectRatio, polaroidInner)
  const windowHeight = getPhotoWindowHeight(displayMode, aspectRatio, polaroidInner)

  return (
    <motion.div
      key={id}
      className="album-polaroid-wrap"
      style={{
        left: x,
        top: y,
        x: mx,
        y: my,
        rotate: baseRotate,
        width: polaroidW,
        height: frameHeight,
        zIndex: 2,
        ['--polaroid-w' as string]: `${polaroidW}px`,
        ['--polaroid-h' as string]: `${frameHeight}px`,
        ['--photo-h' as string]: `${windowHeight}px`,
      }}
      drag
      dragConstraints={constraintsRef}
      dragElastic={0.1}
      dragMomentum={false}
      whileDrag={{ scale: 1.05, rotate: 0, zIndex: 100 }}
      onDragStart={() => {
        dragStarted.current = true
      }}
      onDragEnd={() => {
        if (onDragCommit) {
          const nx = x + mx.get()
          const ny = y + my.get()
          mx.set(0)
          my.set(0)
          onDragCommit(nx, ny)
        }
        requestAnimationFrame(() => {
          dragStarted.current = false
        })
      }}
      onPointerDown={(e) => {
        pointerDown.current = { x: e.clientX, y: e.clientY }
      }}
      onPointerUp={(e) => {
        if (!onOpenGallery) return
        const d = Math.hypot(e.clientX - pointerDown.current.x, e.clientY - pointerDown.current.y)
        if (!dragStarted.current && d < 12) onOpenGallery()
      }}
    >
      {onDelete && (
        <button
          type="button"
          className="album-polaroid-delete"
          aria-label="删除照片"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          ×
        </button>
      )}
      <div className="album-polaroid" style={{ ...polaroidTapeStyle(tape), height: frameHeight }}>
        <PolaroidPhotoBlock
          imageSrc={imageSrc}
          textBody={textBody}
          filter={filter}
          layoutId={photoLayoutId}
          grainNoiseId={grainNoiseId}
          displayMode={displayMode}
          aspectRatio={aspectRatio}
          polaroidInner={polaroidInner}
        />
        <p className="album-polaroid-caption">{caption}</p>
      </div>
    </motion.div>
  )
}

export function Album() {
  const { cityId } = useParams()
  const navigate = useNavigate()
  const meta = useMemo(() => metaForCityId(cityId), [cityId])
  const [phase, setPhase] = useState<'entering' | 'ready' | 'exiting'>('entering')
  const exposureDoneRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const previewFileRef = useRef<File | null>(null)
  const layoutIdRef = useRef(`place-${Date.now()}`)

  const deskRef = useRef<HTMLElement | null>(null)
  const [deskSize, setDeskSize] = useState({ w: 0, h: 0 })
  const [vw, setVw] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1024))
  const pm = useMemo(() => computePolaroidMetrics(vw), [vw])

  useEffect(() => {
    const onResize = () => setVw(window.innerWidth)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const [uploadFlow, setUploadFlow] = useState<UploadFlow>('closed')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewName, setPreviewName] = useState('')
  const [selectedFilter, setSelectedFilter] = useState<FilterKey>('none')
  const [selectedDisplayMode, setSelectedDisplayMode] = useState<PhotoDisplayMode>('classic')
  const [previewAspectRatio, setPreviewAspectRatio] = useState(1)
  const [userPolaroids, setUserPolaroids] = useState<UserPolaroid[]>([])
  const [writingText, setWritingText] = useState('')
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [galleryIndex, setGalleryIndex] = useState(0)
  const [galleryLayoutId, setGalleryLayoutId] = useState('')
  const [captionById, setCaptionById] = useState<Record<string, string>>({})
  const [captionStoreReady, setCaptionStoreReady] = useState(false)

  const cityGalleryKey = useMemo(
    () => (cityId ?? 'album').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'album',
    [cityId],
  )
  const galleryCaptionStorageKey = useMemo(() => `memory.gallery-captions.${cityGalleryKey}`, [cityGalleryKey])

  useEffect(() => {
    if (supabaseEnabled) return
    try {
      const raw = window.localStorage.getItem(galleryCaptionStorageKey)
      if (!raw) {
        setCaptionById({})
        setCaptionStoreReady(true)
        return
      }
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object') {
        setCaptionById({})
        setCaptionStoreReady(true)
        return
      }
      const normalized: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') normalized[k] = v
      }
      setCaptionById(normalized)
      setCaptionStoreReady(true)
    } catch {
      setCaptionById({})
      setCaptionStoreReady(true)
    }
  }, [galleryCaptionStorageKey, supabaseEnabled])

  useEffect(() => {
    if (!cityId || supabaseEnabled) return
    setUserPolaroids([])
  }, [cityId, supabaseEnabled])

  useEffect(() => {
    if (!supabaseEnabled || !cityId) return
    let cancelled = false
    setCaptionStoreReady(false)
    setUserPolaroids([])
    ;(async () => {
      const photos = await listPhotosForCity(cityId)
      if (cancelled) return
      let localMap: Record<string, string> = {}
      try {
        const raw = window.localStorage.getItem(galleryCaptionStorageKey)
        if (raw) {
          const parsed = JSON.parse(raw) as unknown
          if (parsed && typeof parsed === 'object') {
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
              if (typeof v === 'string') localMap[k] = v
            }
          }
        }
      } catch {
        localMap = {}
      }
      await mergeLocalCaptionsToCloud(cityId, localMap, photos)
      const finalCaps = await listCaptionsForCity(cityId)
      if (cancelled) return
      setUserPolaroids(photos.map(cloudPolaroidToUser))
      setCaptionById(finalCaps)
      setCaptionStoreReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [cityId, galleryCaptionStorageKey, supabaseEnabled])

  useEffect(() => {
    if (!captionStoreReady) return
    if (supabaseEnabled) return
    window.localStorage.setItem(galleryCaptionStorageKey, JSON.stringify(captionById))
  }, [captionById, galleryCaptionStorageKey, captionStoreReady, supabaseEnabled])

  const galleryItems = useMemo((): GalleryItem[] => {
    return userPolaroids.map((u) => ({
      id: u.id,
      layoutId: u.layoutId,
      imageSrc: u.kind === 'image' ? u.src : undefined,
      textBody: u.kind === 'text' ? u.textBody ?? null : null,
      caption: captionById[u.id] ?? u.caption,
      filter: u.filter,
      displayMode: u.displayMode ?? 'classic',
      aspectRatio: u.aspectRatio ?? 1,
    }))
  }, [userPolaroids, captionById])

  const handleCaptionChange = useCallback(
    (itemId: string, value: string) => {
      setCaptionById((prev) => {
        if (prev[itemId] === value) return prev
        return { ...prev, [itemId]: value }
      })
      if (parseUserPhotoUuid(itemId)) {
        setUserPolaroids((prev) => prev.map((p) => (p.id === itemId ? { ...p, caption: value } : p)))
      }
      if (supabaseEnabled && cityId) {
        void persistGalleryCaption(cityId, itemId, value)
      }
    },
    [cityId],
  )

  const handlePolaroidDragCommit = useCallback(
    (p: UserPolaroid, nx: number, ny: number) => {
      const fh = getPolaroidFrameHeight(
        p.displayMode ?? 'classic',
        p.aspectRatio ?? 1,
        pm.polaroidInner,
      )
      const { x: cx, y: cy } =
        deskSize.w > 0 && deskSize.h > 0
          ? clampDeskXY(nx, ny, deskSize.w, deskSize.h, fh, pm.polaroidW)
          : { x: Math.round(nx), y: Math.round(ny) }
      setUserPolaroids((prev) => prev.map((q) => (q.id === p.id ? { ...q, x: cx, y: cy } : q)))
      const uuid = parseUserPhotoUuid(p.id)
      if (uuid && supabaseEnabled && cityId) {
        void updatePhotoPosition(cityId, uuid, cx, cy)
      }
    },
    [deskSize.w, deskSize.h, cityId, supabaseEnabled, pm.polaroidInner, pm.polaroidW],
  )

  const handleDeleteUserPolaroid = useCallback(
    async (p: UserPolaroid) => {
      if (!window.confirm('确定删除这张照片？删除后无法恢复。')) return

      const uuid = parseUserPhotoUuid(p.id)
      if (supabaseEnabled && cityId && uuid) {
        const ok = await deletePhotoFromCloud(cityId, p.id)
        if (!ok) {
          window.alert('删除失败，请稍后再试；可按 F12 查看控制台 [memory] 日志。')
          return
        }
      }

      if (p.kind === 'image' && p.src?.startsWith('blob:')) {
        URL.revokeObjectURL(p.src)
      }

      setUserPolaroids((prev) => prev.filter((x) => x.id !== p.id))
      setCaptionById((prev) => {
        if (!(p.id in prev)) return prev
        const next = { ...prev }
        delete next[p.id]
        return next
      })
      setGalleryOpen(false)
    },
    [cityId],
  )

  const openGallery = useCallback(
    (layoutId: string) => {
      const i = galleryItems.findIndex((g) => g.layoutId === layoutId)
      if (i < 0) return
      setGalleryIndex(i)
      setGalleryLayoutId(layoutId)
      setGalleryOpen(true)
    },
    [galleryItems],
  )

  useLayoutEffect(() => {
    const el = deskRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setDeskSize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const userPolaroidsRef = useRef(userPolaroids)
  userPolaroidsRef.current = userPolaroids
  const previewUrlRef = useRef(previewUrl)
  previewUrlRef.current = previewUrl

  useEffect(() => {
    return () => {
      userPolaroidsRef.current.forEach((u) => {
        if (u.src?.startsWith('blob:')) URL.revokeObjectURL(u.src)
      })
      const pv = previewUrlRef.current
      if (pv?.startsWith('blob:')) URL.revokeObjectURL(pv)
    }
  }, [])

  const onExposureEnd = useCallback((e: React.AnimationEvent<HTMLDivElement>) => {
    if (exposureDoneRef.current) return
    if (!e.animationName.includes('album-exposure-in')) return
    exposureDoneRef.current = true
    setPhase('ready')
  }, [])

  const onExitEnd = useCallback(
    (e: React.AnimationEvent<HTMLDivElement>) => {
      if (!e.animationName.includes('album-exposure-out')) return
      navigate('/')
    },
    [navigate],
  )

  const handleBack = useCallback(() => {
    if (phase === 'exiting') return
    setPhase('exiting')
  }, [phase])

  const closeUpload = useCallback(() => {
    setUploadFlow('closed')
    if (previewUrl?.startsWith('blob:')) URL.revokeObjectURL(previewUrl)
    previewFileRef.current = null
    setPreviewUrl(null)
    setPreviewName('')
    setSelectedFilter('none')
    setSelectedDisplayMode('classic')
    setPreviewAspectRatio(1)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [previewUrl])

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const onFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f || !f.type.startsWith('image/')) return
    previewFileRef.current = f
    if (previewUrl?.startsWith('blob:')) URL.revokeObjectURL(previewUrl)
    const url = URL.createObjectURL(f)
    const ratio = await readImageAspectRatio(url)
    layoutIdRef.current = `place-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setPreviewName(f.name.replace(/\.[^.]+$/, '').slice(0, 18) || '此刻')
    setPreviewUrl(url)
    const normalizedRatio = normalizeAspectRatio(ratio)
    setPreviewAspectRatio(normalizedRatio)
    setSelectedDisplayMode('classic')
    setSelectedFilter('none')
    setUploadFlow('filters')
  }, [previewUrl])

  const stickToDesk = useCallback(async () => {
    if (!previewUrl || deskSize.w <= 0) return
    const pos = centerDeskPosition(deskSize.w, deskSize.h, pm)
    const lid = layoutIdRef.current
    const tape = buildTapeFields()
    const rot = randBetween(-12, 12)
    const ratio = normalizeAspectRatio(previewAspectRatio)
    const cap = previewName || '此刻'

    if (supabaseEnabled && cityId && previewFileRef.current) {
      const inserted = await insertImagePhoto({
        cityId,
        file: previewFileRef.current,
        caption: cap,
        filter: selectedFilter,
        displayMode: selectedDisplayMode,
        aspectRatio: ratio,
        posX: pos.x,
        posY: pos.y,
        baseRotate: rot,
        tape: tape as unknown as Record<string, unknown>,
      })
      if (inserted) {
        flushSync(() => {
          setUserPolaroids((p) => [...p, cloudPolaroidToUser(inserted)])
        })
        setUploadFlow('closed')
        if (previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl)
        previewFileRef.current = null
        setPreviewUrl(null)
        setPreviewName('')
        setSelectedFilter('none')
        setSelectedDisplayMode('classic')
        setPreviewAspectRatio(1)
        if (fileInputRef.current) fileInputRef.current.value = ''
        return
      }
    }

    const card: UserPolaroid = {
      id: `u-${lid}`,
      layoutId: lid,
      kind: 'image',
      src: previewUrl,
      caption: cap,
      filter: selectedFilter,
      displayMode: selectedDisplayMode,
      aspectRatio: ratio,
      x: pos.x,
      y: pos.y,
      baseRotate: rot,
      ...tape,
    }
    flushSync(() => {
      setUserPolaroids((p) => [...p, card])
    })
    setUploadFlow('closed')
    setPreviewUrl(null)
    previewFileRef.current = null
    setPreviewName('')
    setSelectedFilter('none')
    setSelectedDisplayMode('classic')
    setPreviewAspectRatio(1)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [
    previewUrl,
    deskSize.w,
    deskSize.h,
    previewName,
    selectedFilter,
    selectedDisplayMode,
    previewAspectRatio,
    cityId,
    pm,
  ])

  const saveWritingCard = useCallback(async () => {
    const t = writingText.trim()
    if (!t || deskSize.w <= 0) return
    const pos = centerDeskPosition(deskSize.w, deskSize.h, pm)
    const tape = buildTapeFields()
    const rot = randBetween(-12, 12)

    if (supabaseEnabled && cityId) {
      const inserted = await insertTextPhoto({
        cityId,
        textBody: t,
        caption: '手记',
        posX: pos.x,
        posY: pos.y,
        baseRotate: rot,
        tape: tape as unknown as Record<string, unknown>,
      })
      if (inserted) {
        setUserPolaroids((p) => [...p, cloudPolaroidToUser(inserted)])
        setWritingText('')
        setUploadFlow('closed')
        return
      }
    }

    const lid = `place-text-${Date.now()}`
    const card: UserPolaroid = {
      id: `u-${lid}`,
      layoutId: lid,
      kind: 'text',
      textBody: t,
      caption: '手记',
      filter: 'none',
      displayMode: 'classic',
      aspectRatio: 1,
      x: pos.x,
      y: pos.y,
      baseRotate: rot,
      ...tape,
    }
    setUserPolaroids((p) => [...p, card])
    setWritingText('')
    setUploadFlow('closed')
  }, [writingText, deskSize.w, deskSize.h, cityId, pm])

  const writingKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        saveWritingCard()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setUploadFlow('closed')
        setWritingText('')
      }
    },
    [saveWritingCard],
  )

  const exposureClass =
    phase === 'exiting'
      ? 'album-exposure album-exposure--exit'
      : phase === 'ready'
        ? 'album-exposure album-exposure--done'
        : 'album-exposure'

  const previewGrainId = useId().replace(/:/g, 'g')
  const polaroidGrainPrefix = useId().replace(/:/g, 'p')

  return (
    <LayoutGroup id="album-desk-layout">
      <div className="album-root">
        <div
          className={exposureClass}
          onAnimationEnd={phase === 'exiting' ? onExitEnd : onExposureEnd}
          aria-hidden
        />

        <button
          type="button"
          className="album-back"
          onClick={handleBack}
          disabled={phase === 'exiting'}
        >
          ← {meta.coverTitle}
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="album-file-input"
          onChange={onFileChange}
          aria-hidden
          tabIndex={-1}
        />

        <div className="album-shell">
          <section ref={deskRef} className="album-right album-right--galaxy" aria-label="Album photographs">
            {userPolaroids.map((u) => (
              <DraggablePolaroid
                key={u.id}
                id={u.id}
                constraintsRef={deskRef}
                x={u.x}
                y={u.y}
                baseRotate={u.baseRotate}
                caption={captionById[u.id] ?? u.caption}
                imageSrc={u.kind === 'image' ? u.src : undefined}
                textBody={u.kind === 'text' ? u.textBody : null}
                filter={u.filter}
                displayMode={u.displayMode ?? 'classic'}
                aspectRatio={u.aspectRatio ?? 1}
                tape={u}
                photoLayoutId={u.layoutId}
                grainNoiseId={`${polaroidGrainPrefix}-${u.id}`}
                onOpenGallery={() => openGallery(u.layoutId)}
                onDelete={() => void handleDeleteUserPolaroid(u)}
                onDragCommit={(nx, ny) => handlePolaroidDragCommit(u, nx, ny)}
                polaroidW={pm.polaroidW}
                polaroidInner={pm.polaroidInner}
              />
            ))}

            <button
              type="button"
              className="album-add-btn"
              aria-label="Add photos"
              onClick={() => setUploadFlow('menu')}
            >
              +
            </button>
            <AnimatePresence>
              {uploadFlow !== 'closed' && uploadFlow !== 'writing' && (
                <motion.div
                  className="album-upload-backdrop"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25 }}
                  onClick={closeUpload}
                />
              )}
            </AnimatePresence>

            <AnimatePresence>
              {uploadFlow === 'menu' && (
                <motion.div
                  className="album-upload-panel"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="album-ritual-title"
                  initial={{ opacity: 0, y: 28 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 18 }}
                  transition={{ type: 'spring', stiffness: 280, damping: 26 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="album-upload-panel-inner album-upload-panel-inner--wide">
                    <h2 id="album-ritual-title">放进相册</h2>
                    <p className="album-ritual-sub">选择一种方式，为桌面添一张回忆。</p>
                    <motion.ul
                      className="album-ritual-menu"
                      variants={menuContainer}
                      initial="hidden"
                      animate="show"
                    >
                      <motion.li variants={menuItem}>
                        <button
                          type="button"
                          className="album-ritual-option"
                          onClick={() => {
                            openFilePicker()
                          }}
                        >
                          <span className="album-ritual-option-ico" aria-hidden>
                            📷
                          </span>
                          <span>扫描宝丽来</span>
                        </button>
                      </motion.li>
                      <motion.li variants={menuItem}>
                        <button
                          type="button"
                          className="album-ritual-option"
                          onClick={() => setUploadFlow('writing')}
                        >
                          <span className="album-ritual-option-ico" aria-hidden>
                            ✍️
                          </span>
                          <span>写下此刻</span>
                        </button>
                      </motion.li>
                    </motion.ul>
                    <button type="button" className="album-upload-close" onClick={closeUpload}>
                      Close
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {uploadFlow === 'filters' && previewUrl && (
                <>
                  <motion.div
                    className="album-upload-backdrop"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.22 }}
                    onClick={() => setUploadFlow('menu')}
                  />
                  <motion.div
                    className="album-upload-panel album-upload-panel--filters"
                    role="dialog"
                    aria-modal="true"
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    transition={{ type: 'spring', stiffness: 320, damping: 28 }}
                    onClick={(e) => e.stopPropagation()}
                  >
                  <div className="album-filter-sheet">
                    <button type="button" className="album-filter-back" onClick={() => setUploadFlow('menu')}>
                      ← 返回
                    </button>
                    <h2 className="album-filter-title">选一种光</h2>
                    <div className="album-filter-hero-wrap">
                      <PolaroidPhotoBlock
                        imageSrc={previewUrl}
                        textBody={null}
                        filter={selectedFilter}
                        grainNoiseId={previewGrainId}
                        displayMode={selectedDisplayMode}
                        aspectRatio={previewAspectRatio}
                        polaroidInner={pm.polaroidInner}
                      />
                    </div>
                    <div className="album-ratio-switch-wrap">
                      <div className="album-ratio-switch-title">Display Ratio</div>
                      <div className="album-ratio-switch-desc">Original 会保留原图比例，预览与墙面保持一致。</div>
                    <div className="album-ratio-switch" role="group" aria-label="照片显示比例">
                      <button
                        type="button"
                        className={`album-ratio-btn ${selectedDisplayMode === 'classic' ? 'album-ratio-btn--on' : ''}`}
                        onClick={() => setSelectedDisplayMode('classic')}
                      >
                        Classic
                      </button>
                      <button
                        type="button"
                        className={`album-ratio-btn ${selectedDisplayMode === 'original' ? 'album-ratio-btn--on' : ''}`}
                        onClick={() => setSelectedDisplayMode('original')}
                      >
                        Original
                      </button>
                    </div>
                    </div>
                    <div className="album-filter-grid">
                      {FILTERS.map((f) => (
                        <button
                          key={f.key}
                          type="button"
                          className={`album-filter-chip ${selectedFilter === f.key ? 'album-filter-chip--on' : ''}`}
                          onClick={() => setSelectedFilter(f.key)}
                        >
                          <span className="album-filter-chip-thumb-wrap">
                            <img
                              src={previewUrl}
                              alt=""
                              className={`album-filter-chip-img ${f.className ?? ''}`.trim()}
                              style={f.style}
                              draggable={false}
                            />
                            {f.key === 'grain' && (
                              <span className="album-filter-chip-grain" aria-hidden>
                                <PhotoNoiseOverlay noiseId={`${previewGrainId}-chip-${f.key}`} />
                              </span>
                            )}
                          </span>
                          <span className="album-filter-chip-name">{f.name}</span>
                        </button>
                      ))}
                    </div>
                    <button type="button" className="album-filter-stick" onClick={stickToDesk}>
                      贴入相册
                    </button>
                    <button type="button" className="album-upload-close album-filter-cancel" onClick={closeUpload}>
                      取消
                    </button>
                  </div>
                  </motion.div>
                </>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {uploadFlow === 'writing' && (
                <motion.div
                  className="album-writing-screen"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  <textarea
                    className="album-writing-input"
                    placeholder="此刻的心情…（Enter 保存，Shift+Enter 换行，Esc 关闭）"
                    value={writingText}
                    onChange={(e) => setWritingText(e.target.value)}
                    onKeyDown={writingKeyDown}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="album-writing-close"
                    onClick={() => {
                      setUploadFlow('closed')
                      setWritingText('')
                    }}
                  >
                    Esc 关闭
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        </div>

        <AnimatePresence>
          {galleryOpen && galleryItems.length > 0 && (
            <Gallery
              key={galleryLayoutId}
              items={galleryItems}
              initialIndex={galleryIndex}
              openLayoutId={galleryLayoutId}
              cityName={meta.coverTitle}
              emojis={meta.emoji}
              captionById={captionById}
              onCaptionChange={handleCaptionChange}
              onClose={() => setGalleryOpen(false)}
            />
          )}
        </AnimatePresence>
      </div>
    </LayoutGroup>
  )
}
