# Population DGGS Map (Astro + MapLibre)

Thematic population map with a HUD switch between **H3**, **A5**, and **S2**, and a **DuckDB engine** switch:

- **DuckDB WASM** — browser queries `https://parquet.gishub.vn` (current Pages-friendly path). CORS required.
- **DuckDB Native** — `POST /api/population` uses Node DuckDB (`httpfs` parquet). On Cloudflare this runs in a **Container**.

## Setup

```bash
cd pop
npm install
npx astro dev
```

Open http://localhost:4321 and pick **Engine**. Native needs the Node server (this `astro dev`). WASM works in the browser.

## Data

| Zoom | Grid | URL |
|------|------|-----|
| 0–8 (full table, cached) | h3_4 | `https://parquet.gishub.vn/h3/h3_4.parquet` |
| 9 (viewport) | h3_5 | `https://parquet.gishub.vn/h3/h3_5.parquet` |
| 10 (viewport) | h3_6 | `https://parquet.gishub.vn/h3/h3_6.parquet` |
| 11 (viewport) | h3_7 | `https://parquet.gishub.vn/h3/h3_7.parquet` |
| 12+ (viewport) | h3_8 | `https://parquet.gishub.vn/h3/h3_8.parquet` |
| all zooms | a5_7 | `https://parquet.gishub.vn/a5/a5_7.parquet` |
| all zooms | s2_8 | `https://parquet.gishub.vn/s2/s2_8.parquet` |

Native also uses `data/{h3|a5|s2}/*.parquet` if those files exist locally.

## Deploy

**WASM-only (Cloudflare Pages):** the existing `pop-e7c.pages.dev` site. Native will fail there (no API).

**Native + WASM (Cloudflare Container)** — Docker must be running:

```bash
npx wrangler deploy
```

That builds `Dockerfile` (Node + native DuckDB) and a Worker that proxies to one warm container (`standard-2`, 6 GiB). First request may take a minute while the container starts.

Optional local parquet build scripts:

```bash
npm run aggregate-pop
npm run strip-parquet -- --dggs=a5,s2
```
