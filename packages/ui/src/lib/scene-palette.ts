import type { ScenePalette } from "@trackwall/scene";

/**
 * Kolory sceny pulpitu z tokenów `index.css` (ADR-16, ADR-33). Tokeny są w `oklch`, którego three.js nie czyta, więc
 * przeglądarka maluje każdy na jednym pikselu płótna na tle `--background` i podaje wynik w sRGB. Półprzezroczyste
 * tokeny (`--card`, `--secondary`) wychodzą przez to takie, jakie widać na tle aplikacji.
 */

const TOKENS = {
  primary: "--primary",
  warning: "--warning",
  destructive: "--destructive",
  muted: "--muted-foreground",
  idle: "--secondary",
  body: "--card",
  plate: "--background",
} as const satisfies Record<keyof ScenePalette, string>;

export function readScenePalette(host: HTMLElement): ScenePalette {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("No 2D canvas to read the theme colors");
  const background = resolvedColor(host, TOKENS.plate);
  const paint = (token: string): string => {
    context.fillStyle = background;
    context.fillRect(0, 0, 1, 1);
    context.fillStyle = resolvedColor(host, token);
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
    return rgbHex(r, g, b);
  };
  return {
    primary: paint(TOKENS.primary),
    warning: paint(TOKENS.warning),
    destructive: paint(TOKENS.destructive),
    muted: paint(TOKENS.muted),
    idle: paint(TOKENS.idle),
    body: paint(TOKENS.body),
    plate: paint(TOKENS.plate),
  };
}

/** Kolor tokenu po rozwinięciu `var()` (np. `--fill-alpha` w `--secondary`), który płótno przyjmie wprost. */
function resolvedColor(host: HTMLElement, token: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  host.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

export function rgbHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
