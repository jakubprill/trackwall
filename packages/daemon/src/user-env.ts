import { spawn } from "node:child_process";
import { TRACKWALL_HOME_ENV } from "@trackwall/protocol";

/**
 * Środowisko dla procesów, które daemon uruchamia w imieniu użytkownika (taski mise). Na macOS aplikacja otwarta
 * z Findera albo Docka dostaje od launchd tylko systemowy `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), bez Homebrew
 * i `~/.local/bin`, więc ani `mise`, ani narzędzia z tasków by się nie znalazły. Dlatego `PATH` pochodzi z powłoki
 * logowania użytkownika, raz na działanie daemona, tak jak robi to VS Code. Windows dziedziczy `PATH` z Eksploratora.
 */

const SHELL_TIMEOUT_MS = 10_000;
const MARK = "__TRACKWALL_PATH__";

let loginPath: Promise<string | undefined> | undefined;

export async function userEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Katalog stanu tego daemona nie jest ustawieniem uruchamianego repo (np. Trackwall w trybie dev z folderu z projektami).
  delete env[TRACKWALL_HOME_ENV];
  if (process.platform === "darwin") {
    loginPath ??= readLoginPath();
    const path = await loginPath;
    if (path) env.PATH = path;
  }
  return env;
}

/** `PATH` z interaktywnej powłoki logowania (`-ilc`: tam `brew shellenv` i `mise activate` z `.zprofile` i `.zshrc`). */
function readLoginPath(): Promise<string | undefined> {
  const shell = process.env.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(shell, ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`], { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(undefined);
    }, SHELL_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const match = out.match(new RegExp(`${MARK}(.*)${MARK}`, "s"));
      resolve(match?.[1] || undefined);
    });
  });
}
