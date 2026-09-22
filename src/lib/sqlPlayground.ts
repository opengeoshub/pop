import { DGGS, parseDggs, type DggsId } from "./dggs";

export type SqlPopRow = { hex: string; population: number };

/** Default playground query — same idea as A5 `a5_cell_to_parent` + SUM. */
export function defaultAggregateSql(dggs: DggsId): string {
  if (dggs === "a5") {
    return `SELECT
  a5_cell_to_parent(hex_to_int(a5), 6)
  AS a5,
  SUM(population) AS population
FROM a5_7
GROUP BY 1`;
  }
  if (dggs === "s2") {
    return `SELECT
  s2_cell_to_parent(s2, 7) AS s2,
  SUM(population) AS population
FROM s2_8
GROUP BY 1`;
  }
  return `SELECT
  h3_cell_to_parent(h3, 3) AS h3,
  SUM(population) AS population
FROM h3_4
GROUP BY 1`;
}

/** SQL shown on load and whenever the DGGS dropdown changes. */
export function defaultDggsSql(dggs: DggsId): string {
  const col = DGGS[dggs].cellColumn;
  const res = DGGS[dggs].adaptiveResolution;
  return `SELECT ${col}, population
FROM ${dggs}_${res}`;
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/;+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** True when the query is a full h3_4 table load — map should stay adaptive. */
export function isAdaptiveH3Sql(sql: string): boolean {
  const s = normalizeSql(sql);
  if (s === normalizeSql(defaultDggsSql("h3"))) return true;
  return /^select (h3, population|population, h3|\*) from h3_4$/.test(s);
}

const SQL_KEYWORDS = new Set(
  `select from where group order by having join using in as with values and or not limit union all on case when then else end distinct create table between like is null`.split(
    /\s+/,
  ),
);
const SQL_TOKEN =
  /--[^\n]*|'(?:[^']|'')*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b/g;
const SQL_AGGS = /^(sum|avg|min|max|count|round|unnest|list|len)$/i;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** GitHub-light highlighting, same idea as the A5 DuckDB playground. */
export function highlightSqlHtml(sql: string): string {
  const out: string[] = [];
  let last = 0;
  SQL_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SQL_TOKEN.exec(sql))) {
    if (match.index > last) out.push(escapeHtml(sql.slice(last, match.index)));
    const token = match[0];
    let cls = "";
    if (token.startsWith("--")) cls = "sql-cmt";
    else if (token.startsWith("'")) cls = "sql-str";
    else if (/^\d/.test(token)) cls = "sql-num";
    else if (SQL_KEYWORDS.has(token.toLowerCase())) cls = "sql-kw";
    else if (/^(h3_|a5_|s2_)/i.test(token)) cls = "sql-fn";
    else if (SQL_AGGS.test(token)) cls = "sql-agg";
    const safe = escapeHtml(token);
    out.push(cls ? `<span class="${cls}">${safe}</span>` : safe);
    last = match.index + token.length;
  }
  if (last < sql.length) out.push(escapeHtml(sql.slice(last)));
  return `${out.join("")}\n`;
}

export function isSafeSelectSql(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  if (!/^(with|select)\b/i.test(stripped)) return false;
  const withoutTrailing = stripped.replace(/;+\s*$/, "");
  return !withoutTrailing.includes(";");
}

export function sqlNeedsH3Extension(sql: string): boolean {
  return /\bh3_(cell_to_parent|h3_to_string|string_to_h3|latlng_to_cell)\b/i.test(
    sql,
  );
}

export function sqlNeedsA5Extension(sql: string): boolean {
  return /\ba5_(cell_to_parent|uncompact|spherical_cap|lonlat_to_cell)\b/i.test(
    sql,
  );
}

export const HEX_TO_INT_MACRO =
  "CREATE OR REPLACE MACRO hex_to_int(s) AS CAST('0x' || CAST(s AS VARCHAR) AS UBIGINT)";

/** Parent S2 hex token at `level` — same idea as `h3_cell_to_parent` / `a5_cell_to_parent`. */
export const S2_CELL_TO_PARENT_MACRO = `CREATE OR REPLACE MACRO s2_cell_to_parent(token, level) AS (
  regexp_replace(
    lower(lpad(to_hex(
      (
        (CAST('0x' || rpad(lower(CAST(token AS VARCHAR)), 16, '0') AS UBIGINT)
          & ~((1::UBIGINT << (2 * (30 - CAST(level AS INTEGER)))) - 1)
        )
        | (1::UBIGINT << (2 * (30 - CAST(level AS INTEGER))))
      )
    ), 16, '0')),
    '0+$',
    ''
  )
)`;

const TABLE_RE = /\b(?:from|join)\s+([a-z][a-z0-9_]*)/gi;

export function tablesReferenced(sql: string): { dggs: DggsId; res: number }[] {
  const found: { dggs: DggsId; res: number }[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  TABLE_RE.lastIndex = 0;
  while ((match = TABLE_RE.exec(sql))) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    const parts = name.split("_");
    if (parts.length !== 2) continue;
    const dggs = parseDggs(parts[0]);
    const res = Number(parts[1]);
    if (!dggs || !Number.isInteger(res) || !DGGS[dggs].isResolution(res)) {
      continue;
    }
    found.push({ dggs, res });
  }
  return found;
}

export function inferDggsFromSql(sql: string): DggsId | null {
  const tables = tablesReferenced(sql);
  if (tables[0]) return tables[0].dggs;
  if (/\ba5\b/i.test(sql)) return "a5";
  if (/\bs2\b/i.test(sql)) return "s2";
  if (/\bh3\b/i.test(sql)) return "h3";
  return null;
}

/** DuckDB may return H3/A5 as hex text or as UBIGINT; Deck wants hex strings. */
export function cellIdToHex(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "bigint") return value.toString(16);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return BigInt(Math.trunc(value)).toString(16);
  }
  if (typeof value === "object") {
    const rec = value as { toString?: () => string };
    if (typeof rec.toString === "function") {
      return cellIdFromText(rec.toString());
    }
  }
  return cellIdFromText(String(value));
}

/**
 * Hex cell ids are ≤16 chars (may be 0-9 only). UBIGINT printed as decimal
 * is 17–20 digits — only then convert to hex.
 */
function cellIdFromText(value: string): string {
  const s = value.replace(/^0x/i, "");
  if (/^\d+$/.test(s) && s.length > 16) return BigInt(s).toString(16);
  return s;
}

export function rowsFromQueryResult(
  raw: Array<Record<string, unknown>>,
): SqlPopRow[] {
  const rows: SqlPopRow[] = [];
  for (const record of raw) {
    const hex = record.h3 ?? record.a5 ?? record.s2 ?? record.cell ?? record.hex;
    const pop = record.population ?? record.pop ?? record.value;
    if (hex == null || hex === "") continue;
    const population = typeof pop === "number" ? pop : Number(pop);
    rows.push({
      hex: cellIdToHex(hex),
      population: Number.isFinite(population) ? population : 0,
    });
  }
  return rows;
}
