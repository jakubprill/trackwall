/**
 * Generuje ikony z SVG w `assets/` (`pnpm --filter @trackwall/desktop icons`): ikony aplikacji z `bundle.icon`
 * w tauri.conf.json, szablon traya dla macOS i favicon UI. `tauri icon` tworzy też ikony Androida, iOS i Sklepu
 * Windows; tych nie używamy, więc generujemy do katalogu tymczasowego i kopiujemy tylko potrzebne pliki.
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
// Kafel w icon.svg zajmuje 50..462 z 512 (siatka macOS); kadr zostawia 6 px na poświatę krawędzi.
const MACOS_VIEWBOX = 'viewBox="0 0 512 512"';
const FULL_BLEED_VIEWBOX = 'viewBox="44 44 424 424"';

function tauriIcon(svg: string, out: string, ...args: string[]): void {
  run(["pnpm", "exec", "tauri", "icon", svg, "-o", out, ...args], DESKTOP);
}

/** Ta sama ikona przycięta do kafla, w pliku obok, bo `tauri icon` czyta SVG z dysku. */
function fullBleedSvg(dir: string): string {
  const svg = readFileSync(join(ASSETS, "icon.svg"), "utf8");
  if (!svg.includes(MACOS_VIEWBOX)) throw new Error(`assets/icon.svg: brak ${MACOS_VIEWBOX}, popraw kadr w icons.ts`);
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
