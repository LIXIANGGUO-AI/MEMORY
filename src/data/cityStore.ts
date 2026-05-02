import { defaultCities, DEFAULT_CITY_EMOJI, slugifyCityId, titleFromId, type CityRecord } from './cities'
import { supabase, supabaseEnabled } from '../lib/supabase'

const STORAGE_KEY = 'memory.custom-cities.v2'
const CITIES_TABLE = 'cities'

type CityRow = {
  id: string
  name: string
  cover_title: string
  lat: number
  lon: number
  emoji: string | null
  photo_count: number | null
  theme: string | null
}

function isCityRecord(v: unknown): v is CityRecord {
  if (!v || typeof v !== 'object') return false
  const x = v as Record<string, unknown>
  return (
    typeof x.id === 'string' &&
    typeof x.name === 'string' &&
    typeof x.coverTitle === 'string' &&
    typeof x.lat === 'number' &&
    typeof x.lon === 'number'
  )
}

function normalizeTheme(theme: unknown): CityRecord['theme'] {
  return theme === 'kyoto' || theme === 'iceland' || theme === 'paris' || theme === 'new-york' || theme === 'default'
    ? theme
    : 'default'
}

function normalizeCityRecord(x: CityRecord): CityRecord {
  const genericCover =
    /^city[-\s]\d+/i.test(x.coverTitle) ||
    x.coverTitle.trim().toLowerCase() === titleFromId(x.id).trim().toLowerCase()
  return {
    ...x,
    coverTitle: genericCover ? x.name : x.coverTitle,
    theme: normalizeTheme(x.theme),
    emoji: x.emoji ?? DEFAULT_CITY_EMOJI,
    photoCount: Number.isFinite(x.photoCount) ? x.photoCount : 12,
  }
}

function rowToCityRecord(row: CityRow): CityRecord {
  return normalizeCityRecord({
    id: row.id.toLowerCase(),
    name: row.name,
    coverTitle: row.cover_title || row.name,
    lat: row.lat,
    lon: row.lon,
    emoji: row.emoji ?? DEFAULT_CITY_EMOJI,
    photoCount: Number.isFinite(row.photo_count) ? (row.photo_count as number) : 12,
    theme: normalizeTheme(row.theme),
  })
}

function cityRecordToRow(city: CityRecord): CityRow {
  return {
    id: city.id.toLowerCase(),
    name: city.name,
    cover_title: city.coverTitle,
    lat: city.lat,
    lon: city.lon,
    emoji: city.emoji,
    photo_count: city.photoCount,
    theme: city.theme,
  }
}

export function getCustomCities(): CityRecord[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isCityRecord).map((x) => normalizeCityRecord(x))
  } catch {
    return []
  }
}

function setCustomCities(cities: CityRecord[]) {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cities))
}

export function listCities(): CityRecord[] {
  const customs = getCustomCities()
  const seen = new Set<string>()
  const merged: CityRecord[] = []
  for (const c of [...defaultCities, ...customs]) {
    const id = c.id.toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    merged.push({ ...c, id })
  }
  return merged
}

async function pullCustomCitiesFromCloud(): Promise<CityRecord[] | null> {
  if (!supabaseEnabled || !supabase) return null
  const { data, error } = await supabase
    .from(CITIES_TABLE)
    .select('id,name,cover_title,lat,lon,emoji,photo_count,theme')
    .order('id', { ascending: true })
  if (error) {
    console.error('[memory] Supabase cities select failed:', error.message, error)
    return null
  }
  if (!data) return null
  return (data as CityRow[]).map(rowToCityRecord)
}

async function pushCustomCityToCloud(city: CityRecord): Promise<boolean> {
  if (!supabaseEnabled || !supabase) return false
  const { error } = await supabase.from(CITIES_TABLE).upsert(cityRecordToRow(city))
  if (error) {
    console.error('[memory] Supabase cities upsert failed:', error.message, error)
    return false
  }
  return true
}

