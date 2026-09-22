import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { PMTiles, Protocol, type Header } from "pmtiles";

export const NONE_GEOM_PMTILES_URL =
  "https://tiles.gishub.vn/pmtiles/pop_h3_non_geom.pmtiles";

/** Same remote archive as vtiles/index.html. On localhost, prefer the Vite proxy to avoid CORS. */
export function noneGeomCandidateUrls(): string[] {
  const urls: string[] = [];
  if (typeof location !== "undefined" && location.hostname === "localhost") {
    urls.push(`${location.origin}/pmtiles/pop_h3_non_geom.pmtiles`);
  }
  urls.push(NONE_GEOM_PMTILES_URL);
  return urls;
}

let protocol: Protocol | null = null;
let activeUrl: string | null = null;

export function setNoneGeomProtocol(next: Protocol) {
  protocol = next;
}

export const NONE_GEOM_MAX_TILES = 80;
export const NONE_GEOM_SOURCE = "none-geom-population";
export const NONE_GEOM_FILL_LAYER = "none-geom-fill";
export const NONE_GEOM_OUTLINE_LAYER = "none-geom-outline";

export type NoneGeomRow = { hex: string; population: number };

type XyzTile = { z: number; x: number; y: number };
type RecordProps = Record<string, unknown>;

let archive: PMTiles | null = null;
let header: Header | null = null;
const tileCache = new Map<string, RecordProps[]>();

export async function ensureNoneGeomArchive(): Promise<{
  archive: PMTiles;
  header: Header;
}> {
  if (archive && header && activeUrl) {
    return { archive, header };
  }
  let lastError: unknown;
  for (const url of noneGeomCandidateUrls()) {
    try {
      const next = new PMTiles(url);
      const nextHeader = await next.getHeader();
      if (protocol && activeUrl) protocol.tiles.delete(activeUrl);
      protocol?.add(next);
      archive = next;
      header = nextHeader;
      activeUrl = url;
      return { archive, header };
    } catch (error) {
      lastError = error;
      console.warn("None-geom PMTiles failed, trying next source.", url, error);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Could not open none-geom PMTiles");
}

export function resetNoneGeomCache() {
  tileCache.clear();
  if (protocol && activeUrl) protocol.tiles.delete(activeUrl);
  archive = null;
  header = null;
  activeUrl = null;
}

function decodeMvtAttributes(data: ArrayBuffer | ArrayBufferView): RecordProps[] {
  const bytes =
    data instanceof Uint8Array
      ? data
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const tile = new VectorTile(new PbfReader(bytes));
  const records: RecordProps[] = [];
  for (const name of Object.keys(tile.layers)) {
    const layer = tile.layers[name];
    for (let i = 0; i < layer.length; i++) {
      records.push(layer.feature(i).properties as RecordProps);
    }
  }
  return records;
}

function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (clampedLat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n,
  );
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
  };
}

function tilesForBounds(
  west: number,
  south: number,
  east: number,
  north: number,
  z: number,
): XyzTile[] {
  const topLeft = lonLatToTile(west, north, z);
  const bottomRight = lonLatToTile(east, south, z);
  const tiles: XyzTile[] = [];
  for (let x = topLeft.x; x <= bottomRight.x; x++) {
    for (let y = topLeft.y; y <= bottomRight.y; y++) {
      tiles.push({ z, x, y });
    }
  }
  return tiles;
}

export function getVisibleTiles(
  headerZoom: { minZoom: number; maxZoom: number },
  mapZoom: number,
  bounds: { west: number; south: number; east: number; north: number },
): XyzTile[] {
  const z = Math.max(
    headerZoom.minZoom,
    Math.min(headerZoom.maxZoom, Math.floor(mapZoom)),
  );
  const { west, south, east, north } = bounds;
  if (east >= west) return tilesForBounds(west, south, east, north, z);
  return [
    ...tilesForBounds(west, south, 180, north, z),
    ...tilesForBounds(-180, south, east, north, z),
  ];
}

function recordH3Id(record: RecordProps): string {
  const raw = record.h3 ?? record.h3id ?? record.h3_id ?? record.h3_index;
  return typeof raw === "string" ? raw.trim() : "";
}

function recordPopulation(record: RecordProps): number {
  const raw = record.population ?? record.pop ?? record.POPULATION;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function recordsToRows(records: RecordProps[]): NoneGeomRow[] {
  const rows: NoneGeomRow[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const hex = recordH3Id(record);
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    rows.push({ hex, population: recordPopulation(record) });
  }
  return rows;
}

async function loadTile(z: number, x: number, y: number): Promise<RecordProps[]> {
  const key = `${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) return cached;
  if (!archive) return [];
  try {
    const tile = await archive.getZxy(z, x, y);
    if (!tile?.data) {
      tileCache.set(key, []);
      return [];
    }
    const records = decodeMvtAttributes(tile.data);
    tileCache.set(key, records);
    return records;
  } catch (error) {
    console.error("Error loading " + key, error);
    return [];
  }
}

export async function updateNoneGeomPopulation(opts: {
  west: number;
  south: number;
  east: number;
  north: number;
  mapZoom: number;
}): Promise<{
  rows: NoneGeomRow[];
  zoom: number;
  tileCount: number;
  skipped: boolean;
}> {
  const { header: hdr } = await ensureNoneGeomArchive();
  const tiles = getVisibleTiles(hdr, opts.mapZoom, opts);
  const zoom = tiles[0]?.z ?? Math.floor(opts.mapZoom);

  if (tiles.length > NONE_GEOM_MAX_TILES) {
    return { rows: [], zoom, tileCount: tiles.length, skipped: true };
  }

  const results = await Promise.all(
    tiles.map((tile) => loadTile(tile.z, tile.x, tile.y)),
  );
  return {
    rows: recordsToRows(results.flat()),
    zoom,
    tileCount: tiles.length,
    skipped: false,
  };
}
