# H3 Population Map (Astro + MapLibre)

Thematic H3 map with zoom-dependent resolution. Viewport H3 IDs (via **h3-js** / [vgrid-maplibre](https://github.com/opengeoshub/vgrid-maplibre) approach) are joined to population parquet and styled with a **Spectral** ramp.

## Setup

```bash
cd pop
npm install
# optional one-time index (faster API); also auto-built on first request
npm run index-pop
npm run dev
```

Open http://localhost:4321

## Data

Place files under `data/pop/`:

| Zoom | H3 res | Parquet | DuckDB cache |
|------|--------|---------|--------------|
| 0–8 (full table, cached) | 4 | `data/pop/h3_4.parquet` | `data/pop/h3_4_pop.duckdb` |
| 9 (viewport) | 5 | `data/pop/h3_5.parquet` | `data/pop/h3_5_pop.duckdb` |
| 10 (viewport) | 6 | `data/pop/h3_6.parquet` | `data/pop/h3_6_pop.duckdb` |
| 11 (viewport) | 7 | `data/pop/h3_7.parquet` | `data/pop/h3_7_pop.duckdb` |
| 12+ (viewport) | 8 | `data/pop/h3_8.parquet` | `data/pop/h3_8_pop.duckdb` |

Derived layers (DuckDB `h3_cell_to_parent` + `SUM`):

```bash
npm run aggregate-pop -- 5         # h3_6 → h3_5
npm run aggregate-pop -- 7         # h3_8 → h3_7
npm run index-pop -- 5 7           # build DuckDB indexes
```

## API

`POST /api/population` body: `{ "ids": ["84f…"], "resolution": 4 }` or `{ "bounds": {...}, "resolution": 6 }` or `{ "all": true, "resolution": 4 }` → `{ population, matched, requested|viewportIds, resolution }`
