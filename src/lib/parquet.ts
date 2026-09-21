import { DGGS, type DggsId } from "./dggs";

export const PARQUET_BASE = "https://parquet.gishub.vn";

export function parquetFileName(dggs: DggsId, res: number): string {
  return `${DGGS[dggs].cellColumn}_${res}.parquet`;
}

export function parquetUrl(dggs: DggsId, res: number): string {
  return `${PARQUET_BASE}/${dggs}/${parquetFileName(dggs, res)}`;
}

export function localParquetUrl(dggs: DggsId, res: number): string {
  return `/${dggs}/${parquetFileName(dggs, res)}`;
}

export function serverParquetUrl(dggs: DggsId, res: number): string {
  const base = (process.env.PARQUET_BASE?.trim() || PARQUET_BASE).replace(
    /\/$/,
    "",
  );
  return `${base}/${dggs}/${parquetFileName(dggs, res)}`;
}

export function sqlQuoteId(id: string): string {
  return `'${id.replace(/'/g, "''")}'`;
}