async function removeCustomCityFromCloud(cityId: string): Promise<boolean> {
  if (!supabaseEnabled || !supabase) return false
  const { error } = await supabase.from(CITIES_TABLE).delete().eq('id', cityId.toLowerCase())
  if (error) {
    console.error('[memory] Supabase cities delete failed:', error.message, error)
    return false
  }
  return true
}

export async function listCitiesAsync(): Promise<CityRecord[]> {
  const cloud = await pullCustomCitiesFromCloud()
  if (cloud === null) {
    return listCities()
  }
  if (cloud.length > 0) {
    setCustomCities(cloud)
    return listCities()
  }
  // Cloud responded OK but table is empty: do NOT wipe localStorage ([] is truthy and used to erase locals).
  // Push any existing local rows up once (recovery when upsert previously failed).
  const locals = getCustomCities()
  if (supabaseEnabled && locals.length > 0) {
    for (const c of locals) {
      await pushCustomCityToCloud(c)
    }
    const again = await pullCustomCitiesFromCloud()
    if (again && again.length > 0) {
      setCustomCities(again)
    }
  }
  return listCities()
}

export function getCityById(cityId: string | undefined) {
  if (!cityId) return undefined
  const id = cityId.toLowerCase()
  if (id === 'newyork') return listCities().find((c) => c.id === 'new-york')
  return listCities().find((c) => c.id === id)
}

export function addCity(input: {
  name: string
  lat: number
  lon: number
  coverTitle?: string
  emoji?: string
}) {
  const name = input.name.trim()
  if (!name) throw new Error('地点名不能为空')
  if (!Number.isFinite(input.lat) || input.lat < -90 || input.lat > 90) throw new Error('纬度无效')
  if (!Number.isFinite(input.lon) || input.lon < -180 || input.lon > 180) throw new Error('经度无效')

  const id = slugifyCityId(name)
  const all = listCities()
  if (all.some((c) => c.id === id)) throw new Error('该地点已存在')

  const customCity: CityRecord = {
    id,
    name: name.toUpperCase(),
    coverTitle: input.coverTitle?.trim() || name,
    lat: input.lat,
    lon: input.lon,
    emoji: input.emoji?.trim() || DEFAULT_CITY_EMOJI,
    photoCount: 12,
    theme: 'default',
  }
  const customs = getCustomCities()
  customs.push(customCity)
  setCustomCities(customs)
  return customCity
}

export async function addCityAsync(input: {
  name: string
  lat: number
  lon: number
  coverTitle?: string
  emoji?: string
}): Promise<{ city: CityRecord; cloudSaved: boolean }> {
  const city = addCity(input)
  if (!supabaseEnabled || !supabase) {
    return { city, cloudSaved: false }
  }
  const cloudSaved = await pushCustomCityToCloud(city)
  if (cloudSaved) {
    const cloudCustomCities = await pullCustomCitiesFromCloud()
    if (cloudCustomCities && cloudCustomCities.length > 0) {
      setCustomCities(cloudCustomCities)
    }
  }
  return { city, cloudSaved }
}

export function removeCity(cityId: string) {
  const id = cityId.trim().toLowerCase()
  if (!id) throw new Error('地点 id 不能为空')
  if (defaultCities.some((c) => c.id === id)) {
    throw new Error('默认城市不可删除')
  }
  const customs = getCustomCities()
  const next = customs.filter((c) => c.id !== id)
  if (next.length === customs.length) {
    throw new Error('未找到可删除的自定义城市')
  }
  setCustomCities(next)
}

export async function removeCityAsync(cityId: string) {
  removeCity(cityId)
  const cloudDeleted = await removeCustomCityFromCloud(cityId)
  if (!cloudDeleted) return
  const cloudCustomCities = await pullCustomCitiesFromCloud()
  if (cloudCustomCities !== null) {
    setCustomCities(cloudCustomCities)
  }
}
