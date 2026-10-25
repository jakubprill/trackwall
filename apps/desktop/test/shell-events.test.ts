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
