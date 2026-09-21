// @ts-check
import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vite } from "./astro.vite.mjs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const localPopStyles = path.resolve(rootDir, "../vstyles/vstyles/pop");

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

/** Serve sibling vstyles/pop JSON during `astro dev` (palette styles are not on GitHub yet). */
function vstylesPopDev() {
  return {
    name: "vstyles-pop-dev",
    hooks: {
      "astro:server:setup": ({ server }) => {
        server.middlewares.use((req, res, next) => {
          const url = req.url?.split("?")[0] ?? "";
          const match = /^\/vstyles\/pop\/([A-Za-z0-9_-]+\.json)$/.exec(url);
          if (!match) {
            next();
            return;
          }
          const file = path.join(localPopStyles, match[1]);
          if (!file.startsWith(localPopStyles) || !fs.existsSync(file)) {
            res.statusCode = 404;
            res.end("Not found");
            return;
          }
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          fs.createReadStream(file).pipe(res);
        });
      },
    },
  };
}

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [nativePopulationApi(), vstylesPopDev()],
  vite,
});
