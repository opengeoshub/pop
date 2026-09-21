import type { APIRoute } from "astro";
import {
  DEFAULT_DGGS,
  parseDggs,
  parseResolution,
  DGGS,
  type DggsId,
} from "../../lib/dggs";
import { lookupAllPopulation, lookupPopulation } from "../../lib/db";
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
    const dggs: DggsId = parseDggs(body?.dggs) ?? DEFAULT_DGGS;
    const cfg = DGGS[dggs];
    const resolution =
      parseResolution(body?.resolution, dggs) ?? cfg.adaptiveResolution;

    if (body?.all === true) {
      const population = await lookupAllPopulation(resolution, dggs);
      const matched = Object.keys(population).length;
      return new Response(
        JSON.stringify({
          population,
          matched,
          viewportIds: matched,
          resolution,
          dggs,
          engine: "native",
          mode: "all",
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    let ids: string[] = [];
    const bounds = parseBounds(body?.bounds);

    if (bounds) {
      if (dggs === "h3") {
        ids = h3IdsInBounds(bounds, resolution as 4 | 5 | 6 | 7 | 8);
      } else {
        const population = await lookupAllPopulation(resolution, dggs);
        const matched = Object.keys(population).length;
        return new Response(
          JSON.stringify({
            population,
            matched,
            viewportIds: matched,
            resolution,
            dggs,
            engine: "native",
            mode: "all",
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
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
          dggs,
          engine: "native",
          mode: "viewport",
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    const population = await lookupPopulation(ids, resolution, dggs);
    return new Response(
      JSON.stringify({
        population,
        matched: Object.keys(population).length,
        viewportIds: ids.length,
        resolution,
        dggs,
        engine: "native",
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
