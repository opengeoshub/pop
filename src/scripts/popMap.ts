import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import type { Color, PickingInfo } from "@deck.gl/core";
import {
  resolutionForZoom,
  boundsFromMapCorners,
  FULL_TABLE_ZOOM,
  type H3PopResolution,
} from "../lib/h3Viewport";
import { MapLibreControlZoomHome } from "../lib/MapLibreControlZoomHome";

/** Same idea as A5 duckdb-playground: warn before tessellating huge results */
const RENDER_WARNING_CELLS = 200_000;

/** Approx log10 max population by H3 resolution (for Spectral stretch) */
const LOG_MAX_BY_RES: Record<H3PopResolution, number> = {
  4: Math.log10(5_000_000),
  5: Math.log10(1_500_000),
  6: Math.log10(500_000),
  7: Math.log10(120_000),
  8: Math.log10(40_000),
};

let pmtilesRegistered = false;
function ensurePmtilesProtocol() {
  if (pmtilesRegistered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);
  pmtilesRegistered = true;
}

const SPECTRAL_HEX = [
  "#5e4fa2",
  "#3288bd",
  "#66c2a5",
  "#abdda4",
  "#e6f598",
  "#fee08b",
  "#fdae61",
  "#f46d43",
  "#d53e4f",
  "#9e0142",
];

const SPECTRAL_RGB: Color[] = SPECTRAL_HEX.map((hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
});

type HexRow = { hex: string; population: number };

function populationToRows(population: Record<string, number>): HexRow[] {
  const rows: HexRow[] = [];
  for (const hex in population) {
    rows.push({ hex, population: population[hex] });
  }
  return rows;
}

function populationColor(pop: number, resolution: H3PopResolution): Color {
  const logMax = LOG_MAX_BY_RES[resolution];
  const t = Math.min(1, Math.max(0, Math.log10(Math.max(pop, 1)) / logMax));
  const s = t * (SPECTRAL_RGB.length - 1);
  const i = Math.min(Math.floor(s), SPECTRAL_RGB.length - 2);
  const f = s - i;
  const [r0, g0, b0] = SPECTRAL_RGB[i];
  const [r1, g1, b1] = SPECTRAL_RGB[i + 1];
  return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f, 230];
}

function setStatus(text: string, tone: "ok" | "warn" | "err" = "ok") {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
}

async function fetchPopulation(opts: {
  resolution: H3PopResolution;
  all?: boolean;
  bounds?: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
}): Promise<{
  population: Record<string, number>;
  viewportIds: number;
  mode: string;
}> {
  const res = await fetch("/api/population", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return {
    population: data.population as Record<string, number>,
    viewportIds: Number(data.viewportIds) || 0,
    mode: String(data.mode || "viewport"),
  };
}

/** Cached full tables (r4 auto; r5/r6 via HUD) */
const fullCache = new Map<H3PopResolution, HexRow[]>();
/** When set, pan/zoom keeps this full table instead of viewport queries */
let lockedFullRes: H3PopResolution | null = null;
let overlay: MapboxOverlay | null = null;
let paintedResolution: H3PopResolution | null = null;
let mapRef: maplibregl.Map | null = null;
let fullLoadBusy = false;

type PendingFull = {
  resolution: H3PopResolution;
  rows: HexRow[];
  elapsedMs: number;
};
let pendingFull: PendingFull | null = null;

function setHexLayer(rows: HexRow[], resolution: H3PopResolution) {
  paintedResolution = resolution;
  overlay?.setProps({
    layers: [
      new H3HexagonLayer<HexRow>({
        id: `h3-pop-r${resolution}`,
        data: rows,
        getHexagon: (d) => d.hex,
        getFillColor: (d) => populationColor(d.population, resolution),
        getLineColor: [20, 20, 20, 90],
        lineWidthMinPixels: 0.35,
        stroked: true,
        filled: true,
        extruded: false,
        pickable: true,
        highPrecision: true,
        coverage: 1,
        updateTriggers: {
          getFillColor: resolution,
          data: `${resolution}:${rows.length}`,
        },
      }),
    ],
  });
}

function clearHexLayer() {
  paintedResolution = null;
  overlay?.setProps({ layers: [] });
}

function syncFullLoadUi() {
  const confirm = document.getElementById("render-confirm");
  const warn = document.getElementById("render-warn");
  const exitBtn = document.getElementById("exit-full") as HTMLButtonElement | null;
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-full-res]");

  if (confirm && warn) {
    if (pendingFull) {
      confirm.hidden = false;
      warn.textContent =
        `Loaded ${pendingFull.rows.length.toLocaleString()} cells` +
        ` in ${Math.round(pendingFull.elapsedMs)}ms. ` +
        `Drawing the full grid may freeze the browser.`;
    } else {
      confirm.hidden = true;
      warn.textContent = "";
    }
  }

  if (exitBtn) {
    exitBtn.hidden = lockedFullRes == null || lockedFullRes === 4;
  }

  for (const btn of buttons) {
    const res = Number(btn.dataset.fullRes) as H3PopResolution;
    btn.disabled = fullLoadBusy || pendingFull != null;
    btn.classList.toggle("active", lockedFullRes === res);
  }
}

