import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { REPO } from "../scripts/lib.ts";

// Checks files of the whole repo, not of the desktop package; it lives here because the root has no tests of its own.
const read = (path: string) => readFileSync(join(REPO, path), "utf8");

const MiseToml = z.object({ tools: z.record(z.string(), z.string()) });
const miseTools = () => MiseToml.parse(Bun.TOML.parse(read("mise.toml"))).tools;

/** The value of a variable from a workflow's `env:`; a variable set more than once (for example overridden in a job) is an error. */
function workflowEnv(yaml: string, name: string): string | undefined {
  const values = [...yaml.matchAll(new RegExp(`^\\s+${name}:\\s*["']?([^"'\\s#]+)`, "gm"))].map((m) => m[1]);
  if (values.length > 1) throw new Error(`${name} set ${values.length} times`);
  return values[0];
}

test("a version variable overridden in a job, also without quotes, is an error", () => {
  const yaml = 'env:\n  NODE_VERSION: "22"\njobs:\n  a:\n    env:\n      NODE_VERSION: 20\n';
  expect(() => workflowEnv(yaml, "NODE_VERSION")).toThrow("NODE_VERSION set 2 times");
});

test("mise.toml sets the versions of Node, Bun, pnpm and Rust", () => {
  expect(Object.keys(miseTools()).sort()).toEqual(["bun", "node", "pnpm", "rust"]);
});

/** The versions each workflow sets in `env`; the documentation site and the contract tests build no Rust, the nightly workflow only calls contract.yml. */
const WORKFLOW_TOOLS = {
  ".github/workflows/ci.yml": { node: "NODE_VERSION", bun: "BUN_VERSION", rust: "RUST_VERSION" },
  ".github/workflows/release.yml": { node: "NODE_VERSION", bun: "BUN_VERSION", rust: "RUST_VERSION" },
  ".github/workflows/pages.yml": { node: "NODE_VERSION", bun: "BUN_VERSION" },
  ".github/workflows/contract.yml": { node: "NODE_VERSION", bun: "BUN_VERSION" },
  ".github/workflows/nightly.yml": {},
} satisfies Record<string, Partial<Record<"node" | "bun" | "rust", string>>>;

test("every workflow in .github/workflows is checked for its tool versions", () => {
  const workflows = readdirSync(join(REPO, ".github/workflows")).map((name) => `.github/workflows/${name}`);
  expect(workflows.sort()).toEqual(Object.keys(WORKFLOW_TOOLS).sort());
});

test("every workflow uses the Node, Bun and Rust versions from mise.toml", () => {
  const tools = miseTools();
  for (const [workflow, variables] of Object.entries(WORKFLOW_TOOLS)) {
    const yaml = read(workflow);
    const inWorkflow = Object.fromEntries(Object.entries(variables).map(([tool, variable]) => [tool, workflowEnv(yaml, variable)]));
    const inMise = Object.fromEntries(Object.keys(variables).map((tool) => [tool, tools[tool]]));
    expect({ workflow, ...inWorkflow }).toEqual({ workflow, ...inMise });
  }
});

test("pnpm from mise.toml is the one from packageManager, and Rust from mise.toml the one from rust-version in Cargo.toml", () => {
  const tools = miseTools();
  expect(read("package.json")).toContain(`"packageManager": "pnpm@${tools.pnpm}"`);
  expect(read("apps/desktop/src-tauri/Cargo.toml")).toContain(`rust-version = "${tools.rust}"`);
});
