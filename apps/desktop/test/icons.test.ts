import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bundleIcons, TAURI_DIR, TRAY_TEMPLATE_ICON } from "../scripts/lib.ts";

// Ikony generuje `scripts/icons.ts` z `assets/*.svg`; tu pilnujemy, że Tauri dostanie wszystkie pliki, o które prosi.
test("każda ikona z bundle.icon w tauri.conf.json leży w src-tauri", () => {
  const missing = bundleIcons().filter((icon) => !existsSync(join(TAURI_DIR, icon)));
  expect(missing).toEqual([]);
});

test("szablon traya, który wczytuje main.rs, leży w src-tauri", () => {
  expect(existsSync(join(TAURI_DIR, TRAY_TEMPLATE_ICON))).toBe(true);
  expect(readFileSync(join(TAURI_DIR, "src", "main.rs"), "utf8")).toContain(`include_image!("${TRAY_TEMPLATE_ICON}")`);
});
