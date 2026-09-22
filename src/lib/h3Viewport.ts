/**
 * Viewport → H3 IDs for DuckDB lookups.
 */
import {
  polygonToCells,
  polygonToCellsExperimental,
  POLYGON_TO_CELLS_FLAGS,
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

export function boundsFromLngLatBounds(b: {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
}): LngLatBoundsLike {
  return {
    west: b.getWest(),
    south: b.getSouth(),
    east: b.getEast(),
    north: b.getNorth(),
  };
}

function cellsOverlappingLoop(
  loop: [number, number][],
  resolution: number,
): string[] {
  try {
    return (
      polygonToCellsExperimental(
        loop,
        resolution,
        POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
      ) ?? []
    );
  } catch {
    try {
      return polygonToCells(loop, resolution) ?? [];
    } catch {
      return [];
    }
  }
}

/** Collect H3 cell IDs whose geometry intersects the map bounds. */
export function h3IdsInBounds(
  bounds: LngLatBoundsLike,
  resolution: number,
): string[] {
  const { west, south, east, north } = bounds;
  if (
    !Number.isFinite(west) ||
    !Number.isFinite(east) ||
    !Number.isFinite(south) ||
    !Number.isFinite(north) ||
    !(east > west) ||
    !(north > south)
  ) {
    return [];
  }
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
    for (const id of cellsOverlappingLoop(part, resolution)) {
      ids.add(id);
    }
    lowerX += xIncrement;
  }

  if (ids.size === 0) {
    for (const id of cellsOverlappingLoop(ring, resolution)) {
      ids.add(id);
    }
  }

  return [...ids];
}
