import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../scripts/lib.ts";

// Powłoka (Rust) i UI (TypeScript) nie mają wspólnego kodu, więc nazwę i kształt zdarzenia między nimi pilnuje ten test.
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const shellSource = read("apps/desktop/src-tauri/src/attention.rs");
const uiSource = read("packages/ui/src/lib/use-session-focus.ts");

test("powłoka wysyła skok do sesji pod tą samą nazwą zdarzenia, której słucha UI", () => {
  const shell = /const FOCUS_EVENT: &str = "([^"]+)";/.exec(shellSource)?.[1];
  const ui = /const FOCUS_EVENT = "([^"]+)";/.exec(uiSource)?.[1];
  expect(shell).toBe("focus-session");
  expect(ui).toBe(shell);
});

test("rodzaje celu skoku z traya (`kind`) są te same w powłoce i w UI", () => {
  // `Focus` w Rust ma `rename_all = "lowercase"`, więc wariant `Proposal` to `"proposal"`.
  const shell = [...(/pub enum Focus<'a> \{([^}]*)\}/.exec(shellSource)?.[1] ?? "").matchAll(/(\w+)\(/g)].map((m) => m[1]?.toLowerCase());
  const ui = [...uiSource.matchAll(/kind: z\.literal\("(\w+)"\)/g)].map((m) => m[1]);
  expect(shell).toEqual(["session", "proposal"]);
  expect(ui).toEqual(shell);
});
