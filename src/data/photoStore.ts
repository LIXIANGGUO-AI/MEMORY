import { supabase, supabaseEnabled } from '../lib/supabase'

const PHOTOS_TABLE = 'photos'
const CAPTIONS_TABLE = 'album_captions'
export const PHOTOS_BUCKET = 'memory-photos'

type PhotoRow = {
  id: string
  city_id: string
  kind: 'image' | 'text'
  storage_path: string | null
  text_body: string | null
  caption: string
  filter: string
  display_mode: string
  aspect_ratio: number
  pos_x: number
  pos_y: number
  base_rotate: number
  tape: unknown
}

export type CloudPolaroid = {
  id: string
  clientId: string
  layoutId: string
  kind: 'image' | 'text'
  imageUrl?: string
  textBody?: string
  caption: string
  filter: string
  displayMode: string
  aspectRatio: number
  x: number
  y: number
  baseRotate: number
  tape: unknown
}

const UUID_IN_U = /^u-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

export function parseUserPhotoUuid(clientId: string): string | null {
  const m = clientId.match(UUID_IN_U)
  return m?.[1] ?? null
}

function publicUrlForPath(path: string): string {
  if (!supabase) return ''
  const { data } = supabase.storage.from(PHOTOS_BUCKET).getPublicUrl(path)
  return data.publicUrl
}

function extFromFile(file: File): string {
  const fromName = file.name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
  if (fromName && fromName.length <= 8) return fromName
  if (file.type === 'image/png') return 'png'
  if (file.type === 'image/webp') return 'webp'
  if (file.type === 'image/gif') return 'gif'
  return 'jpg'
}

export async function listPhotosForCity(cityId: string): Promise<CloudPolaroid[]> {
  if (!supabaseEnabled || !supabase) return []
  const id = cityId.toLowerCase()
  const { data, error } = await supabase
    .from(PHOTOS_TABLE)
    .select(
      'id,city_id,kind,storage_path,text_body,caption,filter,display_mode,aspect_ratio,pos_x,pos_y,base_rotate,tape,created_at',
    )
    .eq('city_id', id)
    .order('created_at', { ascending: true })

  if (error) {
    console.error('[memory] Supabase photos select failed:', error.message, error)
    return []
  }
  if (!data?.length) return []

  return (data as PhotoRow[]).map((row) => {
    const clientId = `u-${row.id}`
    const layoutId = `place-${row.id}`
    const base: CloudPolaroid = {
      id: row.id,
      clientId,
      layoutId,
      kind: row.kind,
      caption: row.caption ?? '',
      filter: row.filter || 'none',
      displayMode: row.display_mode || 'classic',
      aspectRatio: Number.isFinite(row.aspect_ratio) ? row.aspect_ratio : 1,
      x: row.pos_x,
      y: row.pos_y,
      baseRotate: row.base_rotate,
      tape: row.tape,
    }
    if (row.kind === 'text') {
      return { ...base, textBody: row.text_body ?? '' }
    }
    const path = row.storage_path
    if (!path) return base
    return { ...base, imageUrl: publicUrlForPath(path) }
  })
}

export async function listCaptionsForCity(cityId: string): Promise<Record<string, string>> {
  if (!supabaseEnabled || !supabase) return {}
  const id = cityId.toLowerCase()
  const { data, error } = await supabase
    .from(CAPTIONS_TABLE)
    .select('item_id,caption')
    .eq('city_id', id)

  if (error) {
    console.error('[memory] Supabase album_captions select failed:', error.message, error)
    return {}
  }
  const out: Record<string, string> = {}
  for (const row of data ?? []) {
    const r = row as { item_id: string; caption: string }
    if (r.item_id && typeof r.caption === 'string') out[r.item_id] = r.caption
  }
  return out
}

export async function upsertCaption(cityId: string, itemId: string, caption: string) {
  if (!supabaseEnabled || !supabase) return false
  const { error } = await supabase.from(CAPTIONS_TABLE).upsert(
    {
      city_id: cityId.toLowerCase(),
      item_id: itemId,
      caption,
    },
    { onConflict: 'city_id,item_id' },
  )
  if (error) {
    console.error('[memory] Supabase album_captions upsert failed:', error.message, error)
    return false
  }
  return true
}

export async function updatePhotoCaption(photoUuid: string, caption: string) {
  if (!supabaseEnabled || !supabase) return false
  const { error } = await supabase.from(PHOTOS_TABLE).update({ caption }).eq('id', photoUuid)
  if (error) {
    console.error('[memory] Supabase photos caption update failed:', error.message, error)
    return false
  }
  return true
}

export async function updatePhotoPosition(
  cityId: string,
  photoUuid: string,
  posX: number,
  posY: number,
): Promise<boolean> {
  if (!supabaseEnabled || !supabase) return false
  const { error } = await supabase
    .from(PHOTOS_TABLE)
    .update({ pos_x: posX, pos_y: posY })
    .eq('id', photoUuid)
    .eq('city_id', cityId.toLowerCase())
  if (error) {
    console.error('[memory] Supabase photos position update failed:', error.message, error)
    return false
  }
  return true
}

/** Persist gallery caption: scatter keys → album_captions; user uuid cards → photos.caption */
export async function persistGalleryCaption(cityId: string, itemId: string, caption: string) {
  const uuid = parseUserPhotoUuid(itemId)
  if (uuid) {
    return updatePhotoCaption(uuid, caption)
  }
  return upsertCaption(cityId, itemId, caption)
}

