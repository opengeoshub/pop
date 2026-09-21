// @ts-check
import { defineConfig } from "astro/config";
import { vite } from "./astro.vite.mjs";

/** Static UI for Cloudflare Pages. Native DuckDB stays on Render. */
export default defineConfig({
  output: "static",
  vite,
});
