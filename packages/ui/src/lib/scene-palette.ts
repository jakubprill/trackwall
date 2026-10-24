import type { ScenePalette } from "@trackwall/scene/model";

/**
 * Kolory sceny pulpitu z tokenów `index.css` (ADR-16, ADR-33). Tokeny są w `oklch`, którego three.js nie czyta, więc
 * przeglądarka maluje każdy na jednym pikselu płótna na tle `--background` i podaje wynik w sRGB. Półprzezroczyste
 * tokeny (`--card`, `--secondary`) wychodzą przez to takie, jakie widać na tle aplikacji.
 */
export function readScenePalette(host: HTMLElement): ScenePalette {
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("No 2D canvas to read the theme colors");
  // Jeden element próbny: `getComputedStyle` rozwija `var()` (np. `--fill-alpha` w `--secondary`) do koloru,
  // który płótno przyjmie wprost.
  const probe = document.createElement("span");
  host.append(probe);
  const resolved = (token: string) => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  const background = resolved("--background");
  const paint = (token: string): string => {
    context.fillStyle = background;
    context.fillRect(0, 0, 1, 1);
    context.fillStyle = resolved(token);
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
    return rgbHex(r, g, b);
  };
  try {
    return {
      primary: paint("--primary"),
      warning: paint("--warning"),
      destructive: paint("--destructive"),
      muted: paint("--muted-foreground"),
      idle: paint("--secondary"),
      body: paint("--card"),
      plate: paint("--background"),
    };
  } finally {
    probe.remove();
  }
}

export function rgbHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
