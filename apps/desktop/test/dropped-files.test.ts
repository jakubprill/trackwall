import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_DROP_BYTES } from "@trackwall/protocol";
import { REPO } from "../scripts/lib.ts";

// The shell (Rust) and the UI (TypeScript) share no code, so this test guards the command that reads a dropped file (ADR-196).
const read = (path: string) => readFileSync(join(REPO, path), "utf8");

test("the UI reads a dropped file by the name and argument the shell registers, with the same size limit", () => {
  const shell = read("apps/desktop/src-tauri/src/dropped_files.rs");
  const command = /pub async fn (\w+)\(window: Window, (\w+): String\)/.exec(shell);
  const ui = read("packages/ui/src/lib/dropped-files.ts");
  expect(command?.[1]).toBe("read_dropped_file");
  expect(read("apps/desktop/src-tauri/src/main.rs")).toContain(`dropped_files::${command?.[1]}`);
  expect(/export const READ_COMMAND = "(\w+)";/.exec(ui)?.[1]).toBe(command?.[1]);
  expect(read("packages/ui/src/lib/use-terminal-drop.ts")).toContain(`invoke(READ_COMMAND, { ${command?.[2]} })`);
  expect(shell).toContain(`const MAX_DROP_BYTES: u64 = 256 * 1024 * 1024;`);
  expect(MAX_DROP_BYTES).toBe(256 * 1024 * 1024);
});
