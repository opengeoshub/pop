import {
  FULL_TABLE_ZOOM as H3_FULL_TABLE_ZOOM,
  resolutionForZoom as h3ResolutionForZoom,
  type H3PopResolution,
} from "./h3Viewport";

export type DggsId = "h3" | "a5" | "s2";

export const DGGS_IDS = ["h3", "a5", "s2"] as const;
export const DEFAULT_DGGS: DggsId = "h3";

/** A5 resolutions with parquet under data/a5/ */
export type A5PopResolution = 7;
/** S2 resolutions with parquet under data/s2/ */
export type S2PopResolution = 8;
export type PopResolution = H3PopResolution | A5PopResolution | S2PopResolution;

export function parseDggs(value: unknown): DggsId | null {
  return (DGGS_IDS as readonly string[]).includes(value as string)
    ? (value as DggsId)
    : null;
}

type DggsConfig = {
  id: DggsId;
  label: string;
  cellColumn: DggsId;
  resolutions: readonly number[];
  /** Buttons in the HUD; first entry is adaptive (viewport) mode */
  fullLoadResolutions: readonly number[];
  adaptiveResolution: number;
  fullTableZoom: number;
  helpHtml: string;
  resolutionForZoom: (zoom: number) => number;
  isResolution: (n: number) => boolean;
  logMaxByRes: Record<number, number>;
  tableRows: Record<number, number>;
};

export const DGGS: Record<DggsId, DggsConfig> = {
  h3: {
    id: "h3",
    label: "H3",
    cellColumn: "h3",
    resolutions: [4, 5, 6, 7, 8],
    fullLoadResolutions: [4, 5, 6],
    adaptiveResolution: 4,
    fullTableZoom: H3_FULL_TABLE_ZOOM,
    helpHtml:
      "<code>z0–8 → full h3_4</code> (cached)<br /><code>z9 → h3_5</code>, <code>z10 → h3_6</code><br /><code>z11 → h3_7</code>, <code>z12+ → h3_8</code>",
    resolutionForZoom: h3ResolutionForZoom,
    isResolution: (n) => n === 4 || n === 5 || n === 6 || n === 7 || n === 8,
    logMaxByRes: {
      4: Math.log10(5_000_000),
      5: Math.log10(1_500_000),
      6: Math.log10(500_000),
      7: Math.log10(120_000),
      8: Math.log10(40_000),
    },
    tableRows: {
      4: 71_283,
      5: 288_000,
      6: 2_016_971,
      7: 4_700_000,
      8: 32_957_699,
    },
  },
  a5: {
    id: "a5",
    label: "A5",
    cellColumn: "a5",
    resolutions: [7],
    fullLoadResolutions: [7],
    adaptiveResolution: 7,
    /** Only a5_7 is present — always the full cached table */
    fullTableZoom: 32,
    helpHtml: "<code>z0+ → full a5_7</code> (cached)",
    resolutionForZoom: () => 7,
    isResolution: (n) => n === 7,
    logMaxByRes: {
      7: Math.log10(5_000_000),
    },
    tableRows: {
      7: 73_530,
    },
  },
  s2: {
    id: "s2",
    label: "S2",
    cellColumn: "s2",
    resolutions: [8],
    fullLoadResolutions: [8],
    adaptiveResolution: 8,
    /** Only s2_8 is present — always the full cached table */
    fullTableZoom: 32,
    helpHtml: "<code>z0+ → full s2_8</code> (cached)",
    resolutionForZoom: () => 8,
    isResolution: (n) => n === 8,
    logMaxByRes: {
      8: Math.log10(5_000_000),
    },
    tableRows: {
      8: 115_223,
    },
  },
};

export function parseResolution(
  value: unknown,
  dggs: DggsId,
): number | null {
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  return DGGS[dggs].isResolution(n) ? n : null;
}
