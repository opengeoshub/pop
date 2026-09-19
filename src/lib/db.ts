import duckdb from "duckdb";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { H3PopResolution } from "./h3Viewport";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Project-root `data/pop` (parquet + DuckDB indexes) */
const DATA_DIR = path.resolve(__dirname, "../../data/pop");

/** Approx row counts — used to choose scan-vs-IN strategy */
const TABLE_ROWS: Record<H3PopResolution, number> = {
  4: 71_283,
  5: 288_000, // ~h3_6 / 7 after aggregate; refine after first build
  6: 2_016_971,
  7: 4_700_000, // ~h3_8 / 7 after aggregate; refine after first build
  8: 32_957_699,
};

type DuckDb = InstanceType<typeof duckdb.Database>;
type DuckConn = ReturnType<DuckDb["connect"]>;

function run(
  target: DuckDb | DuckConn,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  return new Promise((resolve, reject) => {
    target.run(sql, ...params, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function all<T = Record<string, unknown>>(
  conn: DuckConn,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    conn.all(sql, ...params, (err: Error | null, rows: T[]) => {
      if (err) reject(err);
      else resolve(rows ?? []);
    });
  });
}

function pathsFor(res: H3PopResolution) {
  return {
    parquet: path.join(DATA_DIR, `h3_${res}.parquet`),
    duckdb: path.join(DATA_DIR, `h3_${res}_pop.duckdb`),
  };
}

const caches = new Map<
  H3PopResolution,
  Promise<{ db: DuckDb; conn: DuckConn }>
>();

/** Full-table cache for small datasets (r4) */
const fullTableCache = new Map<
  H3PopResolution,
  Promise<{ h3: string; population: number }[]>
>();

async function ensureIndex(
  db: DuckDb,
  res: H3PopResolution,
  parquetPath: string,
): Promise<void> {
  const conn = db.connect();
  try {
    await all(conn, "SELECT 1 FROM pop LIMIT 1");
    conn.close();
    return;
  } catch {
    conn.close();
  }

  if (!fs.existsSync(parquetPath)) {
    throw new Error(`Missing parquet: ${parquetPath}`);
  }

  const parquetUri = parquetPath.replace(/\\/g, "/");
  console.log(
    `[h3-pop] Building DuckDB index for r${res} from parquet (one-time)...`,
  );
  await run(
    db,
    `CREATE TABLE pop AS SELECT h3, population FROM read_parquet('${parquetUri}')`,
  );
  await run(db, "CREATE INDEX idx_h3 ON pop(h3)");
  console.log(`[h3-pop] DuckDB index r${res} ready`);
}

async function getConn(res: H3PopResolution): Promise<DuckConn> {
  let promise = caches.get(res);
  if (!promise) {
    promise = (async () => {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const { parquet, duckdb: duckPath } = pathsFor(res);
      const needsBuild = !fs.existsSync(duckPath);
      const db = new duckdb.Database(
        duckPath,
        needsBuild ? undefined : { access_mode: "READ_ONLY" },
      );
      await ensureIndex(db, res, parquet);
      const conn = db.connect();
      return { db, conn };
    })().catch((err) => {
      caches.delete(res);
      throw err;
    });
    caches.set(res, promise);
  }
  const { conn } = await promise;
  return conn;
}

export function parseResolution(value: unknown): H3PopResolution | null {
  const n = Number(value);
  if (n === 4 || n === 5 || n === 6 || n === 7 || n === 8) return n;
  return null;
}

async function loadFullTable(
  resolution: H3PopResolution,
): Promise<{ h3: string; population: number }[]> {
  let promise = fullTableCache.get(resolution);
  if (!promise) {
    promise = (async () => {
      const conn = await getConn(resolution);
      return all<{ h3: string; population: number }>(
        conn,
        "SELECT h3, population FROM pop",
      );
    })().catch((err) => {
      fullTableCache.delete(resolution);
      throw err;
    });
    fullTableCache.set(resolution, promise);
  }
  return promise;
}

/**
 * Return every row in the population table (used at zoom 0 for h3_4).
 */
export async function lookupAllPopulation(
  resolution: H3PopResolution,
): Promise<Record<string, number>> {
  const rows = await loadFullTable(resolution);
  const out: Record<string, number> = {};
  for (const row of rows) {
    out[row.h3] = Number(row.population);
  }
  return out;
}

/**
 * Intersect viewport H3 IDs with parquet population.
 * When the ID list is larger than ~half the table, scan + filter by Set.
 */
export async function lookupPopulation(
  ids: string[],
  resolution: H3PopResolution = 8,
): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const idSet = new Set(ids);
  const tableRows = TABLE_ROWS[resolution];
  const preferScan = ids.length >= tableRows / 2;

  const out: Record<string, number> = {};

  if (preferScan) {
    const rows = await loadFullTable(resolution);
    for (const row of rows) {
      if (idSet.has(row.h3)) out[row.h3] = Number(row.population);
    }
    return out;
  }

  const conn = await getConn(resolution);
  const chunkSize = 2000;
  const idList = [...idSet];
  for (let i = 0; i < idList.length; i += chunkSize) {
    const chunk = idList.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await all<{ h3: string; population: number }>(
      conn,
      `SELECT h3, population FROM pop WHERE h3 IN (${placeholders})`,
      chunk,
    );
    for (const row of rows) {
      out[row.h3] = Number(row.population);
    }
  }

  return out;
}
