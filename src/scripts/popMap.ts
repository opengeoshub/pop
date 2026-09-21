import * as maplibregl from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { A5Layer, H3HexagonLayer, S2Layer } from "@deck.gl/geo-layers";
import type { Color, PickingInfo } from "@deck.gl/core";
import { boundsFromMapCorners, h3IdsInBounds } from "../lib/h3Viewport";
import {
  DGGS,
  DEFAULT_DGGS,
  parseDggs,
  type DggsId,
} from "../lib/dggs";
import { lookupAllPopulation, lookupPopulation } from "../lib/clientDuckdb";
import { MapLibreControlZoomHome } from "../lib/MapLibreControlZoomHome";
import {
  PALETTE_HEX,
  VECTOR_LAYER_IDS,
  loadGithubStyle,
  rewriteVstylesUrl,
  styleKey,
  type PaletteId,
} from "../lib/mapStyle";

maplibregl.config.WORKER_URL = maplibreWorkerUrl;

export type { PaletteId };

export type PopEngine = "wasm" | "native" | "vector";

function parseEngine(value: string | null): PopEngine {
  if (value === "native" || value === "vector") return value;
  return "wasm";
}

/** Same idea as A5 duckdb-playground: warn before tessellating huge results */
const RENDER_WARNING_CELLS = 200_000;

let pmtilesRegistered = false;
function ensurePmtilesProtocol() {
  if (pmtilesRegistered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);
  pmtilesRegistered = true;
}

const VECTOR_HELP_HTML =
  "<code>z0–8 → h3_4</code> (vector tiles)<br /><code>z9 → h3_5</code>, <code>z10 → h3_6</code>, <code>z11+ → h3_7</code>";

function hexToRgb(hex: string): Color {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const PALETTE_RGB: Record<PaletteId, Color[]> = {
  spectral: PALETTE_HEX.spectral.map(hexToRgb),
  magma: PALETTE_HEX.magma.map(hexToRgb),
  viridis: PALETTE_HEX.viridis.map(hexToRgb),
  terrain: PALETTE_HEX.terrain.map(hexToRgb),
  heat: PALETTE_HEX.heat.map(hexToRgb),
};

type HexRow = { hex: string; population: number };

let activePalette: PaletteId = "spectral";
let paintedRows: HexRow[] | null = null;

function populationColor(pop: number, resolution: number): Color {
  const ramp = PALETTE_RGB[activePalette];
  const logMax =
    DGGS[activeDggs].logMaxByRes[resolution] ?? Math.log10(5_000_000);
  const t = Math.min(1, Math.max(0, Math.log10(Math.max(pop, 1)) / logMax));
  const s = t * (ramp.length - 1);
  const i = Math.min(Math.floor(s), ramp.length - 2);
  const f = s - i;
  const [r0, g0, b0] = ramp[i];
  const [r1, g1, b1] = ramp[i + 1];
  return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f, 230];
}

let loadedStyleKey = "";

async function applyMapStyle(map: maplibregl.Map): Promise<boolean> {
  const key = styleKey(activeEngine === "vector", activePalette);
  if (key === loadedStyleKey) return false;
  loadedStyleKey = key;
  try {
    const style = await loadGithubStyle(activeEngine === "vector", activePalette);
    if (styleKey(activeEngine === "vector", activePalette) !== key) return false;
    map.setStyle(style);
    return true;
  } catch (err) {
    if (loadedStyleKey === key) loadedStyleKey = "";
    setStatus(err instanceof Error ? err.message : "Failed to load style", "err");
    return false;
  }
}

function vectorResolutionForZoom(zoom: number): 4 | 5 | 6 | 7 {
  if (zoom < 9) return 4;
  if (zoom < 10) return 5;
  if (zoom < 11) return 6;
  return 7;
}

function syncLegendRamp() {
  const el = document.querySelector<HTMLElement>(".ramp");
  if (el) el.style.background = `linear-gradient(90deg, ${PALETTE_HEX[activePalette].join(", ")})`;
}

function setPalette(id: PaletteId) {
  if (!(id in PALETTE_HEX)) return;
  activePalette = id;
  syncLegendRamp();
  if (activeEngine === "vector") {
    if (mapRef) void applyMapStyle(mapRef);
    return;
  }
  if (paintedRows && paintedResolution != null) {
    setHexLayer(paintedRows, paintedResolution);
  }
}