/** Remove one user photo/text card from DB and Storage (client id is `u-{uuid}`). */
export async function deletePhotoFromCloud(cityId: string, clientId: string): Promise<boolean> {
  if (!supabaseEnabled || !supabase) return false
  const uuid = parseUserPhotoUuid(clientId)
  if (!uuid) return false
  const cid = cityId.toLowerCase()

  const { data: row, error: fetchErr } = await supabase
    .from(PHOTOS_TABLE)
    .select('storage_path,kind,city_id')
    .eq('id', uuid)
    .maybeSingle()

  if (fetchErr) {
    console.error('[memory] Supabase photos fetch before delete failed:', fetchErr.message, fetchErr)
    return false
  }
  const r = row as { storage_path: string | null; kind: string; city_id: string } | null
  if (!r || r.city_id !== cid) return false

  if (r.kind === 'image' && r.storage_path) {
    const { error: rmErr } = await supabase.storage.from(PHOTOS_BUCKET).remove([r.storage_path])
    if (rmErr) console.error('[memory] Storage remove failed:', rmErr.message, rmErr)
  }

  const { error: delErr } = await supabase.from(PHOTOS_TABLE).delete().eq('id', uuid).eq('city_id', cid)
  if (delErr) {
    console.error('[memory] Supabase photos delete failed:', delErr.message, delErr)
    return false
  }
  return true
}

type TapeFieldsJson = Record<string, unknown>

export async function insertImagePhoto(params: {
  cityId: string
  file: File
  caption: string
  filter: string
  displayMode: string
  aspectRatio: number
  posX: number
  posY: number
  baseRotate: number
  tape: TapeFieldsJson
}): Promise<CloudPolaroid | null> {
  if (!supabaseEnabled || !supabase) return null

  const cityLower = params.cityId.toLowerCase()
  const photoId = crypto.randomUUID()
  const path = `${cityLower}/${photoId}.${extFromFile(params.file)}`

  const { error: upErr } = await supabase.storage.from(PHOTOS_BUCKET).upload(path, params.file, {
    cacheControl: '3600',
    upsert: false,
    contentType: params.file.type || undefined,
  })
  if (upErr) {
    console.error('[memory] Storage upload failed:', upErr.message, upErr)
    return null
  }

  const row = {
    id: photoId,
    city_id: cityLower,
    kind: 'image' as const,
    storage_path: path,
    text_body: null,
    caption: params.caption,
    filter: params.filter,
    display_mode: params.displayMode,
    aspect_ratio: params.aspectRatio,
    pos_x: params.posX,
    pos_y: params.posY,
    base_rotate: params.baseRotate,
    tape: params.tape,
  }

  const { error: insErr } = await supabase.from(PHOTOS_TABLE).insert(row)
  if (insErr) {
    console.error('[memory] Supabase photos insert failed:', insErr.message, insErr)
    await supabase.storage.from(PHOTOS_BUCKET).remove([path])
    return null
  }

  return {
    id: photoId,
    clientId: `u-${photoId}`,
    layoutId: `place-${photoId}`,
    kind: 'image',
    imageUrl: publicUrlForPath(path),
    caption: params.caption,
    filter: params.filter,
    displayMode: params.displayMode,
    aspectRatio: params.aspectRatio,
    x: params.posX,
    y: params.posY,
    baseRotate: params.baseRotate,
    tape: params.tape,
  }
}

export async function insertTextPhoto(params: {
  cityId: string
  textBody: string
  caption: string
  posX: number
  posY: number
  baseRotate: number
  tape: TapeFieldsJson
}): Promise<CloudPolaroid | null> {
  if (!supabaseEnabled || !supabase) return null

  const cityLower = params.cityId.toLowerCase()
  const photoId = crypto.randomUUID()

  const row = {
    id: photoId,
    city_id: cityLower,
    kind: 'text' as const,
    storage_path: null,
    text_body: params.textBody,
    caption: params.caption,
    filter: 'none',
    display_mode: 'classic',
    aspect_ratio: 1,
    pos_x: params.posX,
    pos_y: params.posY,
    base_rotate: params.baseRotate,
    tape: params.tape,
  }

  const { error } = await supabase.from(PHOTOS_TABLE).insert(row)
  if (error) {
    console.error('[memory] Supabase text photo insert failed:', error.message, error)
    return null
  }

  return {
    id: photoId,
    clientId: `u-${photoId}`,
    layoutId: `place-${photoId}`,
    kind: 'text',
    textBody: params.textBody,
    caption: params.caption,
    filter: 'none',
    displayMode: 'classic',
    aspectRatio: 1,
    x: params.posX,
    y: params.posY,
    baseRotate: params.baseRotate,
    tape: params.tape,
  }
}

/** Merge localStorage caption map into Supabase (migration / fill empty cloud captions). */
export async function mergeLocalCaptionsToCloud(
  cityId: string,
  localMap: Record<string, string>,
  cloudPhotos: CloudPolaroid[],
) {
  if (!supabaseEnabled || !supabase || Object.keys(localMap).length === 0) return
  const remote = await listCaptionsForCity(cityId)
  const cloudIds = new Set(cloudPhotos.map((p) => p.clientId))

  for (const [itemId, caption] of Object.entries(localMap)) {
    if (!caption.trim()) continue
    const uuid = parseUserPhotoUuid(itemId)
    if (uuid) {
      if (!cloudIds.has(itemId) || !supabase) continue
      const { data } = await supabase.from(PHOTOS_TABLE).select('caption').eq('id', uuid).maybeSingle()
      const existing = (data as { caption?: string } | null)?.caption
      if (existing === undefined || existing === '' || existing === null) {
        await updatePhotoCaption(uuid, caption)
      }
      continue
    }
    if (!remote[itemId]) {
      await upsertCaption(cityId, itemId, caption)
    }
  }
}
