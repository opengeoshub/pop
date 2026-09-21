// @ts-check
import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import { vite } from "./astro.vite.mjs";

/** Native DuckDB API for local `astro dev` and the Render Docker service. */
function nativePopulationApi() {
  return {
    name: "native-population-api",
    hooks: {
      "astro:config:setup": ({ injectRoute }) => {
        injectRoute({
          pattern: "/api/population",
          entrypoint: "./src/lib/populationRoute.ts",
        });
      },
    },
  };
}

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [nativePopulationApi()],
  vite,
});
