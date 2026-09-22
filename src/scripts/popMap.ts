import * as maplibregl from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { A5Layer, H3HexagonLayer, S2Layer } from "@deck.gl/geo-layers";
import type { Color, PickingInfo } from "@deck.gl/core";
import { getResolution } from "h3-js";
import {
  boundsFromLngLatBounds,
  h3IdsInBounds,
} from "../lib/h3Viewport";
import {
  DGGS,
  DGGS_IDS,
  DEFAULT_DGGS,
  parseDggs,
  type DggsId,
} from "../lib/dggs";
import { lookupAllPopulation, lookupPopulation, runUserSql } from "../lib/clientDuckdb";
import { MapLibreControlZoomHome } from "../lib/MapLibreControlZoomHome";
import {
  PALETTE_HEX,
  VECTOR_LAYER_IDS,
  loadGithubStyle,
  rewriteVstylesUrl,
  styleKey,
  type PaletteId,
} from "../lib/mapStyle";
import {
  NONE_GEOM_OUTLINE_LAYER,
  NONE_GEOM_FILL_LAYER,
  NONE_GEOM_SOURCE,
  setNoneGeomProtocol,
  updateNoneGeomPopulation,
} from "../lib/noneGeomTiles";
import {
  defaultAggregateSql,
  defaultDggsSql,
  highlightSqlHtml,
  inferDggsFromSql,
  isAdaptiveH3Sql,
  type SqlPopRow,
} from "../lib/sqlPlayground";

maplibregl.config.WORKER_URL = maplibreWorkerUrl;

export type { PaletteId };

export type PopEngine = "wasm" | "native" | "vector" | "none-geom";

function parseEngine(value: string | null): PopEngine {
  if (value === "native" || value === "vector" || value === "none-geom") {
    return value;
  }
  return "wasm";
}

function isVectorEngine() {
  return activeEngine === "vector";
}

function isNoneGeomEngine() {
  return activeEngine === "none-geom";
}

function locksH3Tiles() {
  return isVectorEngine() || isNoneGeomEngine();
}

function usesDeckOverlay() {
  return !isVectorEngine();
}

function isDuckEngine() {
  return activeEngine === "wasm" || activeEngine === "native";
}

/** Same idea as A5 duckdb-playground: warn before tessellating huge results */
const RENDER_WARNING_CELLS = 200_000;

let pmtilesProtocol: Protocol | null = null;
function ensurePmtilesProtocol() {
  if (pmtilesProtocol) return pmtilesProtocol;
  pmtilesProtocol = new Protocol();
  maplibregl.addProtocol("pmtiles", pmtilesProtocol.tile);
  return pmtilesProtocol;
}

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
  const value = Number(pop);
  const t = Number.isFinite(value)
    ? Math.min(1, Math.max(0, Math.log10(Math.max(value, 1)) / logMax))
    : 0;
  const s = t * (ramp.length - 1);
  const i = Math.min(Math.floor(s), ramp.length - 2);
  const f = s - i;
  const [r0, g0, b0] = ramp[i];
  const [r1, g1, b1] = ramp[i + 1];
  return [
    Math.round(r0 + (r1 - r0) * f),
    Math.round(g0 + (g1 - g0) * f),
    Math.round(b0 + (b1 - b0) * f),
    255,
  ];
}

let loadedStyleKey = "";

function currentStyleKey() {
  return styleKey(activeEngine === "vector", activePalette);
}

