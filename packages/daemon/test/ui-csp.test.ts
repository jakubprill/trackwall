import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TAB_CSP, WINDOW_CSP } from "../src/api/ui-csp.ts";

const TAURI_CONF = join(import.meta.dir, "..", "..", "..", "apps", "desktop", "src-tauri", "tauri.conf.json");
const TauriConf = z.object({ app: z.object({ security: z.object({ csp: z.string() }) }) });

describe("the UI's Content-Security-Policy", () => {
  test("a browser tab gets the Tauri window's policy, so content from a repo is held to the same rules in both", () => {
    const windowCsp = TauriConf.parse(JSON.parse(readFileSync(TAURI_CONF, "utf8"))).app.security.csp;
    expect(WINDOW_CSP).toBe(windowCsp);
    expect(TAB_CSP.startsWith(`${windowCsp};`)).toBe(true);
  });

  test("a tab refuses images from outside, code from strings and being put in a frame", () => {
    expect(TAB_CSP).toContain("img-src 'self' data:;");
    expect(TAB_CSP).not.toContain("unsafe-eval");
    expect(TAB_CSP).toContain("frame-ancestors 'none'");
  });
});
