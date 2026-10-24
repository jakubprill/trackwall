import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TRACKWALL_LINK_SCHEME } from "@trackwall/protocol";
import { z } from "zod";
import { parseFile, REPO } from "../scripts/lib.ts";

// The shell (Rust) and the UI (TypeScript) share no code, so this test guards the names and the shape between them.
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const shellSource = read("apps/desktop/src-tauri/src/focus.rs");
const linkSource = read("apps/desktop/src-tauri/src/link.rs");
const uiSource = read("packages/ui/src/lib/use-focus-request.ts");

test("the shell signals a jump under the same event name the UI listens to", () => {
  const shell = /const FOCUS_EVENT: &str = "([^"]+)";/.exec(shellSource)?.[1];
  const ui = /const FOCUS_EVENT = "([^"]+)";/.exec(uiSource)?.[1];
  expect(shell).toBe("focus-requested");
  expect(ui).toBe(shell);
});

test("the UI takes the jump with the command the shell defines", () => {
  const shell = /#\[tauri::command\]\s*pub fn (\w+)/.exec(shellSource)?.[1];
  const ui = /const TAKE_FOCUS_COMMAND = "([^"]+)";/.exec(uiSource)?.[1];
  expect(shell).toBe("take_focus");
  expect(ui).toBe(shell);
});

test("the kinds of jump targets (`kind`) are the same in the shell and in the UI", () => {
  // `Focus` in Rust has `rename_all = "lowercase"`, so the `Proposal` variant is `"proposal"`.
  const shell = [...(/pub enum Focus \{([^}]*)\}/.exec(shellSource)?.[1] ?? "").matchAll(/(\w+)\(/g)].map((m) => m[1]?.toLowerCase());
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
