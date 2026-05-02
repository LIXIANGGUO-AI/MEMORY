# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

## Cloud persistence (step 1: cities)

The project now supports cloud-first city persistence via Supabase, with local storage fallback when Supabase is not configured.

1. Copy `.env.example` to `.env` and fill:

```bash
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

2. Create `cities` table in Supabase SQL editor:

```sql
create table if not exists public.cities (
  id text primary key,
  name text not null,
  cover_title text not null,
  lat double precision not null,
  lon double precision not null,
  emoji text,
  photo_count integer default 12,
  theme text default 'default'
);
```

After configuration, city add/delete/list operations sync through Supabase and persist across browser/device sessions.

3. **Photos, captions, and storage** (album sync across devices): run the following in the Supabase SQL editor.

Tables:

```sql
create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  city_id text not null,
  kind text not null check (kind in ('image', 'text')),
  storage_path text,
  text_body text,
  caption text not null default '',
  filter text not null default 'none',
  display_mode text not null default 'classic',
  aspect_ratio double precision not null default 1,
  pos_x double precision not null,
  pos_y double precision not null,
  base_rotate double precision not null,
  tape jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists photos_city_id_idx on public.photos (city_id);

create table if not exists public.album_captions (
  city_id text not null,
  item_id text not null,
  caption text not null,
  primary key (city_id, item_id)
);
```

Storage bucket (public read so images load in the app via `getPublicUrl`):

```sql
insert into storage.buckets (id, name, public)
values ('memory-photos', 'memory-photos', true)
on conflict (id) do nothing;
```

Row Level Security (no login — permissive policies for a single-owner personal deployment; your `anon` key is still visible in the built JS, so treat the project URL/key as sensitive):

```sql
alter table public.photos enable row level security;
alter table public.album_captions enable row level security;

drop policy if exists "photos_anon_all" on public.photos;
create policy "photos_anon_all" on public.photos for all using (true) with check (true);

drop policy if exists "album_captions_anon_all" on public.album_captions;
create policy "album_captions_anon_all" on public.album_captions for all using (true) with check (true);

drop policy if exists "memory_photos_select" on storage.objects;
drop policy if exists "memory_photos_insert" on storage.objects;
drop policy if exists "memory_photos_update" on storage.objects;
drop policy if exists "memory_photos_delete" on storage.objects;

create policy "memory_photos_select" on storage.objects for select using (bucket_id = 'memory-photos');
create policy "memory_photos_insert" on storage.objects for insert with check (bucket_id = 'memory-photos');
create policy "memory_photos_update" on storage.objects for update using (bucket_id = 'memory-photos');
create policy "memory_photos_delete" on storage.objects for delete using (bucket_id = 'memory-photos');
```

If you already use RLS on `cities`, add a similar all-in-one policy for `anon` or the app will not sync cities (see console for `[memory] Supabase` errors). Restart `npm run dev` after changing `.env`.

## Deploy (Vercel)

The repo includes [`vercel.json`](./vercel.json) so client-side routes work after refresh (SPA fallback).

1. Push this repository to GitHub.
2. On [Vercel](https://vercel.com) → **Add New Project** → import the repo.
3. Framework should detect **Vite**. Build: `npm run build`, output: `dist` (matches `vercel.json`).
4. Under **Environment Variables**, add the same keys as local `.env` (never commit `.env`):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
5. Deploy. After changing env vars on Vercel, trigger **Redeploy** so the build picks them up.

本地摘要：把仓库接到 Vercel → 在控制台填入上述两个 `VITE_` 变量（值与 Supabase 控制台一致）→ 部署完成后访问分配的 `.vercel.app` 域名即可；修改环境变量后需重新部署。
