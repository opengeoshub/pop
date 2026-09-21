# Population DGGS Map (Astro + MapLibre)

Thematic population map with a HUD switch between **H3**, **A5**, and **S2**, and a **DuckDB engine** switch:

- **DuckDB WASM** — browser queries `https://parquet.gishub.vn` (current Pages-friendly path). CORS required.
- **DuckDB Native** — `POST /api/population` uses Node DuckDB (`httpfs` parquet). On [Render](https://render.com/) this runs in the Docker web service.

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

## Deploy (Render)

Native DuckDB needs a Node server, so this app deploys as a **Docker web service** on [Render](https://render.com/docs/web-services). Push the repo to GitHub first.

1. Open [Render](https://render.com/) and sign in.
2. **New → Blueprint** and connect this repo (`render.yaml`), **or** **New → Web Service**, connect the repo, and set:
   - Runtime: **Docker**
   - Dockerfile path: `./Dockerfile`
   - Health check: `/`
3. Create the service. Render builds the image (Node 22 + native DuckDB) and serves `https://<name>.onrender.com`.

The process listens on `0.0.0.0:$PORT` (Render default `10000`). Native queries `https://parquet.gishub.vn`. WASM still runs in the browser.

The Blueprint uses the **Free** instance (512 MB, spins down when idle). If Native OOMs or cold starts are too slow, change `plan` in `render.yaml` to `starter` or `standard` ([instance types](https://render.com/docs/web-services)).

Optional local parquet build scripts:

```bash
npm run aggregate-pop
npm run strip-parquet -- --dggs=a5,s2
```
