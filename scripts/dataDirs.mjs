/**
 * Shared helpers for files under data/{h3|a5|s2}/.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_DATA_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../data",
);

/** H3 data root — kept for aggregate-pop and other h3-only callers. */
export const DATA_ROOT = path.join(PROJECT_DATA_ROOT, "h3");

export const DGGS = {
  h3: {
    id: "h3",
    cellColumn: "h3",
    resolutions: [4, 5, 6, 7, 8],
    stripDefaultRes: [4, 6, 8],
    indexDefaultRes: [4, 5, 6, 7, 8],
  },
  a5: {
    id: "a5",
    cellColumn: "a5",
    resolutions: [7],
    stripDefaultRes: [7],
    indexDefaultRes: [7],
  },
  s2: {
    id: "s2",
    cellColumn: "s2",
    resolutions: [8],
    stripDefaultRes: [8],
    indexDefaultRes: [8],
  },
};

/** True for leftover CLI tokens like 2022 / 2023 (not H3 resolutions 0–15). */
export function isYearToken(n) {
  return Number.isInteger(n) && n >= 1900 && n <= 2100;
}

/**
 * Pull --dggs=h3,a5 (or repeated --dggs flags) from argv.
 * Default is h3 so existing CLI commands stay unchanged.
 */
export function parseDggsArg(argv) {
  const ids = [];
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dggs" || a.startsWith("--dggs=")) {
      const raw = a.includes("=") ? a.split("=")[1] : argv[++i];
      if (raw == null || String(raw).trim() === "") {
        throw new Error("--dggs requires a value (h3, a5, s2)");
      }
      for (const part of String(raw).split(",")) {
        const id = part.trim().toLowerCase();
        if (!DGGS[id]) {
          throw new Error(`Unknown DGGS "${part}". Use h3, a5, or s2.`);
        }
        if (!ids.includes(id)) ids.push(id);
      }
      continue;
    }
    rest.push(a);
  }

  return { dggs: ids.length ? ids : ["h3"], rest };
}

/**
 * Resolution targets from argv. Year flags and 4-digit year tokens are ignored
 * (data lives in data/{dggs}/, not data/{dggs}/{year}/).
 */
export function parseResolutions(argv, { defaultRes = [] } = {}) {
  const resolutions = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--year" || a.startsWith("--year=")) {
      if (!a.includes("=")) i++;
      continue;
    }
    if (a.startsWith("--")) continue;
    const n = Number(a);
    if (!Number.isInteger(n) || isYearToken(n)) continue;
    resolutions.push(n);
  }

  return {
    resolutions: resolutions.length ? resolutions : defaultRes,
    resFromArgs: resolutions.length > 0,
  };
}

export function dataDirFor(dggs = "h3") {
  const cfg = DGGS[dggs];
  if (!cfg) throw new Error(`Unknown DGGS: ${dggs}`);
  return {
    dir: path.join(PROJECT_DATA_ROOT, dggs),
    dggs,
    cellColumn: cfg.cellColumn,
  };
}

/**
 * Single data folder: data/{dggs}/ (must exist).
 */
export function listDataDirs(dggs = "h3") {
  const { dir, cellColumn } = dataDirFor(dggs);
  if (!fs.existsSync(dir)) {
    throw new Error(`Missing data root: ${dir}`);
  }
  return [{ dir, dggs, cellColumn }];
}
