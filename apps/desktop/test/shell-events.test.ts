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

const updatesShell = read("apps/desktop/src-tauri/src/updates.rs");
const updatesUi = read("packages/ui/src/lib/updates.ts");

test("the shell sends the update download progress under the same event name and fields the UI reads", () => {
  const shell = /const PROGRESS_EVENT: &str = "([^"]+)";/.exec(updatesShell)?.[1];
  const ui = /const PROGRESS_EVENT = "([^"]+)";/.exec(updatesUi)?.[1];
  expect(shell).toBe("update-progress");
  expect(ui).toBe(shell);
  const shellFields = [...(/struct Progress \{([^}]*)\}/.exec(updatesShell)?.[1] ?? "").matchAll(/(\w+):/g)].map((m) => m[1]);
  const uiFields = [...(/const UpdateProgress = z\.object\(\{([^}]*)\}/.exec(updatesUi)?.[1] ?? "").matchAll(/(\w+):/g)].map((m) => m[1]);
  expect(shellFields).toEqual(["downloaded", "total"]);
  expect(uiFields).toEqual(shellFields);
});

test("the UI calls the update commands the shell has, with the argument and result fields it uses", () => {
  expect(updatesShell).toContain("pub async fn check_update(");
  expect(updatesShell).toContain("pub async fn install_update(app: AppHandle, updates: State<'_, Updates>, version: String)");
  expect(updatesUi).toContain('invoke<unknown>("check_update")');
  expect(updatesUi).toContain('invoke("install_update", { version })');
  // `UpdateCheck` in Rust has `rename_all = "camelCase"`.
  const shellFields = [...(/pub struct UpdateCheck \{([^}]*)\}/.exec(updatesShell)?.[1] ?? "").matchAll(/^\s+(\w+):/gm)].map((m) =>
    m[1]?.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()),
  );
  const uiFields = [...(/export const UpdateCheck = z\.object\(\{([^}]*)\}/.exec(updatesUi)?.[1] ?? "").matchAll(/(\w+):/g)].map(
    (m) => m[1],
  );
  expect(shellFields).toEqual(["currentVersion", "available"]);
  expect(uiFields).toEqual(shellFields);
});
