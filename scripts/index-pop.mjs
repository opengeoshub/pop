/**
 * Build DuckDB indexes for parquet files under data/{h3|a5|s2}/.
 * Default: data/h3, resolutions 4–8.
 *
 *   npm run index-pop
 *   npm run index-pop -- 5
 *   npm run index-pop -- 4 5 6 7 8
 *   npm run index-pop -- --dggs=a5
 *   npm run index-pop -- --dggs=s2
 *   npm run index-pop -- --dggs=a5,s2
 */
import duckdb from "duckdb";
import fs from "node:fs";
import path from "node:path";
import { DGGS, listDataDirs, parseDggsArg, parseResolutions } from "./dataDirs.mjs";

const { dggs: dggsList, rest } = parseDggsArg(process.argv.slice(2));

function run(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

let built = 0;

for (const dggs of dggsList) {
  const cfg = DGGS[dggs];
  const { resolutions: requested } = parseResolutions(rest, {
    defaultRes: cfg.indexDefaultRes,
  });
  const resolutions = requested.filter((n) => cfg.resolutions.includes(n));
  const folders = listDataDirs(dggs);

  for (const { dir, cellColumn } of folders) {
    const present = resolutions.filter((res) =>
      fs.existsSync(path.join(dir, `${cellColumn}_${res}.parquet`)),
    );
    if (present.length === 0) {
      console.warn(`[${dggs}] no matching parquet — skip`);
      continue;
    }

    console.log(`\n[${dggs}] ${dir}`);
    for (const res of present) {
      const parquet = path.join(dir, `${cellColumn}_${res}.parquet`);
      const dbPath = path.join(dir, `${cellColumn}_${res}.duckdb`);

      for (const p of [dbPath, dbPath + ".wal", dbPath + ".tmp"]) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }

      const parquetUri = parquet.replace(/\\/g, "/");
      console.log(`  Building r${res}:`, dbPath);

      const db = new duckdb.Database(dbPath);
      await run(
        db,
        `CREATE TABLE pop AS SELECT ${cellColumn}, population FROM read_parquet('${parquetUri}')`,
      );
      console.log(`    table created, indexing…`);
      await run(db, `CREATE INDEX idx_${cellColumn} ON pop(${cellColumn})`);
      await closeDb(db);
      console.log(`    done r${res}`);
      built++;
    }
  }
}

if (built === 0) {
  console.error("No parquet files indexed.");
  process.exit(1);
}

console.log("\nAll done.");
