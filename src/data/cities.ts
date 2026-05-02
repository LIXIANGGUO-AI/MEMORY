export type CityTheme = 'kyoto' | 'iceland' | 'paris' | 'new-york' | 'default'

export type CityRecord = {
  id: string
  name: string
  coverTitle: string
  lat: number
  lon: number
  emoji: string
  photoCount: number
  theme: CityTheme
}

export const DEFAULT_CITY_EMOJI = '📷✨🌙'

export const defaultCities: CityRecord[] = [
  // Intentionally empty: cities are user-managed via New Place.
]

export function titleFromId(id: string) {
  return id
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export function slugifyCityId(raw: string) {
  const ascii = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return ascii || `city-${Date.now()}`
}
