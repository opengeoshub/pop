// @ts-check
import { defineConfig } from "astro/config";
import { vite } from "./astro.vite.mjs";

const nativeApi =
  process.env.PUBLIC_NATIVE_API_URL?.trim() || "https://pop-e8ix.onrender.com";

/** Static UI for Cloudflare Pages. Native DuckDB stays on Render. */
export default defineConfig({
  output: "static",
  vite: {
    ...vite,
    define: {
      "import.meta.env.PUBLIC_NATIVE_API_URL": JSON.stringify(nativeApi),
    },
  },
});
