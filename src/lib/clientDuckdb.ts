import * as duckdb from "@duckdb/duckdb-wasm";
import { DGGS, type DggsId } from "./dggs";
import { parquetUrl, sqlQuoteId } from "./parquet";

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

/** Fetch on the page origin (CORS works). Worker XHR from read_parquet(https://…) does not. */
async function ensureParquet(dggs: DggsId, res: number): Promise<string> {
  const name = `${dggs}_${res}.parquet`;
  if (registered.has(name)) return name;

  const url = parquetUrl(dggs, res);
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch {
    throw new Error(
      `Could not fetch ${url}. AllowedOrigins must include this page origin (http://localhost:4321 in dev).`,
    );
  }
  if (!resp.ok) {
    throw new Error(`Parquet not found: ${url} (${resp.status})`);
  }

  const { db } = await getHandle();
  await db.registerFileBuffer(name, new Uint8Array(await resp.arrayBuffer()));
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
