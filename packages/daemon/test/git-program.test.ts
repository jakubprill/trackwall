import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { directGit, gitProgram, withPathPrefix } from "../src/modules/vcs/git-program.ts";

describe("directGit", () => {
  test("finds the real git.exe of Git for Windows next to its exec path, with its bin and usr\\bin for PATH", () => {
    const present = new Set(["C:\\Program Files\\Git\\mingw64\\bin\\git.exe", "C:\\Program Files\\Git\\usr\\bin"]);
    expect(directGit("C:/Program Files/Git/mingw64/libexec/git-core", (p) => present.has(p))).toEqual({
      command: "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
      pathPrefix: ["C:\\Program Files\\Git\\mingw64\\bin", "C:\\Program Files\\Git\\usr\\bin"],
    });
  });

  test("a layout without usr\\bin puts only git's own bin in front of PATH", () => {
    const present = new Set(["D:\\tools\\git\\ucrt64\\bin\\git.exe"]);
    expect(directGit("D:\\tools\\git\\ucrt64\\libexec\\git-core", (p) => present.has(p))?.pathPrefix).toEqual([
      "D:\\tools\\git\\ucrt64\\bin",
    ]);
  });

  test("an unusual layout or an empty answer keeps git from PATH", () => {
    expect(directGit("C:/somewhere/else/git-core", () => false)).toBeUndefined();
    expect(directGit("", () => true)).toBeUndefined();
  });
});

describe("withPathPrefix", () => {
  test("puts the directories in front of the variable whatever the case of its name", () => {
    expect(withPathPrefix({ Path: "C:\\Windows" }, ["C:\\Git\\bin"])).toEqual({ Path: "C:\\Git\\bin;C:\\Windows" });
  });

  test("no prefix leaves the environment as it is", () => {
    const env = { PATH: "/usr/bin" };
    expect(withPathPrefix(env, [])).toBe(env);
  });
});

describe("gitProgram", () => {
  test.if(process.platform === "win32")("on Windows is the real git.exe of Git for Windows, not the launcher on PATH", async () => {
    const program = await gitProgram();
    expect(program.command).toMatch(/\\bin\\git\.exe$/i);
    expect(existsSync(program.command)).toBe(true);
  });

  test.if(process.platform !== "win32")("elsewhere is git from PATH", async () => {
    expect(await gitProgram()).toEqual({ command: "git", pathPrefix: [] });
  });
});