async function applyMapStyle(map: maplibregl.Map): Promise<boolean> {
  const key = currentStyleKey();
  if (key === loadedStyleKey) return false;
  loadedStyleKey = key;
  try {
    const style = await loadGithubStyle(activeEngine === "vector", activePalette);
    if (currentStyleKey() !== key) return false;
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

function viewStatus(zoom: number, resolution: number): string {
  return `z${zoom.toFixed(1)} · ${gridLabel(resolution)}`;
}

function syncLegendRamp() {
  const el = document.querySelector<HTMLElement>(".ramp");
  if (el) el.style.background = `linear-gradient(90deg, ${PALETTE_HEX[activePalette].join(", ")})`;
}

function setPalette(id: PaletteId) {
  if (!(id in PALETTE_HEX)) return;
  activePalette = id;
  syncLegendRamp();
  if (isVectorEngine()) {
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

/** Cached full tables keyed by `${engine}:${dggs}:${resolution}` */
const fullCache = new Map<string, HexRow[]>();
let holdFullTotalStatus = false;
let overlay: MapboxOverlay | null = null;
let paintedResolution: number | null = null;
let sqlLayerEpoch = 0;
let mapRef: maplibregl.Map | null = null;
let mapReady = false;
let activeDggs: DggsId = DEFAULT_DGGS;
let activeEngine: PopEngine = "wasm";
/** User SQL result — pan/zoom must not replace the query layer */
let sqlLock = false;
let sqlBusy = false;
let sqlPaintDggs: DggsId | null = null;
type PendingSql = { rows: HexRow[]; resolution: number; elapsedMs: number };
let pendingSql: PendingSql | null = null;
/** Which Samples chip is highlighted, e.g. "h3:4" or "h3:agg" */
let activeSampleKey: string | null = "h3:4";

function gridLabel(resolution: number, dggs: DggsId = activeDggs) {
  return `${DGGS[dggs].cellColumn}_${resolution}`;
}

function paintDggs(): DggsId {
  return sqlLock && sqlPaintDggs ? sqlPaintDggs : activeDggs;
}

function fullCacheKey(resolution: number) {
  return `${activeEngine}:${activeDggs}:${resolution}`;
}

function a5PentagonId(hex: string): string | bigint {
  const s = hex.replace(/^0x/i, "");
  if (s && /^[0-9a-f]+$/i.test(s)) {
    try {
      return BigInt(`0x${s}`);
    } catch {
      return hex;
    }
  }
  return hex;
}

function setHexLayer(rows: HexRow[], resolution: number) {
  paintedRows = rows;
  paintedResolution = resolution;
  if (!overlay || !usesDeckOverlay()) return;
  if (mapRef) ensureDeckOverlay(mapRef);
  if (mapRef && !mapRef.hasControl(overlay)) return;
  if (!rows.length) {
    try {
      overlay.setProps({ layers: [] });
    } catch {
      /* empty hex layer can throw in luma while tearing down */
    }
    return;
  }
  const layerDggs = paintDggs();
  sqlLayerEpoch += 1;
  const triggerKey = `${activeEngine}:${layerDggs}:${activePalette}:${resolution}:${rows.length}:${sqlLayerEpoch}`;
  const common = {
    data: rows,
    getFillColor: (d: HexRow) => populationColor(d.population, resolution),
    getLineColor: [20, 20, 20, 90] as Color,
    lineWidthMinPixels: 0.35,
    stroked: true,
    filled: true,
    extruded: false,
    wireframe: false,
    material: false,
    pickable: true,
    parameters: {
      depthTest: true,
      depthCompare: "less-equal" as const,
      depthWriteEnabled: true,
      cullMode: "back" as const,
    },
    updateTriggers: {
      getFillColor: triggerKey,
      data: triggerKey,
    },
  };
  const layer =
    layerDggs === "a5"
      ? new A5Layer<HexRow>({
          id: `${activeEngine}-a5-pop-r${resolution}-${activePalette}-${sqlLayerEpoch}`,
          getPentagon: (d) => a5PentagonId(d.hex),
          ...common,
        })
      : layerDggs === "s2"
        ? new S2Layer<HexRow>({
            id: `${activeEngine}-s2-pop-r${resolution}-${activePalette}-${sqlLayerEpoch}`,
            getS2Token: (d) => d.hex,
            ...common,
          })
        : new H3HexagonLayer<HexRow>({
            id: `${activeEngine}-h3-pop-r${resolution}-${activePalette}-${sqlLayerEpoch}`,
            getHexagon: (d) => d.hex,
            highPrecision: true,
            coverage: 1,
            ...common,
          });
  try {
    overlay.setProps({ layers: [layer] });
  } catch {
    /* overlay WebGL attributes may already be gone */
  }
}

function ensureDeckOverlay(map: maplibregl.Map) {
  if (!overlay || !usesDeckOverlay()) return;
  if (!map.hasControl(overlay)) map.addControl(overlay);
}

function clearHexLayer() {
  paintedRows = null;
  paintedResolution = null;
  try {
    if (overlay && mapRef?.hasControl(overlay)) overlay.setProps({ layers: [] });
  } catch {
    /* overlay is detached */
  }
}

function hideDeckOverlay(map: maplibregl.Map) {
  try {
    if (overlay && map.hasControl(overlay)) {
      map.removeControl(overlay);
    }
  } catch {
    /* overlay already gone */
  }
  paintedRows = null;
  paintedResolution = null;
}

function removeNoneGeomLayers(map: maplibregl.Map) {
  if (map.getLayer(NONE_GEOM_OUTLINE_LAYER)) map.removeLayer(NONE_GEOM_OUTLINE_LAYER);
  if (map.getLayer(NONE_GEOM_FILL_LAYER)) map.removeLayer(NONE_GEOM_FILL_LAYER);
  if (map.getSource(NONE_GEOM_SOURCE)) map.removeSource(NONE_GEOM_SOURCE);
}

function syncFullLoadUi() {
  const confirm = document.getElementById("render-confirm");
  const warn = document.getElementById("render-warn");
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-full-res]");

  if (confirm && warn) {
    const pending = pendingSql;
    if (pending) {
      confirm.hidden = false;
      const n = pending.rows.length.toLocaleString();
      const loadNote =
        pending.elapsedMs > 0
          ? ` in ${Math.round(pending.elapsedMs)}ms`
          : " (cached)";
      warn.textContent =
        `Loaded ${n} cells${loadNote}. ` +
        `Rendering this many may temporarily freeze the browser.`;
    } else {
      confirm.hidden = true;
      warn.textContent = "";
    }
  }

  for (const btn of buttons) {
    const dggs = parseDggs(btn.dataset.dggs) ?? "h3";
    btn.hidden = dggs !== activeDggs;
    btn.disabled = sqlBusy;
    const res = Number(btn.dataset.fullRes);
    btn.classList.toggle(
      "active",
      !btn.hidden && activeSampleKey === `${dggs}:${res}`,
    );
  }

  document.querySelectorAll<HTMLButtonElement>("[data-sql-agg]").forEach((btn) => {
    const dggs = parseDggs(btn.dataset.dggs) ?? "h3";
    btn.hidden = dggs !== activeDggs;
    btn.disabled = sqlBusy || !isDuckEngine();
    btn.classList.toggle(
      "active",
      !btn.hidden && activeSampleKey === `${dggs}:agg`,
    );
  });
}

function announceFullTotal(
  resolution: number,
  rows: HexRow[],
  elapsedMs?: number,
) {
  holdFullTotalStatus = true;
  const timing =
    elapsedMs == null ? "" : elapsedMs > 0 ? ` · ${Math.round(elapsedMs)}ms` : " (cached)";
  setStatus(
    `${gridLabel(resolution)} · ${rows.length.toLocaleString()} cells${timing}`,
  );
}

function cancelPendingFull() {
  const restoreSql = pendingSql != null && sqlLock;
  pendingSql = null;
  setStatus("Rendering cancelled — add an aggregation (e.g. h3_cell_to_parent) to reduce the cell count");
  if (restoreSql) {
    clearSqlLock();
    if (mapRef) void refresh(mapRef);
  }
  syncFullLoadUi();
}

function clearSqlLock() {
  sqlLock = false;
  sqlPaintDggs = null;
  pendingSql = null;
}

function sqlRunShortcut(): string {
  return /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘⏎" : "Ctrl+Enter";
}

function resolutionFromSqlRows(rows: HexRow[], dggs: DggsId): number {
  if (dggs === "h3" && rows[0]) {
    try {
      return getResolution(rows[0].hex);
    } catch {
      /* hex conversion may still leave a non-H3 id */
    }
  }
  return DGGS[dggs].adaptiveResolution;
}

function sqlFingerprint(sql: string): string {
  return sql
    .replace(/;+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sampleKeyFromSql(sql: string): string | null {
  if (isAdaptiveH3Sql(sql)) return "h3:4";
  const fp = sqlFingerprint(sql);
  if (fp === sqlFingerprint(defaultAggregateSql("h3"))) return "h3:agg";
  if (fp === sqlFingerprint(defaultAggregateSql("a5"))) return "a5:agg";
  if (fp === sqlFingerprint(defaultAggregateSql("s2"))) return "s2:agg";
  for (const dggs of DGGS_IDS) {
    for (const res of DGGS[dggs].fullLoadResolutions) {
      if (fp === sqlFingerprint(sampleTableSql(dggs, res))) {
        return `${dggs}:${res}`;
      }
    }
  }
  return null;
}

function applyAdaptiveH3Result(rows: HexRow[], elapsedMs: number) {
  clearSqlLock();
  pendingSql = null;
  if (activeDggs !== "h3") {
    activeDggs = "h3";
    syncDggsUi();
  }
  activeSampleKey = "h3:4";
  fullCache.set(fullCacheKey(DGGS.h3.adaptiveResolution), rows);
  announceFullTotal(DGGS.h3.adaptiveResolution, rows, elapsedMs);
  syncFullLoadUi();
  if (mapRef) void refresh(mapRef);
  else setHexLayer(rows, DGGS.h3.adaptiveResolution);
}

function applySqlResult(rows: HexRow[], resolution: number, elapsedMs: number) {
  sqlLock = true;
  pendingSql = null;
  holdFullTotalStatus = true;
  requestSeq += 1;
  const editor = document.getElementById(
    "sql-editor",
  ) as HTMLTextAreaElement | null;
  activeSampleKey = editor ? sampleKeyFromSql(editor.value) : null;
  clearHexLayer();
  setHexLayer(rows, resolution);
  setStatus(
    `${rows.length.toLocaleString()} cells · ${Math.round(elapsedMs)}ms`,
  );
  syncFullLoadUi();
}

function paintSqlHighlight() {
  const editor = document.getElementById(
    "sql-editor",
  ) as HTMLTextAreaElement | null;
  const highlight = document.getElementById("sql-highlight");
  if (!editor || !highlight) return;
  highlight.innerHTML = highlightSqlHtml(editor.value);
  highlight.scrollTop = editor.scrollTop;
  highlight.scrollLeft = editor.scrollLeft;
}

function setSqlEditorValue(sql: string) {
  const editor = document.getElementById(
    "sql-editor",
  ) as HTMLTextAreaElement | null;
  if (!editor) return;
  editor.value = sql;
  paintSqlHighlight();
  activeSampleKey = sampleKeyFromSql(sql);
  syncFullLoadUi();
}

function syncSqlEditor(resetText: boolean) {
  const panel = document.getElementById("sql-panel");
  if (panel) panel.hidden = !isDuckEngine();

  const editor = document.getElementById(
    "sql-editor",
  ) as HTMLTextAreaElement | null;
  if (editor && (resetText || !editor.value.trim())) {
    setSqlEditorValue(defaultDggsSql(activeDggs));
  } else {
    paintSqlHighlight();
  }

  const runBtn = document.getElementById("sql-run") as HTMLButtonElement | null;
  if (runBtn) {
    runBtn.textContent = sqlBusy ? "Running…" : `Run ${sqlRunShortcut()}`;
    runBtn.disabled = sqlBusy || !isDuckEngine();
  }
}

async function loadSqlNative(sql: string): Promise<SqlPopRow[]> {
  const remote = remoteNativeEndpoint();
  const res =
    (await postNativeApi("/api/population", { sql })) ??
    (remote ? await postNativeApi(remote, { sql }) : null);
  if (!res) {
    throw new Error(
      "Native DuckDB API is unreachable. Use DuckDB WASM, run the Node server, or set PUBLIC_NATIVE_API_URL.",
    );
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  if (Array.isArray(data.rows)) return data.rows as SqlPopRow[];
  const population = (data.population ?? {}) as Record<string, number>;
  const rows: SqlPopRow[] = [];
  for (const hex in population) {
    rows.push({ hex, population: Number(population[hex]) });
  }
  return rows;
}

async function runSqlQuery() {
  if (!isDuckEngine() || sqlBusy) return;
  const editor = document.getElementById(
    "sql-editor",
  ) as HTMLTextAreaElement | null;
  const sql = (editor?.value ?? "").trim();
  if (!sql) {
    setStatus("Enter a SELECT query", "warn");
    return;
  }

  sqlBusy = true;
  pendingSql = null;
  requestSeq += 1;
  sqlLock = true;
  clearHexLayer();
  syncSqlEditor(false);
  syncFullLoadUi();
  setStatus("Running query…");
  try {
    const t0 = performance.now();
    const rows =
      activeEngine === "native"
        ? await loadSqlNative(sql)
        : await runUserSql(sql);
    const elapsedMs = performance.now() - t0;
    const dggs = inferDggsFromSql(sql) ?? activeDggs;
    const resolution = resolutionFromSqlRows(rows, dggs);
    if (!rows.length) {
      sqlLock = true;
      sqlPaintDggs = dggs;
      setHexLayer([], resolution);
      setStatus("Query returned 0 cells", "warn");
      return;
    }
    if (isAdaptiveH3Sql(sql)) {
      applyAdaptiveH3Result(rows, elapsedMs);
      return;
    }
    sqlPaintDggs = dggs;
    if (rows.length > RENDER_WARNING_CELLS) {
      pendingSql = { rows, resolution, elapsedMs };
      setStatus("");
      syncFullLoadUi();
      return;
    }
    applySqlResult(rows, resolution, elapsedMs);
  } catch (err) {
    clearSqlLock();
    setStatus(err instanceof Error ? err.message : "Query failed", "err");
    if (mapRef) void refresh(mapRef);
  } finally {
    sqlBusy = false;
    syncSqlEditor(false);
    syncFullLoadUi();
    document.getElementById("sql-editor")?.blur();
    if (mapRef) mapRef.getCanvas().style.cursor = "";
  }
}

let requestSeq = 0;
let noneGeomRequestId = 0;

function refreshAfterIdle(map: maplibregl.Map) {
  map.once("idle", () => {
    if (isNoneGeomEngine()) void refresh(map);
  });
}

async function refreshNoneGeom(map: maplibregl.Map) {
  if (!map.isStyleLoaded()) {
    refreshAfterIdle(map);
    return;
  }
  const currentRequest = ++noneGeomRequestId;
  try {
    ensureDeckOverlay(map);
    removeNoneGeomLayers(map);
    const mapBounds = map.getBounds();
    const result = await updateNoneGeomPopulation({
      west: mapBounds.getWest(),
      south: mapBounds.getSouth(),
      east: mapBounds.getEast(),
      north: mapBounds.getNorth(),
      mapZoom: map.getZoom(),
    });
    if (currentRequest !== noneGeomRequestId) return;
    let resolution = 4;
    if (result.rows[0]) {
      try {
        resolution = getResolution(result.rows[0].hex);
      } catch {
        resolution = 4;
      }
    }
    if (result.skipped) {
      setHexLayer([], resolution);
      setStatus(`Zoom in to load H3 cells (${result.tileCount} tiles)`);
      syncDggsUi();
      return;
    }
    setHexLayer(result.rows, resolution);
    paintedResolution = resolution;
    setStatus(
      `z${map.getZoom().toFixed(1)} · h3_${resolution} · ${result.tileCount} XYZ tiles`,
    );
    syncDggsUi();
  } catch (err) {
    if (currentRequest !== noneGeomRequestId) return;
    setStatus(
      err instanceof Error ? err.message : "Failed to render H3 cells",
      "err",
    );
  }
}

async function refresh(map: maplibregl.Map) {
  if (isVectorEngine()) {
    setStatus(viewStatus(map.getZoom(), vectorResolutionForZoom(map.getZoom())));
    syncDggsUi();
    return;
  }

  if (isNoneGeomEngine()) {
    await refreshNoneGeom(map);
    return;
  }

  const cfg = DGGS[activeDggs];

  if (sqlLock) return;

  const zoom = map.getZoom();
  const resolution = cfg.resolutionForZoom(zoom);
  const seq = ++requestSeq;
  const dggsAtStart = activeDggs;
  const engineAtStart = activeEngine;

  try {
    if (zoom < cfg.fullTableZoom) {
      let rows = fullCache.get(fullCacheKey(cfg.adaptiveResolution)) ?? null;
      let elapsedMs: number | undefined;
      if (!rows) {
        setStatus(
          `Loading full ${gridLabel(cfg.adaptiveResolution)}…`,
        );
        const t0 = performance.now();
        const loaded = await loadPopulation({
          resolution: cfg.adaptiveResolution,
          all: true,
        });
        elapsedMs = performance.now() - t0;
        if (seq !== requestSeq || sqlLock || activeDggs !== dggsAtStart || activeEngine !== engineAtStart)
          return;
        rows = loaded.rows;
        fullCache.set(fullCacheKey(cfg.adaptiveResolution), rows);
      }
      if (sqlLock) return;
      if (paintedResolution !== cfg.adaptiveResolution) {
        setHexLayer(rows, cfg.adaptiveResolution);
      }
      if (elapsedMs != null) {
        announceFullTotal(cfg.adaptiveResolution, rows, elapsedMs);
      } else if (!holdFullTotalStatus) {
        setStatus(viewStatus(zoom, cfg.adaptiveResolution));
      }
      syncFullLoadUi();
      return;
    }

    holdFullTotalStatus = false;

    if (paintedResolution !== null && paintedResolution !== resolution) {
      clearHexLayer();
    }

    const bounds = boundsFromLngLatBounds(map.getBounds());

    const { rows } = await loadPopulation({
      resolution,
      bounds,
    });
    if (seq !== requestSeq || sqlLock || activeDggs !== dggsAtStart || activeEngine !== engineAtStart)
      return;

    setHexLayer(rows, resolution);

    setStatus(viewStatus(zoom, resolution));
    syncFullLoadUi();
  } catch (err) {
    if (seq !== requestSeq || sqlLock || activeDggs !== dggsAtStart || activeEngine !== engineAtStart)
      return;
    setStatus(
      err instanceof Error ? err.message : "Failed to load population",
      "err",
    );
  }
}

function syncVectorModeUi() {
  const tileMode = locksH3Tiles();
  const dggsSelect = document.getElementById("dggs") as HTMLSelectElement | null;
  if (dggsSelect) dggsSelect.disabled = tileMode;

  const samplesRow = document.getElementById("samples-row");
  if (samplesRow) samplesRow.hidden = tileMode;

  const sqlPanel = document.getElementById("sql-panel");
  if (sqlPanel) sqlPanel.hidden = !isDuckEngine();
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

  if (locksH3Tiles()) {
    activeDggs = "h3";
  }
  if (mapRef) {
    if (usesDeckOverlay()) {
      ensureDeckOverlay(mapRef);
    } else {
      hideDeckOverlay(mapRef);
    }
    removeNoneGeomLayers(mapRef);
  }

  pendingSql = null;
  holdFullTotalStatus = false;
  clearSqlLock();
  requestSeq += 1;
  clearHexLayer();
  setSqlEditorValue(defaultDggsSql(activeDggs));
  syncDggsUi();
  syncSqlEditor(false);
  if (!mapRef) return;
  const restyled = await applyMapStyle(mapRef);
  if (!restyled) void refresh(mapRef);
  if (isNoneGeomEngine()) refreshAfterIdle(mapRef);
}

async function setActiveDggs(dggs: DggsId) {
  if (locksH3Tiles()) return;
  if (dggs === activeDggs) return;
  activeDggs = dggs;
  pendingSql = null;
  holdFullTotalStatus = false;
  clearSqlLock();
  requestSeq += 1;
  clearHexLayer();
  syncDggsUi();
  setSqlEditorValue(defaultDggsSql(dggs));
  syncSqlEditor(false);
  if (mapRef) void refresh(mapRef);
}

function sampleTableSql(dggs: DggsId, res: number): string {
  const col = DGGS[dggs].cellColumn;
  return `SELECT ${col}, population
FROM ${dggs}_${res}`;
}

function wireFullLoadControls() {
  document.querySelectorAll<HTMLButtonElement>("[data-full-res]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dggs = parseDggs(btn.dataset.dggs) ?? activeDggs;
      const res = Number(btn.dataset.fullRes);
      if (!Number.isInteger(res)) return;
      setSqlEditorValue(sampleTableSql(dggs, res));
    });
  });

  document.getElementById("render-anyway")?.addEventListener("click", () => {
    if (pendingSql) {
      const { rows, resolution, elapsedMs } = pendingSql;
      applySqlResult(rows, resolution, elapsedMs);
    }
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

  const editor = document.getElementById(
    "sql-editor",
  ) as HTMLTextAreaElement | null;
  editor?.addEventListener("input", paintSqlHighlight);
  editor?.addEventListener("scroll", paintSqlHighlight);
  editor?.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void runSqlQuery();
    }
  });
  document.getElementById("sql-run")?.addEventListener("click", () => {
    void runSqlQuery();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-sql-agg]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dggs = parseDggs(btn.dataset.dggs) ?? activeDggs;
      const sql = defaultAggregateSql(dggs);
      setSqlEditorValue(sql);
    });
  });
  syncSqlEditor(true);

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
  setNoneGeomProtocol(ensurePmtilesProtocol());
  wireFullLoadControls();

  let initialStyle;
  try {
    initialStyle = await loadGithubStyle(activeEngine === "vector", activePalette);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Failed to load style", "err");
    return;
  }

  loadedStyleKey = currentStyleKey();
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
    if (usesDeckOverlay()) ensureDeckOverlay(map);
    else hideDeckOverlay(map);
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
      if (isVectorEngine()) return;
      if (!info.object || info.x == null || info.y == null) {
        hideTip();
        return;
      }
      showTip(info.object, info.x, info.y);
    },
  });

  map.on("mousemove", (e) => {
    if (!isVectorEngine()) return;
    const layers = [...VECTOR_LAYER_IDS].filter((id) => map.getLayer(id));
    if (!layers.length) {
      hideTip();
      return;
    }
    let feat: maplibregl.MapGeoJSONFeature | undefined;
    try {
      feat = map.queryRenderedFeatures(e.point, { layers })[0];
    } catch {
      hideTip();
      return;
    }
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
    if (!isVectorEngine()) return;
    hideTip();
  });

  map.on("load", () => {
    mapReady = true;
    if (usesDeckOverlay()) ensureDeckOverlay(map);
    else hideDeckOverlay(map);
    void refresh(map);
  });

  let moveTimer: ReturnType<typeof setTimeout> | undefined;
  const onViewChange = () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => void refresh(map), 180);
  };
  map.on("moveend", onViewChange);

  return map;
}
