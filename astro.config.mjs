// @ts-check
import { defineConfig } from "astro/config";

export default defineConfig({
  vite: {
    optimizeDeps: {
      exclude: ["@duckdb/duckdb-wasm", "maplibre-gl"],
      include: [
        "@deck.gl/core",
        "@deck.gl/layers",
        "@deck.gl/geo-layers",
        "@deck.gl/mapbox",
        "a5-js",
        "h3-js",
      ],
    },
    worker: {
      format: "es",
    },
  },
});
