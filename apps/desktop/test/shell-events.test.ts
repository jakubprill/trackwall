import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TRACKWALL_LINK_KINDS, TRACKWALL_LINK_SCHEME } from "@trackwall/protocol";
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
  // `Jump` in Rust has `rename_all = "lowercase"`, so the `Proposal` variant is `"proposal"`.
  const shell = [...(/pub enum Jump \{([^}]*)\}/.exec(shellSource)?.[1] ?? "").matchAll(/(\w+)\(/g)].map((m) => m[1]?.toLowerCase());
  const ui = [...uiSource.matchAll(/kind: z\.literal\("(\w+)"\)/g)].map((m) => m[1]);
  expect(shell).toEqual(["repo", "session", "task", "proposal"]);
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
  // `MenuCommand` in Rust has `rename_all = "kebab-case"`, so `NewWindow` is `"new-window"`.
  const variants = /enum MenuCommand \{([^}]*\}[^}]*)\}/.exec(appMenuSource)?.[1] ?? "";
  const shell = [...variants.matchAll(/^\s*(\w+)/gm)].map((m) => m[1]?.replace(/(?<=.)([A-Z])/g, "-$1").toLowerCase());
  const ui = [...appMenuUiSource.matchAll(/kind: z\.literal\("([\w-]+)"\)/g)].map((m) => m[1]);
  expect(shell).toEqual(["view", "new-window"]);
  expect(ui).toEqual(shell);
});

test("the View menu has the activity bar's views with their names and shortcuts, and Settings in the app menu", () => {
  const entry = /\{ id: "(\w+)", label: "([^"]+)", (?:icon: \w+, )?shortcut: "([^"]+)"/g;
  const ui = [...appSource.matchAll(entry)].map((m) => [m[1], m[2], m[3]]);
  const shell = [...appMenuSource.matchAll(/MenuView \{ id: "(\w+)", label: "([^"]+)", shortcut: "([^"]+)" \}/g)].map((m) => [
    m[1],
    m[2]?.replace("…", ""),
    m[3],
  ]);
  expect(ui.map((v) => v[0])).toEqual(["home", "repos", "sessions", "graph", "daemon", "settings"]);
  expect(shell).toEqual(ui);
});