function setStatus(text: string, tone: "ok" | "warn" | "err" = "ok") {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
}

function remoteNativeEndpoint(): string | null {
  const base = import.meta.env.PUBLIC_NATIVE_API_URL?.trim();
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/api/population`;
}

async function postNativeApi(
  url: string,
  body: unknown,
): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("json")) return null;
    return res;
  } catch {
    return null;
  }
}

async function loadPopulationNative(opts: {
  resolution: number;
  all?: boolean;
  bounds?: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
}): Promise<{ rows: HexRow[]; viewportIds: number }> {
  const body = { ...opts, dggs: activeDggs };
  const remote = remoteNativeEndpoint();
  const res =
    (await postNativeApi("/api/population", body)) ??
    (remote ? await postNativeApi(remote, body) : null);
  if (!res) {
    throw new Error(
      "Native DuckDB API is unreachable. Use DuckDB WASM, run the Node server with data/*.duckdb, or set PUBLIC_NATIVE_API_URL to Render.",
    );
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  const population = (data.population ?? {}) as Record<string, number>;
  const rows: HexRow[] = [];
  for (const hex in population) {
    rows.push({ hex, population: Number(population[hex]) });
  }
  return {
    rows,
    viewportIds: Number(data.viewportIds) || rows.length,
  };
}

async function loadPopulation(opts: {
  resolution: number;
  all?: boolean;
  bounds?: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
}): Promise<{ rows: HexRow[]; viewportIds: number }> {
  if (activeEngine === "native") return loadPopulationNative(opts);
  if (opts.all || activeDggs !== "h3" || !opts.bounds) {
    const rows = await lookupAllPopulation(activeDggs, opts.resolution);
    return { rows, viewportIds: rows.length };
  }
  const ids = h3IdsInBounds(
    opts.bounds,
    opts.resolution as 4 | 5 | 6 | 7 | 8,
  );
  return lookupPopulation(activeDggs, opts.resolution, ids);
}

/** Cached full tables keyed by `${dggs}:${resolution}` */
const fullCache = new Map<string, HexRow[]>();
/** When set (via HUD), pan/zoom keeps this full table instead of viewport queries */
let lockedFullRes: number | null = null;
let overlay: MapboxOverlay | null = null;
let paintedResolution: number | null = null;
let mapRef: maplibregl.Map | null = null;
let mapReady = false;
let fullLoadBusy = false;
let activeDggs: DggsId = DEFAULT_DGGS;
let activeEngine: PopEngine = "wasm";

function gridLabel(resolution: number, dggs: DggsId = activeDggs) {
  return `${DGGS[dggs].cellColumn}_${resolution}`;
}

function fullCacheKey(resolution: number) {
  return `${activeEngine}:${activeDggs}:${resolution}`;
}

type PendingFull = {
  resolution: number;
  rows: HexRow[];
  elapsedMs: number;
};
let pendingFull: PendingFull | null = null;

function setHexLayer(rows: HexRow[], resolution: number) {
  paintedRows = rows;
  paintedResolution = resolution;
  const triggerKey = `${activeDggs}:${activePalette}:${resolution}`;
  const common = {
    data: rows,
    getFillColor: (d: HexRow) => populationColor(d.population, resolution),
    getLineColor: [20, 20, 20, 90] as Color,
    lineWidthMinPixels: 0.35,
    stroked: true,
    filled: true,
    extruded: false,
    pickable: true,
    updateTriggers: {
      getFillColor: triggerKey,
      data: `${triggerKey}:${rows.length}`,
    },
  };
  const layer =
    activeDggs === "a5"
      ? new A5Layer<HexRow>({
          id: `a5-pop-r${resolution}`,
          getPentagon: (d) => d.hex,
          ...common,
        })
      : activeDggs === "s2"
        ? new S2Layer<HexRow>({
            id: `s2-pop-r${resolution}`,
            getS2Token: (d) => d.hex,
            ...common,
          })
        : new H3HexagonLayer<HexRow>({
            id: `h3-pop-r${resolution}`,
            getHexagon: (d) => d.hex,
            highPrecision: true,
            coverage: 1,
            ...common,
          });
  overlay?.setProps({ layers: [layer] });
}

function clearHexLayer() {
  paintedRows = null;
  paintedResolution = null;
  overlay?.setProps({ layers: [] });
}

function syncFullLoadUi() {
  const confirm = document.getElementById("render-confirm");
  const warn = document.getElementById("render-warn");
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-full-res]");
  const cfg = DGGS[activeDggs];

  if (confirm && warn) {
    if (pendingFull) {
      confirm.hidden = false;
      warn.textContent =
        `Loaded ${pendingFull.rows.length.toLocaleString()} cells` +
        ` in ${Math.round(pendingFull.elapsedMs)}ms. ` +
        `Rendering the full grid may freeze the browser for a while.`;
    } else {
      confirm.hidden = true;
      warn.textContent = "";
    }
  }

  for (const btn of buttons) {
    const dggs = parseDggs(btn.dataset.dggs) ?? "h3";
    const res = Number(btn.dataset.fullRes);
    btn.hidden = dggs !== activeDggs;
    btn.disabled = fullLoadBusy || pendingFull != null;
    const active =
      res === cfg.adaptiveResolution
        ? lockedFullRes == null
        : lockedFullRes === res;
    btn.classList.toggle("active", !btn.hidden && active);
  }
}

function applyFullTable(
  resolution: number,
  rows: HexRow[],
  elapsedMs?: number,
) {
  lockedFullRes = resolution;
  pendingFull = null;
  setHexLayer(rows, resolution);
  const timing =
    elapsedMs != null ? ` · ${Math.round(elapsedMs)}ms` : " (cached)";
  setStatus(
    `${gridLabel(resolution)} · ${rows.length.toLocaleString()} cells${timing}`,
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

function isPopResolution(n: number): boolean {
  return DGGS[activeDggs].isResolution(n);
}

async function requestFullTable(resolution: number) {
  if (activeEngine === "vector") return;
  if (fullLoadBusy) return;
  const cfg = DGGS[activeDggs];

  // Adaptive button restores zoom-based loading (full coarse grid at low z)
  if (resolution === cfg.adaptiveResolution) {
    if (lockedFullRes == null && pendingFull == null) {
      if (mapRef) void refresh(mapRef);
      return;
    }
    exitLockedFull();
    return;
  }

  // Clicking the active locked grid unlocks back to adaptive mode
  if (lockedFullRes === resolution && pendingFull == null) {
    exitLockedFull();
    return;
  }

  fullLoadBusy = true;
  pendingFull = null;
  syncFullLoadUi();

  try {
    const cached = fullCache.get(fullCacheKey(resolution));
    if (cached) {
      if (cached.length > RENDER_WARNING_CELLS) {
        pendingFull = { resolution, rows: cached, elapsedMs: 0 };
        setStatus(`${gridLabel(resolution)} ready - confirm to render`);
        syncFullLoadUi();
        return;
      }
      applyFullTable(resolution, cached);
      return;
    }

    setStatus(`Loading full ${gridLabel(resolution)}…`);
    const t0 = performance.now();
    const { rows } = await loadPopulation({
      resolution,
      all: true,
    });
    const elapsedMs = performance.now() - t0;
    fullCache.set(fullCacheKey(resolution), rows);

    if (rows.length > RENDER_WARNING_CELLS) {
      pendingFull = { resolution, rows, elapsedMs };
      setStatus(`${gridLabel(resolution)} ready - confirm to render`);
      syncFullLoadUi();
      return;
    }

    applyFullTable(resolution, rows, elapsedMs);
  } catch (err) {
    setStatus(
      err instanceof Error ? err.message : `Failed to load ${gridLabel(resolution)}`,
      "err",
    );
  } finally {
    fullLoadBusy = false;
    syncFullLoadUi();
  }
}

let requestSeq = 0;

async function refresh(map: maplibregl.Map) {
  if (activeEngine === "vector") {
    const zoom = map.getZoom();
    const res = vectorResolutionForZoom(zoom);
    setStatus(`z${zoom.toFixed(1)} · h3_${res} · PMTiles`);
    syncDggsUi();
    return;
  }

  const cfg = DGGS[activeDggs];

  // Manual full-grid lock — don't clobber with viewport queries
  if (lockedFullRes != null) {
    const rows = fullCache.get(fullCacheKey(lockedFullRes));
    if (rows) {
      if (paintedResolution !== lockedFullRes) setHexLayer(rows, lockedFullRes);
      setStatus(
        `${gridLabel(lockedFullRes)} (locked) · ${rows.length.toLocaleString()} cells`,
      );
    }
    return;
  }

  const zoom = map.getZoom();
  const resolution = cfg.resolutionForZoom(zoom);
  const seq = ++requestSeq;
  const dggsAtStart = activeDggs;
  const engineAtStart = activeEngine;

  try {
    if (zoom < cfg.fullTableZoom) {
      let rows = fullCache.get(fullCacheKey(cfg.adaptiveResolution)) ?? null;
      if (!rows) {
        setStatus(
          `Loading full ${gridLabel(cfg.adaptiveResolution)}…`,
        );
        const loaded = await loadPopulation({
          resolution: cfg.adaptiveResolution,
          all: true,
        });
        if (seq !== requestSeq || activeDggs !== dggsAtStart || activeEngine !== engineAtStart)
          return;
        rows = loaded.rows;
        fullCache.set(fullCacheKey(cfg.adaptiveResolution), rows);
      }
      if (paintedResolution !== cfg.adaptiveResolution) {
        setHexLayer(rows, cfg.adaptiveResolution);
      }
      setStatus(
        `z${zoom.toFixed(1)} · full ${gridLabel(cfg.adaptiveResolution)} · ${rows.length.toLocaleString()} cells`,
      );
      syncFullLoadUi();
      return;
    }

    if (paintedResolution !== null && paintedResolution !== resolution) {
      clearHexLayer();
    }

    const canvas = map.getCanvas();
    const ul = map.unproject([0, 0]).toArray() as [number, number];
    const lr = map
      .unproject([canvas.width, canvas.height])
      .toArray() as [number, number];
    const bounds = boundsFromMapCorners(ul, lr);

    setStatus(
      `Querying viewport ∩ ${gridLabel(resolution)}…`,
    );

    const { rows, viewportIds } = await loadPopulation({
      resolution,
      bounds,
    });
    if (seq !== requestSeq || activeDggs !== dggsAtStart || activeEngine !== engineAtStart)
      return;

    setHexLayer(rows, resolution);

    setStatus(
      `z${zoom.toFixed(1)} · ${gridLabel(resolution)} · ${viewportIds.toLocaleString()} viewport IDs · ${rows.length.toLocaleString()} matched`,
    );
    syncFullLoadUi();
  } catch (err) {
    if (seq !== requestSeq || activeDggs !== dggsAtStart || activeEngine !== engineAtStart)
      return;
    setStatus(
      err instanceof Error ? err.message : "Failed to load population",
      "err",
    );
  }
}

function syncVectorModeUi() {
  const vector = activeEngine === "vector";
  const dggsSelect = document.getElementById("dggs") as HTMLSelectElement | null;
  if (dggsSelect) dggsSelect.disabled = vector;

  const fullLoad = document.querySelector<HTMLElement>(".full-load");
  if (fullLoad) fullLoad.hidden = vector;

  const help = document.getElementById("dggs-help");
  if (help) {
    help.innerHTML = vector ? VECTOR_HELP_HTML : DGGS[activeDggs].helpHtml;
  }
}

function syncDggsUi() {
  const select = document.getElementById("dggs") as HTMLSelectElement | null;
  if (select) select.value = activeDggs;
  syncVectorModeUi();
  syncFullLoadUi();
}

async function setActiveEngine(engine: PopEngine) {
  if (engine === activeEngine) return;
  activeEngine = engine;
  const select = document.getElementById("engine") as HTMLSelectElement | null;
  if (select) select.value = activeEngine;
  document.querySelectorAll<HTMLButtonElement>("[data-engine]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.engine === activeEngine);
  });

  if (engine === "vector") {
    activeDggs = "h3";
    pendingFull = null;
    lockedFullRes = null;
    requestSeq += 1;
    clearHexLayer();
    syncDggsUi();
    if (mapRef && !(await applyMapStyle(mapRef))) void refresh(mapRef);
    return;
  }

  pendingFull = null;
  lockedFullRes = null;
  requestSeq += 1;
  clearHexLayer();
  syncDggsUi();
  if (mapRef && !(await applyMapStyle(mapRef))) void refresh(mapRef);
}

async function setActiveDggs(dggs: DggsId) {
  if (activeEngine === "vector") return;
  if (dggs === activeDggs) return;
  activeDggs = dggs;
  pendingFull = null;
  lockedFullRes = null;
  requestSeq += 1;
  clearHexLayer();
  syncDggsUi();
  if (mapRef) void refresh(mapRef);
}

function wireFullLoadControls() {
  document.querySelectorAll<HTMLButtonElement>("[data-full-res]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const res = Number(btn.dataset.fullRes);
      if (isPopResolution(res)) void requestFullTable(res);
    });
  });

  document.getElementById("render-anyway")?.addEventListener("click", () => {
    if (!pendingFull) return;
    const { resolution, rows, elapsedMs } = pendingFull;
    applyFullTable(resolution, rows, elapsedMs || undefined);
  });

  document.getElementById("render-cancel")?.addEventListener("click", () => {
    cancelPendingFull();
  });

  const engineSelect = document.getElementById("engine") as HTMLSelectElement | null;
  if (engineSelect) {
    engineSelect.value = activeEngine;
    engineSelect.addEventListener("change", () => {
      void setActiveEngine(parseEngine(engineSelect.value));
    });
  }

  const dggsSelect = document.getElementById("dggs") as HTMLSelectElement | null;
  if (dggsSelect) {
    dggsSelect.value = activeDggs;
    dggsSelect.addEventListener("change", () => {
      const next = parseDggs(dggsSelect.value);
      if (next) void setActiveDggs(next);
    });
  }

  const paletteSelect = document.getElementById("palette") as HTMLSelectElement | null;
  if (paletteSelect) {
    paletteSelect.value = activePalette;
    paletteSelect.addEventListener("change", () => {
      setPalette(paletteSelect.value as PaletteId);
    });
  }
  syncLegendRamp();

  const hud = document.querySelector(".hud");
  const hideBtn = document.getElementById("hide-panel");
  const showBtn = document.getElementById("show-panel");
  hideBtn?.addEventListener("click", () => {
    hud?.setAttribute("hidden", "");
    showBtn?.removeAttribute("hidden");
  });
  showBtn?.addEventListener("click", () => {
    hud?.removeAttribute("hidden");
    showBtn.setAttribute("hidden", "");
  });

  syncDggsUi();
}

const INITIAL_CENTER: [number, number] = [105.85, 21.03];
const INITIAL_ZOOM = 1;

export async function initPopMap(container: HTMLElement) {
  ensurePmtilesProtocol();
  wireFullLoadControls();

  setStatus("Loading style…");
  let initialStyle;
  try {
    initialStyle = await loadGithubStyle(activeEngine === "vector", activePalette);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Failed to load style", "err");
    return;
  }

  loadedStyleKey = styleKey(activeEngine === "vector", activePalette);
  const map = new maplibregl.Map({
    container,
    style: initialStyle,
    center: INITIAL_CENTER,
    zoom: INITIAL_ZOOM,
    minZoom: 0,
    maxZoom: 16,
    transformRequest: (url) => ({ url: rewriteVstylesUrl(url) }),
  });
  mapRef = map;

  map.addControl(new maplibregl.FullscreenControl(), "top-right");
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
    if (mapReady) void refresh(map);
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
      if (activeEngine === "vector") return;
      if (!info.object || info.x == null || info.y == null) {
        hideTip();
        return;
      }
      showTip(info.object, info.x, info.y);
    },
  });

  map.on("mousemove", (e) => {
    if (activeEngine !== "vector") return;
    const layers = VECTOR_LAYER_IDS.filter((id) => map.getLayer(id));
    if (!layers.length) {
      hideTip();
      return;
    }
    const feat = map.queryRenderedFeatures(e.point, { layers })[0];
    if (!feat) {
      hideTip();
      return;
    }
    const props = feat.properties ?? {};
    showTip(
      { hex: String(props.h3 ?? ""), population: Number(props.population) },
      e.point.x,
      e.point.y,
    );
  });
  map.on("mouseout", () => {
    if (activeEngine !== "vector") return;
    hideTip();
  });

  map.on("load", () => {
    mapReady = true;
    if (overlay) map.addControl(overlay);
    void refresh(map);
  });

  let moveTimer: ReturnType<typeof setTimeout> | undefined;
  map.on("moveend", () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => void refresh(map), 180);
  });

  return map;
}
