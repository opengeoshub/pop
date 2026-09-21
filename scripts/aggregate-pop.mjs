/**
 * Aggregate a finer H3 parquet to a coarser resolution via DuckDB h3
 * (parent cell + SUM of numeric columns; keeps remaining source columns).
 * Parent geometry uses GeoLibre's antimeridian unwrap (lng < -130 → shift
 * positive longitudes by -360).
 *
 * Runs over data/h3/. Default targets: h3_8 → h3_7 and h3_6 → h3_5.
 *
 *   npm run aggregate-pop                    # 8→7, 6→5
 *   npm run aggregate-pop -- 5               # 6→5
 *   npm run aggregate-pop -- 7 5             # 8→7 and 6→5
 *   npm run aggregate-pop -- 4 --from=6      # explicit source
 *
 * Then: npm run index-pop -- 5 7
 */
import duckdb from "duckdb";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listDataDirs, parseResolutions } from "./dataDirs.mjs";

const args = process.argv.slice(2);
let fromOverride = null;
const filteredArgs = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--from" || a.startsWith("--from=")) {
    fromOverride = Number(a.includes("=") ? a.split("=")[1] : args[++i]);
    continue;
  }
  filteredArgs.push(a);
}

const DEFAULT_TARGETS = [7, 5];
const { resolutions: targets } = parseResolutions(filteredArgs, {
  defaultRes: DEFAULT_TARGETS,
});

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

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function isNumericType(columnType) {
  const base = String(columnType)
    .toUpperCase()
    .replace(/\s+/g, " ")
    .split("(")[0]
    .trim();
  return (
    base === "TINYINT" ||
    base === "SMALLINT" ||
    base === "INTEGER" ||
    base === "INT" ||
    base === "BIGINT" ||
    base === "HUGEINT" ||
    base === "UTINYINT" ||
    base === "USMALLINT" ||
    base === "UINTEGER" ||
    base === "UBIGINT" ||
    base === "UHUGEINT" ||
    base === "FLOAT" ||
    base === "FLOAT4" ||
    base === "FLOAT8" ||
    base === "DOUBLE" ||
    base === "REAL" ||
    base === "DECIMAL" ||
    base === "NUMERIC"
  );
}

/**
 * Parse h3_cell_to_boundary_wkt into [{lng, lat}, ...].
 * Same vertex order as DuckDB h3; longitudes still in [-180, 180].
 */
function h3RawRingSql(cellExpr) {
  return `list_transform(
          string_split(
            replace(replace(h3_cell_to_boundary_wkt(${cellExpr}), 'POLYGON ((', ''), '))', ''),
            ', '
          ),
          pair -> struct_pack(
            lng := CAST(split_part(pair, ' ', 1) AS DOUBLE),
            lat := CAST(split_part(pair, ' ', 2) AS DOUBLE)
          )
        )`;
}

/**
 * Same rule as GeoLibre h3FixTransmeridianBoundary: if any vertex is west of
 * -130°, shift every positive longitude down by 360° so the ring stays
 * contiguous around -180 instead of wrapping the long way across the map.
 */
const H3_FIXED_RING_SQL = `CASE
          WHEN list_bool_or(list_transform(raw_ring, r -> r.lng < -130))
          THEN list_transform(
            raw_ring,
            r -> struct_pack(
              lng := CASE WHEN r.lng > 0 THEN r.lng - 360 ELSE r.lng END,
              lat := r.lat
            )
          )
          ELSE raw_ring
        END`;

function h3FixedGeometrySql() {
  return `CAST(ST_AsWKB(
          ST_GeomFromText(
            'POLYGON ((' || array_to_string(
              list_transform(
                fixed_ring,
                r -> CAST(r.lng AS VARCHAR) || ' ' || CAST(r.lat AS VARCHAR)
              ),
              ', '
            ) || '))'
          )
        ) AS BLOB)`;
}

function h3FixedBboxSql() {
  return `STRUCT_PACK(
          xmin := list_min(list_transform(fixed_ring, r -> r.lng))::FLOAT,
          ymin := list_min(list_transform(fixed_ring, r -> r.lat))::FLOAT,
          xmax := list_max(list_transform(fixed_ring, r -> r.lng))::FLOAT,
          ymax := list_max(list_transform(fixed_ring, r -> r.lat))::FLOAT
        )`;
}

