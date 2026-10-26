import { describe, expect, test } from "bun:test";
import { extractNpm } from "../src/modules/cards/npm.ts";
import { snapshotOf } from "./support/snapshot.ts";

const ROOT = JSON.stringify(
  {
    name: "shop-web",
    private: true,
    packageManager: "pnpm@10.28.0+sha512.abc",
    engines: { node: ">=22" },
    devDependencies: { typescript: "5.9.3" },
  },
  null,
  2,
);

describe("npm extractor", () => {
  test("a pnpm monorepo: packages from pnpm-workspace.yaml, private ones are not provided, dependencies between them skipped", () => {
    const out = extractNpm(
      snapshotOf(
        {
          "package.json": ROOT,
          "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/**\n  - '!packages/legacy'\n",
          "apps/web/package.json": JSON.stringify(
            { name: "@shop/web", private: true, dependencies: { react: "19.1.0", "@shop/ui": "workspace:*" } },
            null,
            2,
          ),
          "packages/ui/package.json": JSON.stringify({ name: "@shop/ui", version: "1.2.0", peerDependencies: { react: ">=18" } }, null, 2),
          "packages/legacy/package.json": JSON.stringify({ name: "@shop/legacy" }),
          "tools/scratch/package.json": JSON.stringify({ name: "scratch" }),
        },
        ["pnpm-lock.yaml"],
      ),
    );

    expect(out.buildFiles).toEqual([
      { path: "package.json", tool: "pnpm", name: "shop-web", memberOf: null },
      { path: "apps/web/package.json", tool: "pnpm", name: "@shop/web", memberOf: "package.json" },
      { path: "packages/ui/package.json", tool: "pnpm", name: "@shop/ui", memberOf: "package.json" },
    ]);
    expect(out.provides).toEqual([
      { kind: "package", ecosystem: "npm", name: "@shop/ui", version: "1.2.0", evidence: { path: "packages/ui/package.json", line: 2 } },
    ]);
    expect(out.consumes.map((c) => [c.name, c.version, c.scope, c.evidence.path, c.evidence.line])).toEqual([
      ["typescript", "5.9.3", "devDependencies", "package.json", 9],
      ["react", "19.1.0", "dependencies", "apps/web/package.json", 5],
      ["react", ">=18", "peerDependencies", "packages/ui/package.json", 5],
    ]);
    expect(out.tools.map((t) => [t.tool, t.version, t.evidence.line])).toEqual([
      ["node", ">=22", 6],
      ["pnpm", "10.28.0", 4],
    ]);
  });

  test("workspaces in package.json and the manager from the lock file", () => {
    const out = extractNpm(
      snapshotOf(
        { "package.json": JSON.stringify({ name: "root", workspaces: ["libs/*"] }), "libs/a/package.json": JSON.stringify({ name: "a" }) },
        ["yarn.lock"],
      ),
    );
    expect(out.buildFiles.map((f) => [f.path, f.tool, f.memberOf])).toEqual([
      ["package.json", "yarn", null],
      ["libs/a/package.json", "yarn", "package.json"],
    ]);
  });

  test("bad JSON is an invalid-file card problem, and a field of the wrong type is skipped without losing the rest", () => {
    const out = extractNpm(
      snapshotOf({ "a/package.json": "{ not json", "b/package.json": JSON.stringify({ name: "b", version: 3, dependencies: { x: "1" } }) }),
    );
    expect(out.problems.map((p) => `${p.code} ${p.path}`)).toEqual(["file-invalid a/package.json"]);
    expect(out.provides.map((p) => [p.name, p.version])).toEqual([["b", null]]);
    expect(out.consumes.map((c) => c.name)).toEqual(["x"]);
  });
});
