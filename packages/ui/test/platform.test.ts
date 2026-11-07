import { describe, expect, test } from "bun:test";
import { daemonExamplePaths, examplePaths, systemOf } from "../src/lib/platform.ts";

describe("platform", () => {
  test("the system comes from the user agent: Windows for WebView2, mac for WKWebView, other for the rest", () => {
    expect(systemOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/141.0")).toBe("windows");
    expect(systemOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("mac");
    expect(systemOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15")).toBe("other");
  });

  test("the example paths of the settings are written the way paths look on each system", () => {
    expect(examplePaths("windows")).toEqual({
      projectsDir: "C:\\Users\\me\\Projects",
      gitProgram: "C:\\Users\\me\\Dev\\tools\\MinGit\\cmd\\git.exe",
      devContainerFolder: "C:\\Users\\me\\Dev\\workspace",
    });
    expect(examplePaths("mac")).toEqual({
      projectsDir: "/Users/me/Projects",
      gitProgram: "/opt/homebrew/bin/git",
      devContainerFolder: "/Users/me/Dev/workspace",
    });
    expect(examplePaths("other")).toEqual({
      projectsDir: "/home/me/Projects",
      gitProgram: "/usr/bin/git",
      devContainerFolder: "/home/me/Dev/workspace",
    });
  });

  test("a daemon without a desktop, as in a container, gets Linux examples whatever system the window runs on", () => {
    expect(daemonExamplePaths(false)).toEqual(examplePaths("other"));
  });
});
