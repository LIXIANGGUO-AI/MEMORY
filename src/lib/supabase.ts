import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabaseEnabled = Boolean(supabaseUrl && supabaseAnonKey)

export const supabase =
  supabaseEnabled && supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null

if (import.meta.env.DEV) {
  if (supabaseEnabled && supabaseUrl) {
    try {
      const host = new URL(supabaseUrl).host
      console.info(
        `[memory] Supabase: ON → ${host}. 保存地点/相册时打开 Network，筛选「${host.split('.')[0]}」或 Fetch/XHR，应看到 ${host}/rest/v1/... 请求。`,
      )
    } catch {
      console.warn('[memory] Supabase: VITE_SUPABASE_URL 不是合法 URL')
    }
  } else {
    console.info(
      '[memory] Supabase: OFF — 根目录 .env 填写 VITE_SUPABASE_URL 与 VITE_SUPABASE_ANON_KEY 后重启 npm run dev。',
    )
  }
}
