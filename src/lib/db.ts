import duckdb from "duckdb";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DGGS, type DggsId } from "./dggs";
import { parquetUrl, sqlQuoteId } from "./parquet";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = path.resolve(__dirname, "../../data");

type DuckDb = InstanceType<typeof duckdb.Database>;
type DuckConn = ReturnType<DuckDb["connect"]>;

type CacheStore = {
  conn: Promise<DuckConn> | null;
  tables: Map<string, Promise<{ cell: string; population: number }[]>>;
};

const g = globalThis as typeof globalThis & { __popNativeDuck?: CacheStore };
if (!g.__popNativeDuck) {
  g.__popNativeDuck = { conn: null, tables: new Map() };
}
const store = g.__popNativeDuck;

function all<T = Record<string, unknown>>(
  conn: DuckConn,
  sql: string,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    conn.all(sql, (err: Error | null, rows: T[]) => {
      if (err) reject(err);
      else resolve(rows ?? []);
    });
  });
}

function run(conn: DuckConn, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.run(sql, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function parquetSource(dggs: DggsId, res: number): string {
  const col = DGGS[dggs].cellColumn;
  const local = path.join(DATA_ROOT, dggs, `${col}_${res}.parquet`);
  if (fs.existsSync(local)) return local.replace(/\\/g, "/");
  return parquetUrl(dggs, res);
}

function openDatabase(): Promise<DuckDb> {
  return new Promise((resolve, reject) => {
    const db = new duckdb.Database(":memory:", (err: Error | null) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

async function getConn(): Promise<DuckConn> {
  if (!store.conn) {
    store.conn = (async () => {
      const db = await openDatabase();
      const conn = db.connect();
      await run(conn, "INSTALL httpfs");
      await run(conn, "LOAD httpfs");
      return conn;
    })().catch((err) => {
      store.conn = null;
      throw err;
    });
  }
  return store.conn;
}

function cacheKey(dggs: DggsId, res: number): string {
  return `${dggs}:${res}`;
}

async function queryPop(
  dggs: DggsId,
  resolution: number,
  whereSql = "",
): Promise<{ cell: string; population: number }[]> {
  const col = DGGS[dggs].cellColumn;
  const src = parquetSource(dggs, resolution);
  const conn = await getConn();
  return all<{ cell: string; population: number }>(
    conn,
    `SELECT ${col} AS cell, population FROM read_parquet('${src}')${whereSql}`,
  );
}

export async function lookupAllPopulation(
  resolution: number,
  dggs: DggsId = "h3",
): Promise<Record<string, number>> {
  const key = cacheKey(dggs, resolution);
  let promise = store.tables.get(key);
  if (!promise) {
    promise = queryPop(dggs, resolution).catch((err) => {
      store.tables.delete(key);
      throw err;
    });
    store.tables.set(key, promise);
  }
  const rows = await promise;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.cell] = Number(row.population);
  return out;
}

export async function lookupPopulation(
  ids: string[],
  resolution: number = 8,
  dggs: DggsId = "h3",
): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const idSet = new Set(ids);
  const tableRows = DGGS[dggs].tableRows[resolution] ?? ids.length * 2;
  if (ids.length >= tableRows / 2) {
    const allRows = await lookupAllPopulation(resolution, dggs);
    const out: Record<string, number> = {};
    for (const id of idSet) {
      if (id in allRows) out[id] = allRows[id];
    }
    return out;
  }

  const col = DGGS[dggs].cellColumn;
  const chunkSize = 2000;
  const idList = [...idSet];
  const out: Record<string, number> = {};
  for (let i = 0; i < idList.length; i += chunkSize) {
    const chunk = idList.slice(i, i + chunkSize);
    const placeholders = chunk.map(sqlQuoteId).join(",");
    const rows = await queryPop(
      dggs,
      resolution,
      ` WHERE ${col} IN (${placeholders})`,
    );
    for (const row of rows) out[row.cell] = Number(row.population);
  }
  return out;
}
