import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { globalConfigFiles } from "../src/modules/vcs/config-memo.ts";

describe("globalConfigFiles", () => {
  test("GIT_CONFIG_GLOBAL replaces every other global file, as in git", () => {
    expect(globalConfigFiles({ GIT_CONFIG_GLOBAL: join("cfg", "git"), HOME: "home" })).toEqual([join("cfg", "git")]);
  });

  test("HOME wins over HOMEDRIVE and HOMEPATH, and XDG_CONFIG_HOME defaults to .config in it", () => {
    expect(globalConfigFiles({ HOME: "home", HOMEDRIVE: "H:", HOMEPATH: "\\user" })).toEqual([
      join("home", ".gitconfig"),
      join("home", ".config", "git", "config"),
    ]);
  });

  test("without HOME, HOMEDRIVE and HOMEPATH name the home directory, as in Git for Windows", () => {
    expect(globalConfigFiles({ HOMEDRIVE: "H:", HOMEPATH: "\\user", XDG_CONFIG_HOME: "xdg" })).toEqual([
      join("H:\\user", ".gitconfig"),
      join("xdg", "git", "config"),
    ]);
  });
});
