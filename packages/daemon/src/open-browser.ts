import { spawn } from "node:child_process";

/** Otwiera URL w domyślnej przeglądarce bez czekania na nią i bez dziedziczenia stdio. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", (err) => process.stderr.write(`[daemon] failed to open the browser: ${err.message}\n`));
  child.unref();
}
