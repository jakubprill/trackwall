import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TaskState, TRACKWALL_LINK_KINDS, TRACKWALL_LINK_SCHEME } from "@trackwall/protocol";
import { z } from "zod";
import { parseFile, REPO } from "../scripts/lib.ts";

// The shell (Rust) and the UI (TypeScript) share no code, so this test guards the names and the shape between them.
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const shellSource = read("apps/desktop/src-tauri/src/jump.rs");
const linkSource = read("apps/desktop/src-tauri/src/link.rs");
const uiSource = read("packages/ui/src/lib/use-jump-request.ts");
const terminalLinksSource = read("packages/ui/src/lib/terminal-links.ts");

test("the shell signals a jump under the same event name the UI listens to", () => {
  const shell = /const JUMP_EVENT: &str = "([^"]+)";/.exec(shellSource)?.[1];
  const ui = /const JUMP_EVENT = "([^"]+)";/.exec(uiSource)?.[1];
  expect(shell).toBe("jump-requested");
  expect(ui).toBe(shell);
});

test("the UI takes the jump with the command the shell defines", () => {
  const shell = /#\[tauri::command\]\s*pub fn (\w+)/.exec(shellSource)?.[1];
  const ui = /const TAKE_JUMP_COMMAND = "([^"]+)";/.exec(uiSource)?.[1];
  expect(shell).toBe("take_jump");
  expect(ui).toBe(shell);
});

test("a link clicked in a session terminal goes to the command the shell defines", () => {
  const shell = /#\[tauri::command\]\s*pub fn (\w+)/.exec(linkSource)?.[1];
  const ui = /const OPEN_LINK_COMMAND = "([^"]+)";/.exec(terminalLinksSource)?.[1];
  expect(shell).toBe("open_link");
  expect(ui).toBe(shell);
});

test("the shell knows the same link kinds as protocol", () => {
  const parse = /pub fn parse\(([\s\S]*?)\n\}/.exec(linkSource)?.[1] ?? "";
  const kinds = [...parse.matchAll(/"(\w+)" => /g)].map((m) => m[1]);
  expect(kinds).toEqual([...TRACKWALL_LINK_KINDS]);
});

test("the kinds of jump targets (`kind`) are the same in the shell and in the UI", () => {
  // `Jump` in Rust has `rename_all = "lowercase"`, so the `Proposal` variant is `"proposal"`; `NextWaiting` is renamed.
  const variants = /pub enum Jump \{([^}]*)\}/.exec(shellSource)?.[1] ?? "";
  const shell = [...variants.matchAll(/(?:rename = "([\w-]+)"\)\]\s*(\w+)|^\s*(\w+)\()/gm)].map((m) => m[1] ?? m[3]?.toLowerCase());
  const ui = [...uiSource.matchAll(/kind: z\.literal\("([\w-]+)"\)/g)].map((m) => m[1]);
  expect(shell).toEqual(["repo", "session", "task", "proposal", "next-waiting"]);
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

test("the link scheme is the same in the shell, its configuration and protocol", () => {
  const DeepLinkConfig = z.object({
    plugins: z.object({ "deep-link": z.object({ desktop: z.object({ schemes: z.array(z.string()) }) }) }),
  });
  const config = parseFile(join(REPO, "apps/desktop/src-tauri/tauri.conf.json"), DeepLinkConfig, JSON.parse).plugins["deep-link"].desktop
    .schemes;
  expect(/const SCHEME: &str = "([^"]+)";/.exec(linkSource)?.[1]).toBe(TRACKWALL_LINK_SCHEME);
  expect(config).toEqual([TRACKWALL_LINK_SCHEME]);
});

test("the UI knows the main window, which checks for updates, by the shell's label for it", () => {
  const shell = /pub const MAIN: &str = "([^"]+)";/.exec(read("apps/desktop/src-tauri/src/windows.rs"))?.[1];
  const ui = /const MAIN_WINDOW = "([^"]+)";/.exec(read("packages/ui/src/lib/app-window.ts"))?.[1];
  expect(shell).toBe("main");
  expect(ui).toBe(shell);
});

const appMenuSource = read("apps/desktop/src-tauri/src/app_menu.rs");
const appMenuUiSource = read("packages/ui/src/lib/use-app-menu.ts");
const appSource = read("packages/ui/src/App.tsx");

test("the shell sends menu bar clicks under the same event name the UI listens to", () => {
  const shell = /const APP_MENU_EVENT: &str = "([^"]+)";/.exec(appMenuSource)?.[1];
  const ui = /const APP_MENU_EVENT = "([^"]+)";/.exec(appMenuUiSource)?.[1];
  expect(shell).toBe("app-menu");
  expect(ui).toBe(shell);
});

