/** Ścieżki ikon, wspólne dla generatora (`icons.ts`) i testu; ścieżki względem `src-tauri`. */
import { join } from "node:path";
import { z } from "zod";
import { parseFile, TAURI_DIR } from "./lib.ts";

const TauriBundle = z.object({ bundle: z.object({ icon: z.array(z.string().min(1)).min(1) }) });

/** Ikony aplikacji z `bundle.icon` w tauri.conf.json. */
export function bundleIcons(): string[] {
  return parseFile(join(TAURI_DIR, "tauri.conf.json"), TauriBundle, JSON.parse).bundle.icon;
}

/**
 * Ikony dla Windowsa (plik wykonywalny, pasek zadań, zasobnik) i okna na Linuksie. Powstają z kafla bez marginesu
 * siatki macOS, bo ikony Windowsa wypełniają prawie całe pole i z marginesem nasza byłaby o jedną piątą mniejsza.
 */
export const FULL_BLEED_ICONS: ReadonlySet<string> = new Set(["icons/icon.ico", "icons/32x32.png"]);

/** Szablon ikony traya na macOS (wczytuje go `include_image!` w `main.rs`). */
export const TRAY_TEMPLATE_ICON = "icons/tray-template.png";
