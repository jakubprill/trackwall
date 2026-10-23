/**
 * Generuje ikony z SVG w `assets/` (`pnpm --filter @trackwall/desktop icons`): ikony aplikacji z `bundle.icon`
 * w tauri.conf.json, szablon traya dla macOS i favicon UI. `tauri icon` tworzy też ikony Androida, iOS i Sklepu
 * Windows; tych nie używamy, więc generujemy do katalogu tymczasowego i kopiujemy tylko potrzebne pliki.
 */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { bundleIcons, DESKTOP, REPO, run, TAURI_DIR, TRAY_TEMPLATE_ICON } from "./lib.ts";

const FAVICON = join(REPO, "packages", "ui", "public", "favicon.png");
const FAVICON_SIZE = 64;
const TRAY_SIZE = 64;

const out = mkdtempSync(join(tmpdir(), "trackwall-icons-"));
try {
  const app = join(out, "app");
  run(["pnpm", "exec", "tauri", "icon", join(DESKTOP, "assets", "icon.svg"), "-o", app], DESKTOP);
  for (const icon of bundleIcons()) copyFileSync(join(app, basename(icon)), join(TAURI_DIR, icon));
  copyFileSync(join(app, `${FAVICON_SIZE}x${FAVICON_SIZE}.png`), FAVICON);

  const tray = join(out, "tray");
  run(["pnpm", "exec", "tauri", "icon", join(DESKTOP, "assets", "tray-icon.svg"), "-o", tray, "-p", String(TRAY_SIZE)], DESKTOP);
  copyFileSync(join(tray, `${TRAY_SIZE}x${TRAY_SIZE}.png`), join(TAURI_DIR, TRAY_TEMPLATE_ICON));
} finally {
  rmSync(out, { recursive: true, force: true });
}
console.log("ikony: src-tauri/icons, packages/ui/public/favicon.png");
