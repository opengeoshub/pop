import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo `data/` on disk (local / your Node server). Missing → caller uses R2. */
export function resolveDataRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "data"),
    path.resolve(here, "../../data"),
    path.resolve(here, "../../../data"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0];
}

export function localParquetFile(dggs: string, fileName: string): string | null {
  const file = path.join(resolveDataRoot(), dggs, fileName);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  return null;
}
