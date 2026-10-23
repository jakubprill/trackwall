import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../scripts/lib.ts";

const read = (path: string) => readFileSync(join(REPO, path), "utf8");

/** `[tools]` z mise.toml: `nazwa = "wersja"` w każdej linii. */
function miseTools(): Record<string, string> {
  return Object.fromEntries([...read("mise.toml").matchAll(/^(\w+)\s*=\s*"([^"]+)"/gm)].map(([, name, version]) => [name, version]));
}

function workflowEnv(path: string, name: string): string | undefined {
  return read(path).match(new RegExp(`^\\s+${name}:\\s*"([^"]+)"`, "m"))?.[1];
}

test("mise.toml ustala wersje Node, Bun, pnpm i Rust", () => {
  expect(Object.keys(miseTools()).sort()).toEqual(["bun", "node", "pnpm", "rust"]);
});

test("mise.toml i oba workflow używają tych samych wersji Node, Bun i Rust", () => {
  const tools = miseTools();
  for (const workflow of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    expect({
      workflow,
      node: workflowEnv(workflow, "NODE_VERSION"),
      bun: workflowEnv(workflow, "BUN_VERSION"),
      rust: workflowEnv(workflow, "RUST_VERSION"),
    }).toEqual({
      workflow,
      node: tools.node,
      bun: tools.bun,
      rust: tools.rust,
    });
  }
});

test("pnpm z mise.toml jest tym z packageManager, a Rust z mise.toml tym z rust-version w Cargo.toml", () => {
  const tools = miseTools();
  expect(read("package.json")).toContain(`"packageManager": "pnpm@${tools.pnpm}"`);
  expect(read("apps/desktop/src-tauri/Cargo.toml")).toContain(`rust-version = "${tools.rust}"`);
});
