/**
 * Drop unused columns from parquet (keep h3, population).
 * Usage: npm run strip-parquet
 *        npm run strip-parquet -- 4 6
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
  .filter((n) => n === 4 || n === 6 || n === 8);
const resolutions = requested.length ? requested : [4, 6, 8];

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

const db = new duckdb.Database(":memory:");

for (const res of resolutions) {
  const parquet = path.join(DATA_DIR, `h3_${res}.parquet`);
  const tmp = path.join(DATA_DIR, `h3_${res}.stripped.parquet`);

  if (!fs.existsSync(parquet)) {
    console.error("Missing", parquet);
    process.exit(1);
  }

  const src = parquet.replace(/\\/g, "/");
  const dest = tmp.replace(/\\/g, "/");

  console.log(`Stripping r${res}:`, parquet);
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

  await run(
    db,
    `COPY (SELECT h3, population FROM read_parquet('${src}'))
     TO '${dest}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
  );

  const cols = await all(db, `DESCRIBE SELECT * FROM read_parquet('${dest}')`);
  console.log(
    `  columns:`,
    cols.map((r) => r.column_name).join(", "),
  );

  // Prefer in-place replace; if Windows locks the file, leave *.new.parquet
  try {
    fs.unlinkSync(parquet);
    fs.renameSync(tmp, parquet);
    console.log(`  replaced`, parquet);
  } catch (err) {
    if (err.code !== "EBUSY" && err.code !== "EPERM") throw err;
    const fallback = path.join(DATA_DIR, `h3_${res}.new.parquet`);
    if (fs.existsSync(fallback)) fs.unlinkSync(fallback);
    fs.renameSync(tmp, fallback);
    console.warn(
      `  locked ${path.basename(parquet)} — wrote ${path.basename(fallback)}; close any open handles then rename manually`,
    );
  }
}

await new Promise((resolve, reject) => {
  db.close((err) => (err ? reject(err) : resolve()));
});
console.log("All done.");
