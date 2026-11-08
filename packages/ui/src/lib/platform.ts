export type System = "windows" | "mac" | "other";

/** The system from the user agent: WKWebView and Safari say `Macintosh`, WebView2 says `Windows`. */
export function systemOf(userAgent: string): System {
  if (userAgent.includes("Windows")) return "windows";
  if (userAgent.includes("Mac")) return "mac";
  return "other";
}

const SYSTEM = systemOf(navigator.userAgent);

export const IS_MAC = SYSTEM === "mac";
export const IS_WINDOWS = SYSTEM === "windows";

/** The system app that shows folders, as its button names it (ADR-51). */
export const FILE_MANAGER = { windows: "Explorer", mac: "Finder", other: "the file manager" }[SYSTEM];

/** What the path fields of Settings show while empty, written the way paths look on `system`. */
export interface ExamplePaths {
  projectsDir: string;
  gitProgram: string;
  devContainerFolder: string;
}

export function examplePaths(system: System): ExamplePaths {
  return EXAMPLE_PATHS[system];
}

const EXAMPLE_PATHS: Record<System, ExamplePaths> = {
  windows: {
    projectsDir: "C:\\Users\\me\\Projects",
    gitProgram: "C:\\Users\\me\\Dev\\tools\\MinGit\\cmd\\git.exe",
    devContainerFolder: "C:\\Users\\me\\Dev\\workspace",
  },
  mac: { projectsDir: "/Users/me/Projects", gitProgram: "/opt/homebrew/bin/git", devContainerFolder: "/Users/me/Dev/workspace" },
  other: { projectsDir: "/home/me/Projects", gitProgram: "/usr/bin/git", devContainerFolder: "/home/me/Dev/workspace" },
};

/** Example paths on this computer, where the window runs. */
export const LOCAL_EXAMPLE_PATHS = examplePaths(SYSTEM);

/**
 * Example paths on the daemon's machine: this computer when the daemon has its desktop, else a Linux container or
 * server (ADR-120), whatever system the window runs on.
 */
export function daemonExamplePaths(desktop: boolean): ExamplePaths {
  return desktop ? LOCAL_EXAMPLE_PATHS : examplePaths("other");
}
