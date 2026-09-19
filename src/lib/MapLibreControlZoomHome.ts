/**
 * Adapted from MapLibre-Control-ZoomHome
 * @see https://github.com/GreenInfo-Network/MapLibre-Control-ZoomHome
 * @see https://greeninfo-network.github.io/MapLibre-Control-ZoomHome/
 */
import type { IControl, Map as MaplibreMap, LngLatLike, LngLatBoundsLike } from "maplibre-gl";

export type MapLibreControlZoomHomeOptions = {
  resetBounds?: LngLatBoundsLike | null;
  resetLngLat?: LngLatLike | null;
  resetZoom?: number;
  tooltipText?: string;
};

const HOME_SVG = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 L12 4 l9 7.5"/><path d="M6 10.5 V20 h4 v-5 h4 v5 h4 V10.5"/></svg>`,
)}`;

export class MapLibreControlZoomHome implements IControl {
  private _map?: MaplibreMap;
  private _container?: HTMLDivElement;
  private options: Required<MapLibreControlZoomHomeOptions>;

  constructor(options: MapLibreControlZoomHomeOptions = {}) {
    this.options = {
      resetBounds: options.resetBounds ?? null,
      resetLngLat: options.resetLngLat ?? null,
      resetZoom: options.resetZoom ?? 1,
      tooltipText: options.tooltipText ?? "Reset map view",
    };
    if (!this.options.resetBounds && !this.options.resetLngLat) {
      throw new Error(
        "MapLibreControlZoomHome requires resetBounds or resetLngLat",
      );
    }
  }

  onAdd(map: MaplibreMap): HTMLElement {
    this._map = map;

    const div = document.createElement("div");
    div.className =
      "maplibregl-ctrl maplibregl-ctrl-group maplibre-control-zoomhome";

    const button = document.createElement("button");
    button.type = "button";
    button.title = this.options.tooltipText;
    button.setAttribute("aria-label", this.options.tooltipText);

    const icon = document.createElement("img");
    icon.src = HOME_SVG;
    icon.alt = this.options.tooltipText;
    button.appendChild(icon);

    button.addEventListener("click", (e) => {
      e.preventDefault();
      this.resetMapView();
    });

    div.appendChild(button);
    this._container = div;
    return div;
  }

  onRemove(): void {
    this._container?.remove();
    this._map = undefined;
  }

  resetMapView(): void {
    if (!this._map) return;
    if (this.options.resetBounds) {
      this._map.fitBounds(this.options.resetBounds, { duration: 800 });
    } else if (this.options.resetLngLat) {
      this._map.easeTo({
        center: this.options.resetLngLat,
        zoom: this.options.resetZoom,
        duration: 800,
      });
    }
  }
}
