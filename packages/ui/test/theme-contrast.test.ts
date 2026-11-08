import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Both themes of `index.css` (ADR-16, ADR-235) read: every pair of a text or mark and the surface it sits on passes WCAG AA,
 * 4.5:1 for text and 3:1 for the group stripes. The colours are computed from the tokens' `oklch` values, so a token
 * changed by hand is checked without a browser.
 */
const CSS = readFileSync(join(import.meta.dir, "..", "src", "index.css"), "utf8");

const DARK_SELECTOR = ':root,\n[data-theme="dark"]';
const LIGHT_SELECTOR = '[data-theme="light"]';

/** The custom properties of the first block with exactly this selector. */
function tokens(selector: string): Map<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`index.css has no "${selector}" block`);
  const body = CSS.slice(start, CSS.indexOf("\n}", start));
  return new Map([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? "", (m[2] ?? "").trim()]));
}

type Rgb = readonly [number, number, number];

/** An opaque `oklch(L C H ...)` as linear sRGB, clipped to the gamut the way a browser paints it. */
function linearRgb(value: string): Rgb {
  const match = value.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)/);
  if (!match) throw new Error(`not an oklch colour: ${value}`);
  const [lightness, chroma, hue] = [Number(match[1]), Number(match[2]), (Number(match[3]) * Math.PI) / 180];
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (v: number) => Math.min(1, Math.max(0, v));
  return [
    clip(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clip(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clip(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** `share` of `fore` over `back`, mixed in encoded sRGB as a browser blends a translucent fill. */
function over(fore: Rgb, back: Rgb, share: number): Rgb {
  const mix = (f: number, b: number) => decode(encode(f) * share + encode(b) * (1 - share));
  return [mix(fore[0], back[0]), mix(fore[1], back[1]), mix(fore[2], back[2])];
}

function contrast(fore: Rgb, back: Rgb): number {
  const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const [high, low] = [luminance(fore), luminance(back)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

/** [text or mark, surface, the contrast it needs, the share of the mark that tints the surface (a `bg-warning/10` notice)] */
const PAIRS: ReadonlyArray<readonly [string, string, number, number?]> = [
  ["foreground", "background", 4.5],
  ["foreground", "card", 4.5],
  ["foreground", "secondary", 4.5],
  ["foreground", "accent", 4.5],
  ["muted-foreground", "background", 4.5],
  ["muted-foreground", "card", 4.5],
  ["muted-foreground", "secondary", 4.5],
  ["primary", "background", 4.5],
  ["primary", "card", 4.5],
  ["primary-foreground", "primary", 4.5],
  ["success", "card", 4.5],
  ["warning", "card", 4.5],
  ["destructive", "card", 4.5],
  ["warning", "card", 4.5, 0.1],
  ["destructive", "card", 4.5, 0.1],
  ["primary", "card", 4.5, 0.1],
  ["group-1", "card", 3],
  ["group-2", "card", 3],
  ["group-3", "card", 3],
  ["group-4", "card", 3],
  ["chart-1", "card", 3],
  ["chart-2", "card", 3],
];

/** Tokens that are not colours of the theme: the terminal palette stays dark (a dark island, ADR-235) and the radius is shared. */
const NOT_THEMED = (token: string) => token.startsWith("ansi-") || token === "radius";

describe("themes", () => {
  test("the light theme gives every colour token of the dark theme a value of its own", () => {
    const light = tokens(LIGHT_SELECTOR);
    const missing = [...tokens(DARK_SELECTOR).keys()].filter((token) => !NOT_THEMED(token) && !light.has(token));

    expect(missing).toEqual([]);
  });

  for (const [name, selector] of [
    ["dark", DARK_SELECTOR],
    ["light", LIGHT_SELECTOR],
  ] as const) {
    test(`every text and mark of the ${name} theme reads on its surface (WCAG AA)`, () => {
      const theme = tokens(selector);
      // A token that names another (`--chart-1: var(--primary)`) takes that one's value.
      const value = (token: string): string => {
        const declared = theme.get(token) ?? `missing --${token}`;
        const other = declared.match(/^var\(--([a-z0-9-]+)\)$/)?.[1];
        return other ? value(other) : declared;
      };
      const colour = (token: string) => linearRgb(value(token));
      const failing = PAIRS.flatMap(([mark, surface, needed, tint]) => {
        const back = tint ? over(colour(mark), colour(surface), tint) : colour(surface);
        const ratio = contrast(colour(mark), back);
        return ratio >= needed
          ? []
          : [`${mark} on ${tint ? `${mark}/${tint * 100} over ` : ""}${surface}: ${ratio.toFixed(2)} < ${needed}`];
      });

      expect(failing).toEqual([]);
    });
  }
});
