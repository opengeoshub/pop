export const vite = {
  optimizeDeps: {
    exclude: ["duckdb", "@duckdb/duckdb-wasm", "maplibre-gl"],
    include: [
      "@deck.gl/core",
      "@deck.gl/layers",
      "@deck.gl/geo-layers",
      "@deck.gl/mapbox",
      "a5-js",
      "h3-js",
    ],
  },
  ssr: {
    external: ["duckdb"],
  },
  worker: {
    format: "es",
  },
};
