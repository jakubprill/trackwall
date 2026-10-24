import { spawn } from "node:child_process";

/**
 * Hands a URL or a folder to the system without waiting for it and without inheriting stdio. The daemon does not know
 * whether anything handled it, so the callers only confirm that they asked.
 */

/** Opens a URL in the default browser. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  detached(cmd, args, "the browser");
}

/**
 * Opens a folder in Explorer, Finder or the Linux file manager (ADR-51). The path is a full path from the daemon's own
 * configuration, so it never starts with `-` and cannot be read as an option.
 */
export function openFolder(dir: string): void {
  const [cmd, args] =
    process.platform === "win32" ? ["explorer.exe", [dir]] : process.platform === "darwin" ? ["open", [dir]] : ["xdg-open", [dir]];
  detached(cmd, args, "the folder");
}

function detached(cmd: string, args: string[], what: string): void {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", (err) => process.stderr.write(`[daemon] failed to open ${what}: ${err.message}\n`));
  child.unref();
}
