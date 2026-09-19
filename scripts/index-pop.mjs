/**
 * Build DuckDB indexes for h3_4 / h3_5 / h3_6 / h3_7 / h3_8 parquet files.
 * Usage: npm run index-pop
 *        npm run index-pop -- 5
 *        npm run index-pop -- 4 5 6 7 8
 */
import duckdb from "duckdb";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../data/pop",
);

const requested = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => n === 4 || n === 5 || n === 6 || n === 7 || n === 8);
const resolutions = (
  requested.length ? requested : [4, 5, 6, 7, 8]
).filter((res) => fs.existsSync(path.join(DATA_DIR, `h3_${res}.parquet`)));

if (resolutions.length === 0) {
  console.error("No parquet files found in", DATA_DIR);
  process.exit(1);
}

function run(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, (err) => (err ? reject(err) : resolve()));
  });
}

for (const res of resolutions) {
  const parquet = path.join(DATA_DIR, `h3_${res}.parquet`);
  const dbPath = path.join(DATA_DIR, `h3_${res}_pop.duckdb`);

  if (!fs.existsSync(parquet)) {
    console.error("Missing", parquet);
    process.exit(1);
  }

  for (const p of [dbPath, dbPath + ".wal", dbPath + ".tmp"]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  const parquetUri = parquet.replace(/\\/g, "/");
  console.log(`Building r${res}:`, dbPath);

  const db = new duckdb.Database(dbPath);
  await run(
    db,
    `CREATE TABLE pop AS SELECT h3, population FROM read_parquet('${parquetUri}')`,
  );
  console.log(`  table created, indexing…`);
  await run(db, "CREATE INDEX idx_h3 ON pop(h3)");
  await new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
  console.log(`  done r${res}`);
}

console.log("All done.");
