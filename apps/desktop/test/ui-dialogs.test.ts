import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../scripts/lib.ts";

// The dialog plugin replaces `alert` and `confirm` in the Tauri window with a command the page may not call (ADR-51).
// Biome bans the bare globals; this test also catches `window.alert(...)` and `globalThis.confirm(...)`.
test("the UI calls neither alert nor confirm, as a global or through window", () => {
  const dir = join(REPO, "packages/ui/src");
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => /\.(ts|tsx)$/.test(f));
  const calls = files.filter((f) => /(?<![\w.])(?:window\.|globalThis\.)?(?:alert|confirm)\s*\(/.test(readFileSync(join(dir, f), "utf8")));
  expect(files.length).toBeGreaterThan(0);
  expect(calls).toEqual([]);
});
