/**
 * Generates icons from the SVGs in `assets/` (`pnpm --filter @trackwall/desktop icons`): the app icons from `bundle.icon`
 * in tauri.conf.json, the tray template for macOS and the UI favicon. `tauri icon` also makes icons for Android, iOS and
 * the Microsoft Store; we do not use those, so we generate into a temporary directory and copy only the files we need.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { bundleIcons, FULL_BLEED_ICONS, TRAY_TEMPLATE_ICON } from "./icon-paths.ts";
import { DESKTOP, REPO, run, TAURI_DIR } from "./lib.ts";

const ASSETS = join(DESKTOP, "assets");
const FAVICON = join(REPO, "packages", "ui", "public", "favicon.png");
const FAVICON_SIZE = 64;
const TRAY_SIZE = 64;
// The tile in icon.svg takes 50..462 of 512 (the macOS grid); the crop leaves a 6 px transparent margin,
// so that the tile's anti-aliased edge does not touch the edge of the icon.
const MACOS_VIEWBOX = 'viewBox="0 0 512 512"';
const FULL_BLEED_VIEWBOX = 'viewBox="44 44 424 424"';

function tauriIcon(svg: string, out: string, ...args: string[]): void {
  run(["pnpm", "exec", "tauri", "icon", svg, "-o", out, ...args], DESKTOP);
}

/** The same icon cropped to the tile, in a file next to it, because `tauri icon` reads the SVG from disk. */
function fullBleedSvg(dir: string): string {
  const svg = readFileSync(join(ASSETS, "icon.svg"), "utf8");
  if (!svg.includes(MACOS_VIEWBOX)) throw new Error(`assets/icon.svg: ${MACOS_VIEWBOX} is missing, fix the crop in icons.ts`);
  const path = join(dir, "icon-full-bleed.svg");
  writeFileSync(path, svg.replace(MACOS_VIEWBOX, FULL_BLEED_VIEWBOX));
  return path;
}

const out = mkdtempSync(join(tmpdir(), "trackwall-icons-"));
try {
  const macos = join(out, "macos");
  const fullBleed = join(out, "full-bleed");
  tauriIcon(join(ASSETS, "icon.svg"), macos);
  tauriIcon(fullBleedSvg(out), fullBleed);
  for (const icon of bundleIcons()) {
    const from = FULL_BLEED_ICONS.has(icon) ? fullBleed : macos;
    copyFileSync(join(from, basename(icon)), join(TAURI_DIR, icon));
  }
  copyFileSync(join(fullBleed, `${FAVICON_SIZE}x${FAVICON_SIZE}.png`), FAVICON);

  const tray = join(out, "tray");
  tauriIcon(join(ASSETS, "tray-icon.svg"), tray, "-p", String(TRAY_SIZE));
  copyFileSync(join(tray, `${TRAY_SIZE}x${TRAY_SIZE}.png`), join(TAURI_DIR, TRAY_TEMPLATE_ICON));
} finally {
  rmSync(out, { recursive: true, force: true });
}
console.log("ikony: src-tauri/icons, packages/ui/public/favicon.png");
