/**
 * Aggregate a finer H3 parquet to a coarser resolution via DuckDB h3
 * (same idea as A5's a5_cell_to_parent + SUM).
 *
 * Default source = target + 1 (one-step rollup):
 *   npm run aggregate-pop              # 8 → 7
 *   npm run aggregate-pop -- 5         # 6 → 5
 *   npm run aggregate-pop -- 7 5       # 8→7 and 6→5
 *   npm run aggregate-pop -- 4 --from=6  # explicit source
 *
 * Then: npm run index-pop -- 5
 */
import duckdb from "duckdb";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../data/pop",
);

const args = process.argv.slice(2);
let fromOverride = null;
const positionals = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--from" || a.startsWith("--from=")) {
    fromOverride = Number(a.includes("=") ? a.split("=")[1] : args[++i]);
    continue;
  }
  const n = Number(a);
  if (Number.isInteger(n) && n >= 0 && n <= 15) positionals.push(n);
}

const DEFAULT_TARGETS = [7];
const targets = positionals.length ? positionals : DEFAULT_TARGETS;

function run(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function all(db, sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

/**
 * Roll up h3_{sourceRes} parquet to h3_{targetRes} with SUM(population).
 * Writes data/pop/h3_{targetRes}.parquet (does not build .duckdb — use index-pop).
 */
export async function aggregatePopFromSource(
  targetRes,
  {
    dataDir = DATA_DIR,
    sourceRes = targetRes + 1,
  } = {},
) {
  const sourceParquet = path.join(dataDir, `h3_${sourceRes}.parquet`);
  const outParquet = path.join(dataDir, `h3_${targetRes}.parquet`);
  const tmpParquet = path.join(dataDir, `h3_${targetRes}.agg.tmp.parquet`);

  if (!fs.existsSync(sourceParquet)) {
    throw new Error(`Missing source parquet: ${sourceParquet}`);
  }
  if (!(targetRes < sourceRes)) {
    throw new Error(
      `target resolution ${targetRes} must be coarser than source ${sourceRes}`,
    );
  }

  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(tmpParquet)) fs.unlinkSync(tmpParquet);

  const src = sourceParquet.replace(/\\/g, "/");
  const dest = tmpParquet.replace(/\\/g, "/");

  const db = new duckdb.Database(":memory:");
  try {
    console.log(
      `Aggregating h3_${sourceRes} → h3_${targetRes} (h3_cell_to_parent + SUM)…`,
    );
    await run(db, "INSTALL h3 FROM community");
    await run(db, "LOAD h3");

    await run(
      db,
      `COPY (
         SELECT
           h3_cell_to_parent(h3, ${targetRes}) AS h3,
           SUM(population)::DOUBLE AS population
         FROM read_parquet('${src}')
         GROUP BY 1
       ) TO '${dest}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );

    const [{ n }] = await all(
      db,
      `SELECT COUNT(*)::BIGINT AS n FROM read_parquet('${dest}')`,
    );
    console.log(`  rows: ${Number(n).toLocaleString()} → ${outParquet}`);

    if (fs.existsSync(outParquet)) fs.unlinkSync(outParquet);
    fs.renameSync(tmpParquet, outParquet);
  } finally {
    await new Promise((resolve, reject) => {
      db.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return outParquet;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  for (const target of targets) {
    const sourceRes = fromOverride ?? target + 1;
    await aggregatePopFromSource(target, { sourceRes });
  }
  console.log("All done. Next: npm run index-pop --", targets.join(" "));
}