function applyFullTable(
  resolution: H3PopResolution,
  rows: HexRow[],
  elapsedMs?: number,
) {
  lockedFullRes = resolution;
  pendingFull = null;
  setHexLayer(rows, resolution);
  const timing =
    elapsedMs != null ? ` · ${Math.round(elapsedMs)}ms` : " (cached)";
  setStatus(
    `full h3_${resolution} · ${rows.length.toLocaleString()} cells${timing}`,
  );
  syncFullLoadUi();
}

function cancelPendingFull() {
  pendingFull = null;
  setStatus("Rendering cancelled — use viewport zoom or pick a smaller full table");
  syncFullLoadUi();
}

function exitLockedFull() {
  lockedFullRes = null;
  pendingFull = null;
  clearHexLayer();
  syncFullLoadUi();
  if (mapRef) void refresh(mapRef);
}

async function requestFullTable(resolution: 5 | 6) {
  if (fullLoadBusy) return;
  fullLoadBusy = true;
  pendingFull = null;
  syncFullLoadUi();

  try {
    const cached = fullCache.get(resolution);
    if (cached) {
      if (cached.length > RENDER_WARNING_CELLS) {
        pendingFull = { resolution, rows: cached, elapsedMs: 0 };
        setStatus(`h3_${resolution} ready — confirm to draw`);
        syncFullLoadUi();
        return;
      }
      applyFullTable(resolution, cached);
      return;
    }

    setStatus(`Loading full h3_${resolution}…`);
    const t0 = performance.now();
    const { population } = await fetchPopulation({
      resolution,
      all: true,
    });
    const elapsedMs = performance.now() - t0;
    const rows = populationToRows(population);
    fullCache.set(resolution, rows);

    if (rows.length > RENDER_WARNING_CELLS) {
      pendingFull = { resolution, rows, elapsedMs };
      setStatus(`h3_${resolution} ready — confirm to draw`);
      syncFullLoadUi();
      return;
    }

    applyFullTable(resolution, rows, elapsedMs);
  } catch (err) {
    setStatus(
      err instanceof Error ? err.message : `Failed to load h3_${resolution}`,
      "err",
    );
  } finally {
    fullLoadBusy = false;
    syncFullLoadUi();
  }
}

let requestSeq = 0;

async function refresh(map: maplibregl.Map) {
  // Manual full h3_5/6 lock — don't clobber with viewport queries
  if (lockedFullRes != null && lockedFullRes !== 4) {
    const rows = fullCache.get(lockedFullRes);
    if (rows) {
      if (paintedResolution !== lockedFullRes) setHexLayer(rows, lockedFullRes);
      setStatus(
        `full h3_${lockedFullRes} (locked) · ${rows.length.toLocaleString()} cells`,
      );
    }
    return;
  }

  const zoom = map.getZoom();
  const resolution = resolutionForZoom(zoom);
  const seq = ++requestSeq;

  try {
    if (zoom < FULL_TABLE_ZOOM) {
      lockedFullRes = 4;
      let rows = fullCache.get(4) ?? null;
      if (!rows) {
        setStatus("Loading full h3_4…");
        const { population } = await fetchPopulation({
          resolution: 4,
          all: true,
        });
        if (seq !== requestSeq) return;
        rows = populationToRows(population);
        fullCache.set(4, rows);
      }
      if (paintedResolution !== 4) setHexLayer(rows, 4);
      setStatus(
        `z${zoom.toFixed(1)} · full h3_4 · ${rows.length.toLocaleString()} cells`,
      );
      syncFullLoadUi();
      return;
    }

    if (lockedFullRes === 4) lockedFullRes = null;

    if (paintedResolution !== null && paintedResolution !== resolution) {
      clearHexLayer();
    }

    const canvas = map.getCanvas();
    const ul = map.unproject([0, 0]).toArray() as [number, number];
    const lr = map
      .unproject([canvas.width, canvas.height])
      .toArray() as [number, number];
    const bounds = boundsFromMapCorners(ul, lr);

    setStatus(`Querying viewport ∩ h3_${resolution}…`);

    const { population, viewportIds } = await fetchPopulation({
      resolution,
      bounds,
    });
    if (seq !== requestSeq) return;

    const rows = populationToRows(population);
    setHexLayer(rows, resolution);

    setStatus(
      `z${zoom.toFixed(1)} · H3 r${resolution} · ${viewportIds.toLocaleString()} viewport IDs · ${rows.length.toLocaleString()} matched`,
    );
    syncFullLoadUi();
  } catch (err) {
    if (seq !== requestSeq) return;
    setStatus(
      err instanceof Error ? err.message : "Failed to load population",
      "err",
    );
  }
}

