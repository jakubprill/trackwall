import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../scripts/lib.ts";

// Powłoka (Rust) i UI (TypeScript) nie mają wspólnego kodu, więc nazwę zdarzenia między nimi pilnuje ten test.
const read = (path: string) => readFileSync(join(REPO, path), "utf8");

test("powłoka wysyła skok do sesji pod tą samą nazwą zdarzenia, której słucha UI", () => {
  const shell = /const FOCUS_SESSION_EVENT: &str = "([^"]+)";/.exec(read("apps/desktop/src-tauri/src/attention.rs"))?.[1];
  const ui = /const FOCUS_SESSION_EVENT = "([^"]+)";/.exec(read("packages/ui/src/lib/use-session-focus.ts"))?.[1];
  expect(shell).toBe("focus-session");
  expect(ui).toBe(shell);
});