test("the kinds of menu commands are the same in the shell and in the UI", () => {
  // From the JSON the shell's own test expects for each `MenuCommand`, so serde's naming is not copied here.
  const shell = [...appMenuSource.matchAll(/r#"\{"kind":"([\w-]+)"/g)].map((m) => m[1]);
  const ui = [...appMenuUiSource.matchAll(/kind: z\.literal\("([\w-]+)"\)/g)].map((m) => m[1]);
  expect(shell).toEqual(["view", "new-window"]);
  expect(ui).toEqual(shell);
});

test("the View menu has the activity bar's views with their names and shortcuts, and Settings in the app menu", () => {
  const entry = /\{ id: "(\w+)", label: "([^"]+)", (?:icon: \w+, )?shortcut: "([^"]+)"/g;
  const ui = [...appSource.matchAll(entry)].map((m) => [m[1], m[2], m[3]]);
  const shell = [...appMenuSource.matchAll(/MenuView \{ id: "(\w+)", label: "([^"]+)", shortcut: "([^"]+)" \}/g)].map((m) => [
    m[1],
    m[2],
    m[3],
  ]);
  expect(ui.map((v) => v[0])).toEqual(["home", "repos", "sessions", "graph", "daemon", "settings"]);
  expect(shell).toEqual(ui);
});

test("the shell knows every session state of protocol by the same name", () => {
  const attention = read("apps/desktop/src-tauri/src/attention.rs");
  const variants = /pub enum TaskState \{([^}]*)\}/.exec(attention)?.[1] ?? "";
  const shell = [...variants.matchAll(/^\s*(\w+),/gm)].map((m) => m[1]);
  expect(shell).toEqual([...TaskState.options, "Unknown"]);
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

const zoomShell = read("apps/desktop/src-tauri/src/zoom.rs");
const zoomUi = read("packages/ui/src/lib/zoom-shortcut.ts");

test("the UI zooms through the command the shell registers, with the steps the shell knows (ADR-65)", () => {
  const command = /#\[tauri::command\]\s*pub async fn (\w+)\(window: WebviewWindow, (\w+): ZoomStep\)/.exec(zoomShell);
  expect(command?.[1]).toBe("zoom_window");
  expect(read("apps/desktop/src-tauri/src/main.rs")).toContain(`zoom::${command?.[1]}`);
  expect(/const ZOOM_COMMAND = "(\w+)";/.exec(zoomUi)?.[1]).toBe(command?.[1]);
  expect(zoomUi).toContain(`invoke(ZOOM_COMMAND, { ${command?.[2]} })`);
  // `ZoomStep` in Rust has `rename_all = "kebab-case"`.
  const shellSteps = [...(/pub enum ZoomStep \{([^}]*)\}/.exec(zoomShell)?.[1] ?? "").matchAll(/(\w+),/g)].map((m) => m[1]?.toLowerCase());
  const uiSteps = [...(/export type ZoomStep = ([^;]*);/.exec(zoomUi)?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]);
  expect(shellSteps).toEqual(["in", "out", "reset"]);
  expect(uiSteps).toEqual(shellSteps);
});

test("the shell tells the page its zoom in the attribute the UI reads (ADR-65)", () => {
  const shell = /const ZOOM_ATTRIBUTE: &str = "([^"]+)";/.exec(zoomShell)?.[1];
  const ui = /const ZOOM_ATTRIBUTE = "([^"]+)";/.exec(read("packages/ui/src/lib/file-drop.ts"))?.[1];
  expect(shell).toBe("data-zoom");
  expect(ui).toBe(shell);
});

test("the UI reads and switches the start at sign-in through the commands the shell registers (ADR-65)", () => {
  const shell = read("apps/desktop/src-tauri/src/autostart.rs");
  const ui = read("packages/ui/src/lib/autostart.ts");
  const main = read("apps/desktop/src-tauri/src/main.rs");
  expect(shell).toContain("pub async fn autostart_enabled(app: AppHandle) -> Result<bool, String>");
  expect(shell).toContain("pub async fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String>");
  expect(main).toContain("autostart::autostart_enabled");
  expect(main).toContain("autostart::set_autostart");
  expect(/const ENABLED_COMMAND = "(\w+)";/.exec(ui)?.[1]).toBe("autostart_enabled");
  expect(/const SET_COMMAND = "(\w+)";/.exec(ui)?.[1]).toBe("set_autostart");
  expect(ui).toContain("invoke<unknown>(SET_COMMAND, { enabled })");
});
