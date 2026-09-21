/**
 * Drop unused columns from parquet (keep cell id + population).
 * Default: data/h3, resolutions 4/6/8.
 * Always overwrites the original {h3|a5|s2}_*.parquet in place.
 * Temp files live under os.tmpdir() (not data/).
 *
 *   npm run strip-parquet
 *   npm run strip-parquet -- 4 6
 *   npm run strip-parquet -- --dggs=a5
 *   npm run strip-parquet -- --dggs=s2
 *   npm run strip-parquet -- --dggs=a5,s2
 */
import duckdb from "duckdb";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DGGS, listDataDirs, parseDggsArg, parseResolutions } from "./dataDirs.mjs";

const { dggs: dggsList, rest } = parseDggsArg(process.argv.slice(2));

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

function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tryUnlink(file) {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return !fs.existsSync(file);
  } catch {
    return false;
  }
}

/** Overwrite dest with tmp; retry briefly (Windows file locks). */
async function overwriteInPlace(tmp, dest) {
  let lastErr;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      fs.copyFileSync(tmp, dest);
      tryUnlink(tmp);
      return;
    } catch (err) {
      lastErr = err;
      if (err.code !== "EBUSY" && err.code !== "EPERM" && err.code !== "EACCES") {
        throw err;
      }
    }
    try {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      fs.renameSync(tmp, dest);
      return;
    } catch (err2) {
      lastErr = err2;
    }
    await sleep(150 * attempt);
  }
  throw lastErr;
}

let stripped = 0;

for (const dggs of dggsList) {
  const cfg = DGGS[dggs];
  const { resolutions: requested } = parseResolutions(rest, {
    defaultRes: cfg.stripDefaultRes,
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

    for (const res of present) {
      tryUnlink(path.join(dir, `${cellColumn}_${res}.strip-src.tmp.parquet`));
      tryUnlink(path.join(dir, `${cellColumn}_${res}.stripped.tmp.parquet`));
      tryUnlink(path.join(dir, `${cellColumn}_${res}.stripped.parquet`));
      tryUnlink(path.join(dir, `${cellColumn}_${res}.new.parquet`));
    }

    console.log(`\n[${dggs}] ${dir}`);
    for (const res of present) {
      const parquet = path.join(dir, `${cellColumn}_${res}.parquet`);
      const tmp = path.join(
        os.tmpdir(),
        `${cellColumn}-pop-strip-r${res}-${process.pid}.parquet`,
      );

      console.log(`  Stripping r${res}:`, parquet);
      tryUnlink(tmp);

      const db = new duckdb.Database(":memory:");
      try {
        const src = parquet.replace(/\\/g, "/");
        const dest = tmp.replace(/\\/g, "/");

        await run(
          db,
          `COPY (SELECT ${cellColumn}, population FROM read_parquet('${src}'))
           TO '${dest}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
        );

        const cols = await all(
          db,
          `DESCRIBE SELECT * FROM read_parquet('${dest}')`,
        );
        console.log(
          `    columns:`,
          cols.map((r) => r.column_name).join(", "),
        );
      } finally {
        await closeDb(db);
      }

      await overwriteInPlace(tmp, parquet);
      tryUnlink(tmp);
      console.log(`    replaced`, parquet);
      stripped++;
    }
  }
}

if (stripped === 0) {
  console.error("No parquet files stripped.");
  process.exit(1);
}

console.log("\nAll done.");
