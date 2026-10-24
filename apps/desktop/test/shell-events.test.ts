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

test("the kinds of jump targets (`kind`) are the same in the shell and in the UI", () => {
  // `Focus` in Rust has `rename_all = "kebab-case"`, so the `NextWaiting` variant is `"next-waiting"`.
  const variants = /pub enum Focus \{([^}]*)\}/.exec(shellSource)?.[1] ?? "";
  const shell = [...variants.matchAll(/^\s*(\w+)/gm)].map((m) => m[1]?.replace(/(?<=[a-z])(?=[A-Z])/g, "-").toLowerCase());
  const ui = [...uiSource.matchAll(/kind: z\.literal\("([\w-]+)"\)/g)].map((m) => m[1]);
  expect(shell).toEqual(["session", "proposal", "next-waiting"]);
  expect(ui).toEqual(shell);
});

test("the tray panel window opens the page the UI renders the panel for and calls the shell's command", () => {
  const panelShell = read("apps/desktop/src-tauri/src/tray_panel.rs");
  const panelUi = read("packages/ui/src/lib/tray-panel.ts");
  const mainShell = read("apps/desktop/src-tauri/src/main.rs");
  expect(/const PAGE: &str = "index\.html(#[^"]+)";/.exec(panelShell)?.[1]).toBe("#tray-panel");
  expect(/const TRAY_PANEL_HASH = "([^"]+)";/.exec(panelUi)?.[1]).toBe("#tray-panel");
  expect(/invoke\("(\w+)"/.exec(panelUi)?.[1]).toBe("open_from_tray_panel");
  expect(mainShell).toContain("fn open_from_tray_panel(");
  const label = /pub const LABEL: &str = "([^"]+)";/.exec(panelShell)?.[1];
  expect(label).toBe("tray-panel");
  const capability: unknown = JSON.parse(read("apps/desktop/src-tauri/capabilities/default.json"));
  expect(capability).toMatchObject({ windows: expect.arrayContaining(["main", label]) });
});
