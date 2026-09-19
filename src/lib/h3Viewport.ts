/**
 * Viewport → H3 FeatureCollection, adapted from vgrid-maplibre H3Grid.
 * @see https://github.com/opengeoshub/vgrid-maplibre/blob/main/H3/H3Grid.js
 */
import {
  cellToBoundary,
  getResolution,
  isPentagon,
  polygonToCells,
} from "h3-js";

/** H3 resolutions supported by parquet datasets */
export type H3PopResolution = 4 | 5 | 6 | 7 | 8;

/**
 * Zoom → H3 resolution / parquet:
 *  z 0–8   → full h3_4 (cached; no viewport ID generation)
 *  z 9     → viewport ∩ h3_5  (aggregated from h3_6)
 *  z 10    → viewport ∩ h3_6
 *  z 11    → viewport ∩ h3_7  (aggregated from h3_8)
 *  z 12+   → viewport ∩ h3_8
 */
export function resolutionForZoom(zoom: number): H3PopResolution {
  if (zoom < 9) return 4;
  if (zoom < 10) return 5;
  if (zoom < 11) return 6;
  if (zoom < 12) return 7;
  return 8;
}

/** Below this zoom, reuse full h3_4 — no viewport ID generation */
export const FULL_TABLE_ZOOM = 9;

export type LngLatBoundsLike = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export function boundsFromMapCorners(
  upperLeft: [number, number],
  lowerRight: [number, number],
  bufferRatio = 0.05,
): LngLatBoundsLike {
  const west = Math.min(upperLeft[0], lowerRight[0]);
  const east = Math.max(upperLeft[0], lowerRight[0]);
  const south = Math.min(upperLeft[1], lowerRight[1]);
  const north = Math.max(upperLeft[1], lowerRight[1]);
  const dw = (east - west) * bufferRatio;
  const dh = (north - south) * bufferRatio;
  return {
    west: Math.max(west - dw, -180),
    east: Math.min(east + dw, 180),
    south: Math.max(south - dh, -90),
    north: Math.min(north + dh, 90),
  };
}

/** Collect H3 cell IDs covering the map canvas at the given resolution. */
export function h3IdsInBounds(
  bounds: LngLatBoundsLike,
  resolution: H3PopResolution,
): string[] {
  const { west, south, east, north } = bounds;
  const ring: [number, number][] = [
    [north, west],
    [north, east],
    [south, east],
    [south, west],
  ];

  const ids = new Set<string>();
  const xIncrement = 180;
  let lowerX = west;
  while (lowerX < 180 && lowerX < east) {
    const upperX = Math.min(lowerX + xIncrement, east, 180);
    const part: [number, number][] = [
      [north, lowerX],
      [north, upperX],
      [south, upperX],
      [south, lowerX],
    ];
    for (const id of polygonToCells(part, resolution)) {
      ids.add(id);
    }
    lowerX += xIncrement;
  }

  if (ids.size === 0) {
    for (const id of polygonToCells(ring, resolution)) {
      ids.add(id);
    }
  }

  return [...ids];
}

export type H3FeatureProperties = {
  h3_id: string;
  resolution: number;
  population: number | null;
  pentagon?: boolean;
};

export function cellsToFeatureCollection(
  ids: string[],
  populationById: Record<string, number> = {},
) {
  const features = [];

  for (const h3_id of ids) {
    let boundary = cellToBoundary(h3_id, true) as [number, number][];
    if (boundary.some((e) => e[0] < -130)) {
      boundary = boundary.map((e) =>
        e[0] > 0 ? ([e[0] - 360, e[1]] as [number, number]) : e,
      );
    }

    const props: H3FeatureProperties = {
      h3_id,
      resolution: getResolution(h3_id),
      population:
        populationById[h3_id] != null ? Number(populationById[h3_id]) : null,
    };
    if (isPentagon(h3_id)) props.pentagon = true;

    features.push({
      type: "Feature" as const,
      properties: props,
      geometry: {
        type: "Polygon" as const,
        coordinates: [boundary],
      },
    });
  }

  return { type: "FeatureCollection" as const, features };
}
