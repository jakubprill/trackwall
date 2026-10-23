import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { REPO } from "../scripts/lib.ts";

// Sprawdza pliki całego repo, nie paczki desktop; leży tu, bo root nie ma własnych testów.
const read = (path: string) => readFileSync(join(REPO, path), "utf8");

const MiseToml = z.object({ tools: z.record(z.string(), z.string()) });
const miseTools = () => MiseToml.parse(Bun.TOML.parse(read("mise.toml"))).tools;

/** Wartość zmiennej z `env:` workflow; zmienna ustawiona więcej niż raz (np. nadpisana w jobie) to błąd. */
function workflowEnv(path: string, name: string): string | undefined {
  const values = [...read(path).matchAll(new RegExp(`^\\s+${name}:\\s*"([^"]+)"`, "gm"))].map((m) => m[1]);
  if (values.length > 1) throw new Error(`${path}: ${name} ustawione ${values.length} razy`);
  return values[0];
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
