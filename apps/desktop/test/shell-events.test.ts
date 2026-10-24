import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../scripts/lib.ts";

// The shell (Rust) and the UI (TypeScript) share no code, so these tests guard the names and shapes between them.
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const mainWindow = read("apps/desktop/src-tauri/src/main_window.rs");
const uiFocus = read("packages/ui/src/lib/use-session-focus.ts");

test("the shell sends the jump to a session under the same event name the UI listens to", () => {
  const shell = /const FOCUS_EVENT: &str = "([^"]+)";/.exec(mainWindow)?.[1];
  const ui = /const FOCUS_EVENT = "([^"]+)";/.exec(uiFocus)?.[1];
  expect(shell).toBe("focus-session");
  expect(ui).toBe(shell);
});

test("the kinds of jump targets (`kind`) are the same in the shell and in the UI", () => {
  // `Focus` in Rust has `rename_all = "kebab-case"`, so the `NextWaiting` variant is `"next-waiting"`.
  const variants = /pub enum Focus \{([^}]*)\}/.exec(mainWindow)?.[1] ?? "";
  const shell = [...variants.matchAll(/^\s*(\w+)/gm)].map((m) => m[1]?.replace(/(?<=[a-z])(?=[A-Z])/g, "-").toLowerCase());
  const ui = [...uiFocus.matchAll(/kind: z\.literal\("([\w-]+)"\)/g)].map((m) => m[1]);
  expect(shell).toEqual(["session", "proposal", "next-waiting"]);
  expect(ui).toEqual(shell);
});

test("the shell knows every session state of protocol by the same name", () => {
  const attention = read("apps/desktop/src-tauri/src/attention.rs");
  const variants = /pub enum TaskState \{([^}]*)\}/.exec(attention)?.[1] ?? "";
  const shell = [...variants.matchAll(/^\s*(\w+),/gm)].map((m) => m[1]);
  const protocol = /export const TaskState = z\.enum\(\[([^\]]*)\]\)/.exec(read("packages/protocol/src/task-state.ts"))?.[1] ?? "";
  const states = [...protocol.matchAll(/"(\w+)"/g)].map((m) => m[1]);
  expect(states.length).toBeGreaterThan(0);
  expect(shell).toEqual([...states, "Unknown"]);
});

test("a notification says what a session waits for with the words of the UI's state labels", () => {
  const notification = read("apps/desktop/src-tauri/src/notification.rs");
  const labels = read("packages/ui/src/lib/session-state.ts");
  for (const state of ["Approval", "Plan", "Input"]) {
    const label = new RegExp(`${state}: "([^"]+)"`).exec(labels)?.[1];
    expect(label).toBeDefined();
    expect(notification).toContain(`"Copilot CLI is ${label}"`);
  }
});

test("the tray panel window opens the page the UI renders the panel for and calls the shell's command", () => {
  const panelShell = read("apps/desktop/src-tauri/src/tray_panel.rs");
  const panelUi = read("packages/ui/src/lib/tray-panel.ts");
  const label = /pub const LABEL: &str = "([^"]+)";/.exec(panelShell)?.[1];
  const hash = /const TRAY_PANEL_HASH = "([^"]+)";/.exec(panelUi)?.[1];
  expect(label).toBe("tray-panel");
  expect(hash).toBe("#tray-panel");
  const config: unknown = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json"));
  expect(config).toMatchObject({
    app: { windows: expect.arrayContaining([expect.objectContaining({ label, url: `index.html${hash}` })]) },
  });
  const capability: unknown = JSON.parse(read("apps/desktop/src-tauri/capabilities/default.json"));
  expect(capability).toMatchObject({ windows: expect.arrayContaining(["main", label]) });
  expect(/invoke\("(\w+)"/.exec(panelUi)?.[1]).toBe("open_from_tray_panel");
  expect(read("apps/desktop/src-tauri/src/main.rs")).toContain("fn open_from_tray_panel(");
});
