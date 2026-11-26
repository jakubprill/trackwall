import { describe, expect, test } from "bun:test";
import { MisePackagePath, packageTaskName, splitPackageTask } from "../src/mise.ts";

describe("the name of a package's mise task (ADR-305)", () => {
  test("it is mise's own notation, and splits back into the package and the name mise gives the task there", () => {
    expect(packageTaskName("packages/client", "test")).toBe("//packages/client:test");
    expect(splitPackageTask("//packages/client:test")).toEqual({ package: "packages/client", task: "test" });
    expect(splitPackageTask("//packages/client:build:ui")).toEqual({ package: "packages/client", task: "build:ui" });
  });

  test("a repo root's mise task has no package, also one whose name only looks like a package's", () => {
    expect(splitPackageTask("build:ui")).toEqual({ package: null, task: "build:ui" });
    expect(splitPackageTask("//no-colon")).toEqual({ package: null, task: "//no-colon" });
    expect(splitPackageTask("//../outside:x")).toEqual({ package: null, task: "//../outside:x" });
    expect(splitPackageTask("//packages/client:")).toEqual({ package: null, task: "//packages/client:" });
  });

  test("a package path is folder names joined by '/', never a way out of the repo", () => {
    expect(MisePackagePath.safeParse("services/orders/api").success).toBe(true);
    for (const bad of ["", "/abs", "a//b", "a/./b", "../up", "a/..", "c:\\x", "a\\b"])
      expect(MisePackagePath.safeParse(bad).success).toBe(false);
  });
});
