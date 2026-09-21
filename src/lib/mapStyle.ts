import type { StyleSpecification } from "maplibre-gl";

export type PaletteId = "spectral" | "magma" | "viridis" | "terrain" | "heat";

export const PALETTE_HEX: Record<PaletteId, string[]> = {
  spectral: [
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
  ],
  magma: [
    "#000004",
    "#180f3d",
    "#440f76",
    "#721f81",
    "#9e2f7f",
    "#cd4071",
    "#f1605d",
    "#fd9668",
    "#feca8d",
    "#fcfdbf",
  ],
  viridis: [
    "#440154",
    "#482878",
    "#3e4989",
    "#31688e",
    "#26828e",
    "#1f9e89",
    "#35b779",
    "#6ece58",
    "#b5de2b",
    "#fde725",
  ],
  terrain: [
    "#333399",
    "#0077be",
    "#2ca25f",
    "#99d594",
    "#e6f598",
    "#fee08b",
    "#fdae61",
    "#d08b48",
    "#a6611a",
    "#f7f7f7",
  ],
  heat: [
    "#000004",
    "#1b0c41",
    "#4a0c6b",
    "#781c6d",
    "#a52c60",
    "#cf4446",
    "#ed6925",
    "#fb9b06",
    "#f7d13d",
    "#fcffa4",
  ],
};

export const VECTOR_LAYER_IDS = [
  "pop-h3-4",
  "pop-h3-5",
  "pop-h3-6",
  "pop-h3-7",
] as const;

const VSTYLES =
  "https://cdn.jsdelivr.net/gh/opengeoshub/vstyles@main/vstyles";
const GITHUB_VSTYLES =
  "https://raw.githubusercontent.com/opengeoshub/vstyles/main/vstyles";

export function styleKey(vector: boolean, palette: PaletteId) {
  return vector ? `vector:${palette}` : "basemap";
}

export function rewriteVstylesUrl(url: string): string {
  return url.startsWith(GITHUB_VSTYLES)
    ? `${VSTYLES}${url.slice(GITHUB_VSTYLES.length)}`
    : url;
}

function githubStyleUrl(vector: boolean, palette: PaletteId): string {
  const name = vector ? `pop_${palette}` : "fiord";
  return `${VSTYLES}/pop/${name}.json`;
}

export async function loadGithubStyle(
  vector: boolean,
  palette: PaletteId,
): Promise<StyleSpecification> {
  const res = await fetch(githubStyleUrl(vector, palette));
  if (!res.ok) {
    throw new Error(`Failed to load style ${res.status} ${res.statusText}`);
  }
  const style = (await res.json()) as StyleSpecification;
  style.projection = { type: "globe" };
  if (typeof style.sprite === "string") {
    style.sprite = rewriteVstylesUrl(style.sprite);
  }
  if (typeof style.glyphs === "string") {
    style.glyphs = rewriteVstylesUrl(style.glyphs);
  }
  return style;
}
