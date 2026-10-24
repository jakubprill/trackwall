import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../scripts/lib.ts";

// The shell (Rust) and the UI (TypeScript) share no code, so this test guards the folder picker command between them (ADR-51).
const read = (path: string) => readFileSync(join(REPO, path), "utf8");

test("the UI calls the folder picker by the name and with the argument the shell registers", () => {
  const command = /pub async fn (\w+)\(window: WebviewWindow, (\w+): String\)/.exec(read("apps/desktop/src-tauri/src/folder_picker.rs"));
  const ui = read("packages/ui/src/lib/folder-picker.ts");
  expect(command?.[1]).toBe("pick_projects_folder");
  expect(read("apps/desktop/src-tauri/src/main.rs")).toContain(`folder_picker::${command?.[1]}`);
  expect(/const PICK_COMMAND = "(\w+)";/.exec(ui)?.[1]).toBe(command?.[1]);
  expect(ui).toContain(`invoke<unknown>(PICK_COMMAND, { ${command?.[2]} })`);
});
