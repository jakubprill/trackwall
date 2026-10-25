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

test("the link scheme is the same in the shell, its configuration and protocol", () => {
  const DeepLinkConfig = z.object({
    plugins: z.object({ "deep-link": z.object({ desktop: z.object({ schemes: z.array(z.string()) }) }) }),
  });
  const config = parseFile(join(REPO, "apps/desktop/src-tauri/tauri.conf.json"), DeepLinkConfig, JSON.parse).plugins["deep-link"].desktop
    .schemes;
  expect(/const SCHEME: &str = "([^"]+)";/.exec(linkSource)?.[1]).toBe(TRACKWALL_LINK_SCHEME);
  expect(config).toEqual([TRACKWALL_LINK_SCHEME]);
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
