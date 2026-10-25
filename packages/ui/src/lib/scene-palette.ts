import type { ScenePalette } from "@trackwall/scene/model";

/**
 * Colours of the dashboard scene from the `index.css` tokens (ADR-16, ADR-33). The tokens are in `oklch`, which three.js
 * does not read, so the browser paints each on one canvas pixel over `--background` and gives the result in sRGB. The
 * translucent tokens (`--card`, `--secondary`) thereby come out as they look over the app's background.
 */
export function readScenePalette(host: HTMLElement): ScenePalette {
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("No 2D canvas to read the theme colors");
  // One sample element: `getComputedStyle` expands `var()` (for example `--fill-alpha` in `--secondary`) into a colour
  // the canvas accepts directly.
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
