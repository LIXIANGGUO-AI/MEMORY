export type GeocodeResult = {
  displayName: string
  lat: number
  lon: number
}

let lastRequestTs = 0

async function delay(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

export async function geocodePlaceName(query: string): Promise<GeocodeResult> {
  const q = query.trim()
  if (!q) throw new Error('请输入地点名')

  const now = Date.now()
  const elapsed = now - lastRequestTs
  if (elapsed < 1200) await delay(1200 - elapsed)
  lastRequestTs = Date.now()

  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('q', q)
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('limit', '1')
  url.searchParams.set('addressdetails', '0')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 9000)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`地理编码失败 (${res.status})`)
    const data = (await res.json()) as Array<{
      display_name?: string
      lat?: string
      lon?: string
    }>
    const first = data[0]
    if (!first?.lat || !first?.lon) throw new Error('未找到该地点，请换个名称')
    const lat = Number(first.lat)
    const lon = Number(first.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('坐标解析失败')
    return {
      displayName: first.display_name || q,
      lat,
      lon,
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('请求超时，请稍后再试')
    }
    throw err instanceof Error ? err : new Error('地理编码失败')
  } finally {
    clearTimeout(timeout)
  }
}
