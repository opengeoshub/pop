export const vite = {
  server: {
    proxy: {
      "/pmtiles": {
        target: "https://tiles.gishub.vn",
        changeOrigin: true,
        secure: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ["duckdb", "@duckdb/duckdb-wasm"],
    include: [
      "@deck.gl/core",
      "@deck.gl/layers",
      "@deck.gl/geo-layers",
      "@deck.gl/mapbox",
      "a5-js",
      "h3-js",
      "@mapbox/vector-tile",
      "pbf",
    ],
  },
  ssr: {
    external: ["duckdb"],
  },
  worker: {
    format: "es",
  },
};
