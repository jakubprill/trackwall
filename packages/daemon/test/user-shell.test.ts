import { describe, expect, test } from "bun:test";
import { userShell } from "../src/infra/user-shell.ts";

const everyShell = () => true;

describe("the user's shell for a folder terminal", () => {
  test("on Linux it is $SHELL, and on macOS $SHELL as a login shell", () => {
    expect(userShell({ SHELL: "/usr/bin/zsh" }, "linux", everyShell)).toEqual(["/usr/bin/zsh"]);
    expect(userShell({ SHELL: "/bin/zsh" }, "darwin", everyShell)).toEqual(["/bin/zsh", "-l"]);
  });

  test("a relative, missing or not executable $SHELL falls back to bash, then sh", () => {
    expect(userShell({ SHELL: "zsh" }, "linux", everyShell)).toEqual(["/bin/bash"]);
    expect(userShell({}, "linux", everyShell)).toEqual(["/bin/bash"]);
    expect(userShell({ SHELL: "/opt/fish" }, "linux", (path) => path === "/bin/sh")).toEqual(["/bin/sh"]);
  });

  test("with no shell that can run, the start is refused as a terminal that is unavailable", () => {
    expect(() => userShell({}, "linux", () => false)).toThrow(expect.objectContaining({ code: "terminal_unavailable" }));
  });

  test("on Windows it is ComSpec, or cmd.exe in the system folder", () => {
    expect(userShell({ ComSpec: "C:\\Windows\\system32\\cmd.exe" }, "win32", everyShell)).toEqual(["C:\\Windows\\system32\\cmd.exe"]);
    expect(userShell({ ComSpec: "cmd.exe", SystemRoot: "D:\\Win" }, "win32", everyShell)).toEqual(["D:\\Win\\System32\\cmd.exe"]);
  });
});
