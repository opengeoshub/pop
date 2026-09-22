# Population DGGS Map (Astro + MapLibre)

Thematic population map with a HUD switch between **H3**, **S2**, and **A5**, and an engine switch:

- **DuckDB WASM** — browser queries parquet (local files on this origin first, then the configured remote host).
- **DuckDB Native** — browser POSTs SQL/`lookup` to `/api/population` on the Node server.
- **Vector tile** / **None-geom tile** — H3 only.

## Setup

```bash
npm install
npx astro dev
```

Open http://localhost:4321 and pick **Engine**. Native needs this Node `astro dev` process. WASM runs in the browser.