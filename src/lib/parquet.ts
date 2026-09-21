import { DGGS, type DggsId } from "./dggs";

export const PARQUET_BASE = "https://parquet.gishub.vn";

export function parquetUrl(dggs: DggsId, res: number): string {
  const col = DGGS[dggs].cellColumn;
  return `${PARQUET_BASE}/${dggs}/${col}_${res}.parquet`;
}

export function sqlQuoteId(id: string): string {
  return `'${id.replace(/'/g, "''")}'`;
}
