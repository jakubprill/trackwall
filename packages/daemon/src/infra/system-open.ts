import { spawn } from "node:child_process";

/**
 * Hands a URL or a folder to the system without waiting for it and without inheriting stdio. The daemon does not know
 * whether anything handled it, so the callers only confirm that they asked.
 */

/** `hidden` starts the program with SW_HIDE on Windows, which suits a helper without a window but not Explorer itself. */
type Command = { program: string; args: string[]; verbatim: boolean; hidden: boolean };

/** Opens a URL in the default browser. */
export function openBrowser(url: string): void {
  run(browserCommand(process.platform, url), "the browser");
}

/** Opens a folder in Explorer, Finder or the Linux file manager (ADR-51). */
export function openFolder(dir: string): void {
  run(folderCommand(process.platform, dir), "the folder");
}

export function browserCommand(platform: NodeJS.Platform, url: string): Command {
  if (platform === "win32") return { program: "rundll32", args: ["url.dll,FileProtocolHandler", url], verbatim: false, hidden: true };
  return elsewhere(platform, url);
}

/**
 * Explorer splits its command line at commas, so the path always goes in quotes, verbatim (a Windows path cannot
 * contain `"`). The path is a full path from the daemon's own list of repos, so it never starts with `-`.
 */
export function folderCommand(platform: NodeJS.Platform, dir: string): Command {
  if (platform === "win32") return { program: "explorer.exe", args: [`"${dir}"`], verbatim: true, hidden: false };
  return elsewhere(platform, dir);
}

/** macOS and Linux open a URL and a folder with the same program. */
function elsewhere(platform: NodeJS.Platform, target: string): Command {
  return { program: platform === "darwin" ? "open" : "xdg-open", args: [target], verbatim: false, hidden: true };
}

function run({ program, args, verbatim, hidden }: Command, what: string): void {
  const child = spawn(program, args, { detached: true, stdio: "ignore", windowsHide: hidden, windowsVerbatimArguments: verbatim });
  child.on("error", (err) => process.stderr.write(`[daemon] failed to open ${what}: ${err.message}\n`));
  child.unref();
}
