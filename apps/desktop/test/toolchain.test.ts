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
function workflowEnv(yaml: string, name: string): string | undefined {
  const values = [...yaml.matchAll(new RegExp(`^\\s+${name}:\\s*["']?([^"'\\s#]+)`, "gm"))].map((m) => m[1]);
  if (values.length > 1) throw new Error(`${name} ustawione ${values.length} razy`);
  return values[0];
}

test("zmienna wersji nadpisana w jobie, także bez cudzysłowu, jest błędem", () => {
  const yaml = 'env:\n  NODE_VERSION: "22"\njobs:\n  a:\n    env:\n      NODE_VERSION: 20\n';
  expect(() => workflowEnv(yaml, "NODE_VERSION")).toThrow("NODE_VERSION ustawione 2 razy");
});

test("mise.toml ustala wersje Node, Bun, pnpm i Rust", () => {
  expect(Object.keys(miseTools()).sort()).toEqual(["bun", "node", "pnpm", "rust"]);
});

/** The versions each workflow sets in `env`; the documentation site builds no Rust. */
const WORKFLOW_TOOLS = {
  ".github/workflows/ci.yml": { node: "NODE_VERSION", bun: "BUN_VERSION", rust: "RUST_VERSION" },
  ".github/workflows/release.yml": { node: "NODE_VERSION", bun: "BUN_VERSION", rust: "RUST_VERSION" },
  ".github/workflows/pages.yml": { node: "NODE_VERSION", bun: "BUN_VERSION" },
} satisfies Record<string, Partial<Record<"node" | "bun" | "rust", string>>>;

test("every workflow uses the Node, Bun and Rust versions from mise.toml", () => {
  const tools = miseTools();
  for (const [workflow, variables] of Object.entries(WORKFLOW_TOOLS)) {
    const yaml = read(workflow);
    const inWorkflow = Object.fromEntries(Object.entries(variables).map(([tool, variable]) => [tool, workflowEnv(yaml, variable)]));
    const inMise = Object.fromEntries(Object.keys(variables).map((tool) => [tool, tools[tool]]));
    expect({ workflow, ...inWorkflow }).toEqual({ workflow, ...inMise });
  }
});

test("pnpm z mise.toml jest tym z packageManager, a Rust z mise.toml tym z rust-version w Cargo.toml", () => {
  const tools = miseTools();
  expect(read("package.json")).toContain(`"packageManager": "pnpm@${tools.pnpm}"`);
  expect(read("apps/desktop/src-tauri/Cargo.toml")).toContain(`rust-version = "${tools.rust}"`);
});
