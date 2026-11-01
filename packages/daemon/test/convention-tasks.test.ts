import { describe, expect, test } from "bun:test";
import { parse } from "smol-toml";
import { CONVENTION_TASKS } from "../src/modules/mise/convention-tasks.ts";

// The text of the convention tasks file (ADR-157); what real mise does with it on real Maven and Gradle projects is in
// packages/daemon/jvm/java-projects.jvm.ts.

const tasks = (parse(CONVENTION_TASKS) as { tasks: Record<string, Record<string, unknown>> }).tasks;

describe("the convention tasks file", () => {
  test("defines setup, build and test, and no dev, which would make every repo a service", () => {
    expect(Object.keys(tasks)).toEqual(["setup", "build", "test"]);
  });

  test("every mise task runs in the directory mise is called in, the repo root or the task worktree, not the projects folder", () => {
    expect(Object.values(tasks).map((t) => t.dir)).toEqual(["{{cwd}}", "{{cwd}}", "{{cwd}}"]);
  });

  test("every mise task has a script for sh and one for cmd.exe, and fails when it finds no build file", () => {
    for (const task of Object.values(tasks)) {
      expect(task.run).toContain("exit 1");
      expect(task.run_windows).toContain("exit 1");
    }
  });

  test("only test declares an argument, an optional filter that the scripts read quoted from usage_filter", () => {
    expect(Object.entries(tasks).map(([name, t]) => [name, typeof t.usage === "string" && t.usage.startsWith('arg "[filter]"')])).toEqual([
      ["setup", false],
      ["build", false],
      ["test", true],
    ]);
    expect(tasks.test?.run).toContain('"-Dtest=$usage_filter"');
    expect(tasks.test?.run).toContain('--tests "$usage_filter"');
    expect(tasks.test?.run_windows).toContain('"-Dtest=%usage_filter%"');
    expect(String(tasks.test?.run)).not.toContain("{{");
  });

  test("the cmd.exe scripts are one line, since cmd.exe runs a line at a time", () => {
    for (const task of Object.values(tasks)) expect(String(task.run_windows)).not.toContain("\n");
  });
});
