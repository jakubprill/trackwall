import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../scripts/lib.ts";

// The shell (Rust) and the UI (TypeScript) share no code, so this test guards the event's name and shape between them.
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const shellSource = read("apps/desktop/src-tauri/src/attention.rs");
const uiSource = read("packages/ui/src/lib/use-session-focus.ts");

test("the shell sends the jump to a session under the same event name the UI listens to", () => {
  const shell = /const FOCUS_EVENT: &str = "([^"]+)";/.exec(shellSource)?.[1];
  const ui = /const FOCUS_EVENT = "([^"]+)";/.exec(uiSource)?.[1];
  expect(shell).toBe("focus-session");
  expect(ui).toBe(shell);
});

test("the kinds of tray jump targets (`kind`) are the same in the shell and in the UI", () => {
  // `Focus` in Rust has `rename_all = "lowercase"`, so the `Proposal` variant is `"proposal"`.
  const shell = [...(/pub enum Focus<'a> \{([^}]*)\}/.exec(shellSource)?.[1] ?? "").matchAll(/(\w+)\(/g)].map((m) => m[1]?.toLowerCase());
  const ui = [...uiSource.matchAll(/kind: z\.literal\("(\w+)"\)/g)].map((m) => m[1]);
  expect(shell).toEqual(["session", "proposal"]);
  expect(ui).toEqual(shell);
});
