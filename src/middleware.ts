import { defineMiddleware } from "astro:middleware";
import fs from "node:fs";
import { Readable } from "node:stream";
import { localParquetFile } from "./lib/dataDir";

/** Serve `data/{h3|a5|s2}/*.parquet` when present (local / own Node server). */
export const onRequest = defineMiddleware(async (context, next) => {
  const match = context.url.pathname.match(
    /^\/(h3|a5|s2)\/([^/]+\.parquet)$/,
  );
  if (!match) return next();

  const file = localParquetFile(match[1], decodeURIComponent(match[2]));
  if (!file) return next();

  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=3600",
    },
  });
});
