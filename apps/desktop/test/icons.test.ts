import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bundleIcons, TRAY_TEMPLATE_ICON } from "../scripts/icon-paths.ts";
import { TAURI_DIR } from "../scripts/lib.ts";

// `scripts/icons.ts` generates the icons from `assets/*.svg`; here we make sure Tauri gets every file it asks for.
test("every icon from bundle.icon in tauri.conf.json is in src-tauri", () => {
  const missing = bundleIcons().filter((icon) => !existsSync(join(TAURI_DIR, icon)));
  expect(missing).toEqual([]);
});

test("the tray template that main.rs loads is in src-tauri", () => {
  expect(existsSync(join(TAURI_DIR, TRAY_TEMPLATE_ICON))).toBe(true);
  expect(readFileSync(join(TAURI_DIR, "src", "main.rs"), "utf8")).toContain(`include_image!("${TRAY_TEMPLATE_ICON}")`);
});
