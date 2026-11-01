import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TAB_CSP, WINDOW_CSP } from "../src/api/ui-csp.ts";

const TAURI_CONF = join(import.meta.dir, "..", "..", "..", "apps", "desktop", "src-tauri", "tauri.conf.json");
const TauriConf = z.object({ app: z.object({ security: z.object({ csp: z.string() }) }) });

describe("the UI's Content-Security-Policy", () => {
  test("the daemon's copy of the Tauri window's policy is the one in tauri.conf.json", () => {
    expect(WINDOW_CSP).toBe(TauriConf.parse(JSON.parse(readFileSync(TAURI_CONF, "utf8"))).app.security.csp);
  });

  test("a browser tab gets the window's policy without Tauri's IPC, and refuses frames, forms and a base address", () => {
    expect(TAB_CSP).toBe(
      "default-src 'self'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; img-src 'self' data:; " +
        "style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });
});
