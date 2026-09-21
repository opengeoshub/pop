import duckdb from "duckdb";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { DGGS, type DggsId } from "./dggs";
import { localParquetFile } from "./dataDir";
import { parquetFileName, serverParquetUrl, sqlQuoteId } from "./parquet";

const CACHE_DIR = path.join(os.tmpdir(), "pop-parquet");
const downloads = new Map<string, Promise<string>>();

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

async function downloadParquet(url: string, dest: string): Promise<string> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.${process.pid}.part`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      Referer: "https://pop.gishub.vn/",
      Origin: "https://pop.gishub.vn",
      Accept: "application/octet-stream,*/*",
    },
    redirect: "follow",
  });
  if (!resp.ok || !resp.body) {
    const hint =
      resp.status === 403
        ? " Cloudflare Bot Fight cannot be skipped per-hostname. Turn it off on gishub.vn, or set PARQUET_BASE on Render to the bucket's r2.dev URL."
        : "";
    throw new Error(
      `Could not fetch ${url} (${resp.status} ${resp.statusText}).${hint}`,
    );
  }
  try {
    await pipeline(
      Readable.fromWeb(resp.body as import("node:stream/web").ReadableStream),
      fs.createWriteStream(part),
    );
    fs.renameSync(part, dest);
  } catch (err) {
    try {
      fs.unlinkSync(part);
    } catch {
      /* ignore */
    }
    throw err;
  }
  return dest.replace(/\\/g, "/");
}

/** Prefer `data/`, else download from R2 (`parquet.gishub.vn`) into /tmp. */
async function parquetSource(dggs: DggsId, res: number): Promise<string> {
  const name = parquetFileName(dggs, res);
  const local = localParquetFile(dggs, name);
  if (local) return local.replace(/\\/g, "/");

  const dest = path.join(CACHE_DIR, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return dest.replace(/\\/g, "/");
  }

  let pending = downloads.get(dest);
  if (!pending) {
    pending = downloadParquet(serverParquetUrl(dggs, res), dest).finally(() => {
      downloads.delete(dest);
    });
    downloads.set(dest, pending);
  }
  return pending;
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
      return db.connect();
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
  const src = await parquetSource(dggs, resolution);
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
