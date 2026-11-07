import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { parseFormatCheck, parseValidation } from "../src/modules/mise/mise-config-check.ts";

// The outputs below are mise 2026.11.1's, captured on real configs, with the repo's path in place of the temporary one.
const ROOT = resolve("projects", "orders-api");
/** The root as given, and as mise prints it after the system resolved a link in it (macOS's `/var` is `/private/var`). */
const RESOLVED = resolve("private", "projects", "orders-api");
const ROOTS = [ROOT, RESOLVED];
const VERSION_LINES =
  "mise ERROR Version: 2026.11.1 linux-x64 (2026-11-04)\nmise ERROR Run with --verbose or MISE_VERBOSE=1 for more information\n";

describe("parseFormatCheck: the files mise fmt --check would rewrite", () => {
  test("a formatted config gives no files and no problem", () => {
    expect(parseFormatCheck({ kind: "exited", code: 0, stdout: "", stderr: "" }, ROOTS)).toEqual({ unformatted: [], problems: [] });
  });

  test("the files mise names by full path come back relative to the repo root, as given or resolved, without files above it", () => {
    const stderr = [
      "mise ERROR Following config files are not properly formatted:",
      join(RESOLVED, ".config", "mise.toml"),
      join(ROOT, "mise.toml"),
      join(ROOT, "..", "mise.toml"),
      VERSION_LINES,
    ].join("\n");

    expect(parseFormatCheck({ kind: "exited", code: 1, stdout: "", stderr }, ROOTS)).toEqual({
      unformatted: [join(".config", "mise.toml"), "mise.toml"],
      problems: [],
    });
  });

  test("a mise without fmt --check is not a problem of the repo", () => {
    const stderr = "error: unexpected argument '--check' found\n\nUsage: mise fmt [OPTIONS]\n";

    expect(parseFormatCheck({ kind: "exited", code: 2, stdout: "", stderr }, ROOTS)).toEqual({ unformatted: [], problems: [] });
  });

  test("a repo without a config of its own has nothing to format, which is not a problem of its config", () => {
    const stderr = `mise ERROR No config file found in current directory\n${VERSION_LINES}`;

    expect(parseFormatCheck({ kind: "exited", code: 1, stdout: "", stderr }, ROOTS)).toEqual({ unformatted: [], problems: [] });
  });

  test("any other failure is one problem with mise's first line", () => {
    const stderr = `mise ERROR TOML parse error at line 2, column 11\n  |\n2 | java = "21\n${VERSION_LINES}`;

    expect(parseFormatCheck({ kind: "exited", code: 1, stdout: "", stderr }, ROOTS)).toEqual({
      unformatted: [],
      problems: [{ severity: "error", message: "TOML parse error at line 2, column 11" }],
    });
  });
});

describe("parseValidation: what mise tasks validate --json and mise's warnings find", () => {
  test("each issue is one line with its task, errors before warnings, and unknown fields of the repo's config are warnings", () => {
    const stdout = JSON.stringify({
      tasks_validated: 3,
      errors: 2,
      warnings: 1,
      issues: [
        { task: "lint", severity: "warning", category: "x", message: "Task is hidden and unused", details: "" },
        {
          task: "test",
          severity: "error",
          category: "dependency-graph-error",
          message: "Failed to build task dependency graph",
          details: "task not found: nope",
        },
        { task: "test", severity: "error", category: "invalid-timeout", message: "Invalid timeout format: 'abc'", details: "" },
      ],
    });
    const stderr = [
      `mise WARN  unknown field in ${join(ROOT, "mise.toml")}:5:1: settings.experimntal (did you mean experimental?)`,
      `mise WARN  unknown field in ${join(ROOT, "mise.toml")}:5:1: settings.experimntal (did you mean experimental?)`,
      `mise WARN  unknown field in ${join(ROOT, "..", "mise.toml")}:2:1: taskz (did you mean tasks?)`,
      "mise ERROR Validation failed with 2 error(s)",
      VERSION_LINES,
    ].join("\n");

    expect(parseValidation({ kind: "exited", code: 1, stdout, stderr }, ROOTS)).toEqual([
      { severity: "error", message: "test: Failed to build task dependency graph: task not found: nope" },
      { severity: "error", message: "test: Invalid timeout format: 'abc'" },
      { severity: "warning", message: "lint: Task is hidden and unused" },
      { severity: "warning", message: "mise.toml:5:1: unknown field settings.experimntal (did you mean experimental?)" },
    ]);
  });

  test("a clean config gives no problem", () => {
    const stdout = JSON.stringify({ tasks_validated: 1, errors: 0, warnings: 0, issues: [] });

    expect(parseValidation({ kind: "exited", code: 0, stdout, stderr: "" }, ROOTS)).toEqual([]);
  });

  test("a mise without tasks validate is not a problem of the repo", () => {
    const stderr = "error: unrecognized subcommand 'validate'\n\nUsage: mise tasks [OPTIONS] [COMMAND]\n";

    expect(parseValidation({ kind: "exited", code: 2, stdout: "", stderr }, ROOTS)).toEqual([]);
  });

  test("a mise that did not finish has no answer to read, which is mise's failure and not the config's", () => {
    expect(parseValidation({ kind: "failed", message: "mise tasks did not finish within 15 s" }, ROOTS)).toBeNull();
  });
});
