/** Icon paths, shared by the generator (`icons.ts`) and the test; paths relative to `src-tauri`. */
import { join } from "node:path";
import { z } from "zod";
import { parseFile, TAURI_DIR } from "./lib.ts";

const TauriBundle = z.object({ bundle: z.object({ icon: z.array(z.string().min(1)).min(1) }) });

/** App icons from `bundle.icon` in tauri.conf.json. */
export function bundleIcons(): string[] {
  return parseFile(join(TAURI_DIR, "tauri.conf.json"), TauriBundle, JSON.parse).bundle.icon;
}

/**
 * Icons for Windows (executable, taskbar, notification area) and the window on Linux. They are made from the tile
 * without the macOS grid margin, because Windows icons fill almost the whole area and with the margin ours would be a fifth smaller.
 */
export const FULL_BLEED_ICONS: ReadonlySet<string> = new Set(["icons/icon.ico", "icons/32x32.png"]);

/** Tray icon template on macOS (loaded by `include_image!` in `main.rs`). */
export const TRAY_TEMPLATE_ICON = "icons/tray-template.png";