/**
 * Roll up h3_{sourceRes} parquet to h3_{targetRes}.
 * Groups by parent H3, SUMs numeric columns, rebuilds parent geometry with the
 * GeoLibre antimeridian fix, and keeps remaining columns (MIN fid, ANY_VALUE else).
 * Writes data/h3/h3_{targetRes}.parquet (does not build .duckdb — use index-pop).
 */
export async function aggregatePopFromSource(
  targetRes,
  {
    dataDir,
    sourceRes = targetRes + 1,
  } = {},
) {
  if (!dataDir) throw new Error("dataDir is required");

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
      `  Aggregating h3_${sourceRes} → h3_${targetRes} (all columns, antimeridian-fixed geometry)…`,
    );
    await run(db, "INSTALL h3 FROM community");
    await run(db, "LOAD h3");

    const schema = await all(
      db,
      `DESCRIBE SELECT * FROM read_parquet('${src}')`,
    );
    if (!schema.some((c) => c.column_name === "h3")) {
      throw new Error(`Source parquet has no h3 column: ${sourceParquet}`);
    }

    const needsGeometry = schema.some((c) => c.column_name === "geometry");
    const needsBbox = schema.some((c) => c.column_name === "geometry_bbox");
    const needsBoundary = needsGeometry || needsBbox;
    if (needsGeometry) {
      await run(db, "INSTALL spatial");
      await run(db, "LOAD spatial");
    }

    const innerSelects = [];
    const outerSelects = [];
    for (const col of schema) {
      const name = col.column_name;
      const q = quoteIdent(name);
      const type = col.column_type;

      if (name === "h3") {
        innerSelects.push(
          `h3_cell_to_parent(src.h3, ${targetRes}) AS parent_h3`,
        );
        outerSelects.push("parent_h3 AS h3");
        continue;
      }
      if (name === "geometry") {
        outerSelects.push(`${h3FixedGeometrySql()} AS ${q}`);
        continue;
      }
      if (name === "geometry_bbox") {
        outerSelects.push(`${h3FixedBboxSql()} AS ${q}`);
        continue;
      }
      if (name === "fid") {
        innerSelects.push(`MIN(src.${q}) AS ${q}`);
        outerSelects.push(q);
        continue;
      }
      if (isNumericType(type)) {
        innerSelects.push(`SUM(src.${q})::${type} AS ${q}`);
      } else {
        innerSelects.push(`ANY_VALUE(src.${q}) AS ${q}`);
      }
      outerSelects.push(q);
    }

    const groupedSql = `SELECT
             ${innerSelects.join(",\n             ")}
           FROM read_parquet('${src}') AS src
           GROUP BY parent_h3`;
    const fromSql = needsBoundary
      ? `(
           SELECT
             grouped.*,
             ${H3_FIXED_RING_SQL} AS fixed_ring
           FROM (
             SELECT
               agg.*,
               ${h3RawRingSql("agg.parent_h3")} AS raw_ring
             FROM (
               ${groupedSql}
             ) agg
           ) grouped
         ) shaped`
      : `(
           ${groupedSql}
         )`;

    await run(
      db,
      `COPY (
         SELECT ${outerSelects.join(", ")} FROM ${fromSql}
       ) TO '${dest}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );

    const [{ n }] = await all(
      db,
      `SELECT COUNT(*)::BIGINT AS n FROM read_parquet('${dest}')`,
    );
    const outCols = await all(
      db,
      `DESCRIBE SELECT * FROM read_parquet('${dest}')`,
    );
    console.log(
      `    columns: ${outCols.map((c) => c.column_name).join(", ")}`,
    );
    console.log(`    rows: ${Number(n).toLocaleString()} → ${outParquet}`);

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
  const folders = listDataDirs("h3");

  console.log(`targets: ${targets.join(", ")}`);

  const indexedTargets = new Set();

  for (const { dir } of folders) {
    console.log(`\n${dir}`);
    for (const target of targets) {
      const sourceRes = fromOverride ?? target + 1;
      const sourceParquet = path.join(dir, `h3_${sourceRes}.parquet`);
      if (!fs.existsSync(sourceParquet)) {
        console.warn(
          `  skip h3_${sourceRes} → h3_${target}: missing ${path.basename(sourceParquet)}`,
        );
        continue;
      }
      await aggregatePopFromSource(target, { dataDir: dir, sourceRes });
      indexedTargets.add(target);
    }
  }

  console.log(
    "\nAll done. Next: npm run index-pop --",
    [...indexedTargets].sort((a, b) => a - b).join(" "),
  );
}
