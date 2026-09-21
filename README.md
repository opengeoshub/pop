# Population DGGS Map (Astro + MapLibre)

Thematic population map with a HUD switch between **H3** (hexagons), **A5** (pentagons), and **S2**. The browser loads parquet through **duckdb-wasm** from `https://parquet.gishub.vn`. H3 uses zoom-dependent resolution; A5 loads the full `a5_7` table; S2 loads the full `s2_8` table.

## Setup

```bash
cd pop
npm install
npx astro dev
```

Open http://localhost:4321

The R2 bucket must send `Access-Control-Allow-Origin` (and allow `Range`) so the browser can read parquet.

## Data

Parquet URLs (no year folder, no `.duckdb` at runtime):

| Zoom | Grid | URL |
|------|------|-----|
| 0–8 (full table, cached) | h3_4 | `https://parquet.gishub.vn/h3/h3_4.parquet` |
| 9 (viewport) | h3_5 | `https://parquet.gishub.vn/h3/h3_5.parquet` |
| 10 (viewport) | h3_6 | `https://parquet.gishub.vn/h3/h3_6.parquet` |
| 11 (viewport) | h3_7 | `https://parquet.gishub.vn/h3/h3_7.parquet` |
| 12+ (viewport) | h3_8 | `https://parquet.gishub.vn/h3/h3_8.parquet` |
| all zooms | a5_7 | `https://parquet.gishub.vn/a5/a5_7.parquet` |
| all zooms | s2_8 | `https://parquet.gishub.vn/s2/s2_8.parquet` |

Optional local scripts (still use native DuckDB) if you are building those parquet files:

```bash
npm run aggregate-pop              # h3_8 → h3_7, h3_6 → h3_5
npm run strip-parquet -- --dggs=a5,s2
```

The HUD **DGGS** control switches between H3, A5, and S2.

## Deploy (Cloudflare Pages)

The app is a static build. Parquet stays on R2 (`parquet.gishub.vn`); do not put `data/` in git. DuckDB wasm is loaded from jsDelivr (Cloudflare Pages rejects files over 25 MB).

```bash
npm run deploy
```

That runs `astro build` and `wrangler pages deploy dist --project-name pop`.

Or in the Cloudflare dashboard: Workers & Pages → Create → Pages → Connect `opengeoshub/pop`:

| Setting | Value |
|---------|--------|
| Framework | Astro |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node version | `22.12.0` (from `.nvmrc`) |

Then Custom domains → `pop.gishub.vn`. CORS on the parquet bucket already allows that origin.

