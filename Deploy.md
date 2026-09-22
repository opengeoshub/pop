## Deploy

Split: **UI on Cloudflare Pages**, **Native DuckDB API on Render**.

### 1. Render (Native API only)

Push the repo to GitHub, then on [Render](https://render.com/docs/web-services):

1. **New → Blueprint** (uses `render.yaml`), or **New → Web Service** with Docker / `./Dockerfile`
2. Health check: `/api/population`
3. Note the URL, e.g. `https://pop.onrender.com`

### 2. Cloudflare Pages (UI)

In the Pages project (`pop-e7c` or a new one):

| Setting | Value |
|--------|--------|
| Build command | `npm install --omit=optional && npm run build:pages` |
| Output directory | `dist` |
| Environment variable | `PUBLIC_NATIVE_API_URL` = `https://<your-service>.onrender.com` |

`PUBLIC_NATIVE_API_URL` is inlined at **build** time. Redeploy Pages after the Render URL is known.

Or from this machine:

```powershell
$env:PUBLIC_NATIVE_API_URL="https://pop-e8ix.onrender.com"
npm run build:pages
npx wrangler pages deploy dist --project-name pop --commit-dirty=true
```

WASM talks to `parquet.gishub.vn` from the Pages origin (CORS). Native talks to Render.

If Native returns **403** from `parquet.gishub.vn`, Cloudflare [Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/) is blocking Render. It cannot be skipped per hostname. Either:

1. **gishub.vn** → Security → Bots → turn **Bot Fight Mode** off (and a Configuration Rule for `parquet.gishub.vn` with Browser Integrity Check / Hotlink Protection off), or
2. R2 bucket → enable [Public Development URL](https://developers.cloudflare.com/r2/buckets/public-buckets/) (`https://pub-….r2.dev`), set Render env `PARQUET_BASE` to that origin (no trailing slash), redeploy Render.

The Render Blueprint uses **Free** (512 MB, sleeps when idle). If Native OOMs, set `plan` to `starter` or `standard`.

Optional local parquet build scripts:

```bash
npm run aggregate-pop
npm run strip-parquet -- --dggs=a5,s2
```