import type { APIRoute } from "astro";
import {
  lookupAllPopulation,
  lookupPopulation,
  parseResolution,
} from "../../lib/db";
import {
  h3IdsInBounds,
  type LngLatBoundsLike,
} from "../../lib/h3Viewport";

export const prerender = false;

function parseBounds(raw: unknown): LngLatBoundsLike | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const west = Number(b.west);
  const south = Number(b.south);
  const east = Number(b.east);
  const north = Number(b.north);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  return { west, south, east, north };
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const resolution = parseResolution(body?.resolution) ?? 8;

    // Zoom 0: return entire table (typically h3_4) — no viewport ID generation
    if (body?.all === true) {
      const population = await lookupAllPopulation(resolution);
      const matched = Object.keys(population).length;
      return new Response(
        JSON.stringify({
          population,
          matched,
          viewportIds: matched,
          resolution,
          mode: "all",
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    let ids: string[] = [];
    const bounds = parseBounds(body?.bounds);

    if (bounds) {
      ids = h3IdsInBounds(bounds, resolution);
    } else if (Array.isArray(body?.ids)) {
      ids = body.ids.filter((id: unknown) => typeof id === "string");
    }

    if (ids.length === 0) {
      return new Response(
        JSON.stringify({
          population: {},
          matched: 0,
          viewportIds: 0,
          resolution,
          mode: "viewport",
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    const population = await lookupPopulation(ids, resolution);
    return new Response(
      JSON.stringify({
        population,
        matched: Object.keys(population).length,
        viewportIds: ids.length,
        resolution,
        mode: "viewport",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "Lookup failed",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