function wireFullLoadControls() {
  document.querySelectorAll<HTMLButtonElement>("[data-full-res]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const res = Number(btn.dataset.fullRes);
      if (res === 5 || res === 6) void requestFullTable(res);
    });
  });

  document.getElementById("render-anyway")?.addEventListener("click", () => {
    if (!pendingFull) return;
    const { resolution, rows, elapsedMs } = pendingFull;
    applyFullTable(resolution, rows, elapsedMs || undefined);
    mapRef?.easeTo({
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      bearing: 0,
      pitch: 0,
      duration: 800,
    });
  });

  document.getElementById("render-cancel")?.addEventListener("click", () => {
    cancelPendingFull();
  });

  document.getElementById("exit-full")?.addEventListener("click", () => {
    exitLockedFull();
  });

  syncFullLoadUi();
}

const INITIAL_CENTER: [number, number] = [105.85, 21.03];
const INITIAL_ZOOM = 1;

export function initPopMap(container: HTMLElement) {
  ensurePmtilesProtocol();
  wireFullLoadControls();

  const map = new maplibregl.Map({
    container,
    style:
      "https://raw.githubusercontent.com/opengeoshub/vstyles/main/vstyles/pop/pop.json",
    center: INITIAL_CENTER,
    zoom: INITIAL_ZOOM,
    minZoom: 0,
    maxZoom: 16,
  });
  mapRef = map;

  map.addControl(new maplibregl.NavigationControl(), "top-right");
  map.addControl(
    new MapLibreControlZoomHome({
      resetLngLat: INITIAL_CENTER,
      resetZoom: INITIAL_ZOOM,
    }),
    "top-right",
  );
  map.addControl(new maplibregl.GlobeControl(), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

  map.on("style.load", () => {
    map.setProjection({ type: "globe" });
  });

  const tip = document.createElement("div");
  tip.style.cssText = [
    "position:absolute",
    "z-index:10",
    "display:none",
    "pointer-events:none",
    "background:#fff",
    "color:#111",
    "font:12px/1.45 'IBM Plex Sans', system-ui, sans-serif",
    "padding:8px 10px",
    "border-radius:6px",
    "border:1px solid rgba(0,0,0,0.12)",
    "box-shadow:0 4px 16px rgba(0,0,0,0.35)",
    "max-width:280px",
    "transform:translate(12px, 12px)",
  ].join(";");
  container.appendChild(tip);

  const hideTip = () => {
    tip.style.display = "none";
    map.getCanvas().style.cursor = "";
  };

  const showTip = (object: HexRow, x: number, y: number) => {
    const pop =
      object.population == null
        ? "—"
        : Number(object.population).toLocaleString(undefined, {
            maximumFractionDigits: 1,
          });
    tip.innerHTML = `<strong>${object.hex}</strong><br/>population: ${pop}`;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.style.display = "block";
    map.getCanvas().style.cursor = "default";
  };

  overlay = new MapboxOverlay({
    interleaved: false,
    layers: [],
    onHover: (info: PickingInfo<HexRow>) => {
      if (!info.object || info.x == null || info.y == null) {
        hideTip();
        return;
      }
      showTip(info.object, info.x, info.y);
    },
  });
  map.addControl(overlay);

  map.on("load", () => {
    void refresh(map);
  });

  let moveTimer: ReturnType<typeof setTimeout> | undefined;
  map.on("moveend", () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => void refresh(map), 180);
  });

  return map;
}
