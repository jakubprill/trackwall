import { describe, expect, test } from "bun:test";
import type { MiseTask } from "@trackwall/protocol";
import { groupByPackage } from "../src/lib/mise-packages.ts";

function task(name: string): MiseTask {
  return { name, description: "", source: null, origin: null, usage: null, run: null };
}

describe("groupByPackage", () => {
  test("the root's mise tasks stay apart, and each package's mise tasks go to its group under their own name", () => {
    const grouped = groupByPackage(
      [task("build"), task("//packages/client:test-integration"), task("//packages/client:build:ui"), task("test")],
      [
        { path: "packages/client", problem: null },
        { path: "packages/admin", problem: { kind: "untrusted", message: "Config files in packages/admin/mise.toml are not trusted." } },
      ],
    );

    expect(grouped.root.map((t) => t.name)).toEqual(["build", "test"]);
    expect(grouped.packages.map((g) => [g.path, g.problem?.kind ?? null, g.tasks.map((t) => t.shortName)])).toEqual([
      ["packages/client", null, ["test-integration", "build:ui"]],
      ["packages/admin", "untrusted", []],
    ]);
    expect(grouped.packages[0]?.tasks[0]?.task.name).toBe("//packages/client:test-integration");
  });

  test("a running mise task of a package that is no longer found gets a group of its own, so it can be stopped", () => {
    const grouped = groupByPackage([task("//tools/gen:watch")], []);

    expect(grouped.packages).toEqual([
      { path: "tools/gen", problem: null, tasks: [{ task: task("//tools/gen:watch"), shortName: "watch" }] },
    ]);
  });
});
