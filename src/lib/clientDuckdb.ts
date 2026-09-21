import * as duckdb from "@duckdb/duckdb-wasm";
import { DGGS, type DggsId } from "./dggs";
import { localParquetUrl, parquetUrl, sqlQuoteId } from "./parquet";

export type PopRow = { hex: string; population: number };

type DuckHandle = {
  db: duckdb.AsyncDuckDB;
  conn: duckdb.AsyncDuckDBConnection;
};

let handlePromise: Promise<DuckHandle> | null = null;
const registered = new Set<string>();

async function getHandle(): Promise<DuckHandle> {
  if (!handlePromise) {
    handlePromise = (async () => {
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      const workerUrl = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker}");`], {
          type: "text/javascript",
        }),
      );
      const worker = new Worker(workerUrl);
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      URL.revokeObjectURL(workerUrl);
      const conn = await db.connect();
      return { db, conn };
    })().catch((err) => {
      handlePromise = null;
      throw err;
    });
  }
  return handlePromise;
}

function sqlQuote(id: string): string {
  return sqlQuoteId(id);
}

function asRows(
  table: {
    toArray: () => Array<
      { toJSON?: () => Record<string, unknown> } & Record<string, unknown>
    >;
  },
  col: string,
): PopRow[] {
  return table.toArray().map((row) => {
    const r = typeof row.toJSON === "function" ? row.toJSON() : row;
    return {
      hex: String(r[col] ?? r.hex ?? r.cell ?? ""),
      population: Number(r.population),
    };
  });
}

const PAR1 = [0x50, 0x41, 0x52, 0x31];

function isParquetBuffer(buf: Uint8Array): boolean {
  if (buf.byteLength < 8) return false;
  for (let i = 0; i < 4; i++) {
    if (buf[i] !== PAR1[i]) return false;
    if (buf[buf.byteLength - 4 + i] !== PAR1[i]) return false;
  }
  return true;
}

async function tryLoadParquet(url: string): Promise<Uint8Array | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const type = resp.headers.get("content-type") ?? "";
    if (type.includes("text/html")) return null;
    const buf = new Uint8Array(await resp.arrayBuffer());
    return isParquetBuffer(buf) ? buf : null;
  } catch {
    return null;
  }
}

/** Prefer same-origin `/h3/…` when it is real parquet; else R2. */
async function ensureParquet(dggs: DggsId, res: number): Promise<string> {
  const name = `${dggs}_${res}.parquet`;
  if (registered.has(name)) return name;

  const buf =
    (await tryLoadParquet(localParquetUrl(dggs, res))) ??
    (await tryLoadParquet(parquetUrl(dggs, res)));
  if (!buf) {
    throw new Error(
      `Could not fetch ${parquetUrl(dggs, res)}. AllowedOrigins must include this page origin.`,
    );
  }

  const { db } = await getHandle();
  await db.registerFileBuffer(name, buf);
  registered.add(name);
  return name;
}

async function queryParquet(sql: string, col: string): Promise<PopRow[]> {
  const { conn } = await getHandle();
  const table = await conn.query(sql);
  return asRows(table, col);
}

export async function lookupAllPopulation(
  dggs: DggsId,
  resolution: number,
): Promise<PopRow[]> {
  const col = DGGS[dggs].cellColumn;
  const file = await ensureParquet(dggs, resolution);
  return queryParquet(
    `SELECT ${col}, population FROM read_parquet('${file}')`,
    col,
  );
}

export async function lookupPopulation(
  dggs: DggsId,
  resolution: number,
  ids: string[],
): Promise<{ rows: PopRow[]; viewportIds: number }> {
  if (ids.length === 0) return { rows: [], viewportIds: 0 };

  const col = DGGS[dggs].cellColumn;
  const tableRows = DGGS[dggs].tableRows[resolution] ?? ids.length * 2;
  if (ids.length >= tableRows / 2) {
    const idSet = new Set(ids);
    const all = await lookupAllPopulation(dggs, resolution);
    return {
      rows: all.filter((row) => idSet.has(row.hex)),
      viewportIds: ids.length,
    };
  }

  const file = await ensureParquet(dggs, resolution);
  const chunkSize = 2000;
  const rows: PopRow[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const placeholders = chunk.map(sqlQuote).join(",");
    const part = await queryParquet(
      `SELECT ${col}, population FROM read_parquet('${file}') WHERE ${col} IN (${placeholders})`,
      col,
    );
    rows.push(...part);
  }
  return { rows, viewportIds: ids.length };
}
