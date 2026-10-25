import { spawn } from "node:child_process";
import { TRACKWALL_HOME_ENV } from "@trackwall/protocol";

/**
 * The environment for processes the daemon starts on the user's behalf (mise tasks). On macOS an app opened
 * from Finder or the Dock gets only the system `PATH` from launchd (`/usr/bin:/bin:/usr/sbin:/sbin`), without Homebrew
 * and `~/.local/bin`, so neither `mise` nor the tools of mise tasks would be found. So `PATH` comes from the user's login
 * shell, once per daemon run, as VS Code does. Windows inherits `PATH` from Explorer.
 */

const SHELL_TIMEOUT_MS = 10_000;
const MARK = "__TRACKWALL_PATH__";

let loginPath: Promise<string | undefined> | undefined;

export async function userEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // This daemon's state directory is not a setting of the repo being run (e.g. Trackwall in dev mode from the projects folder).
  delete env[TRACKWALL_HOME_ENV];
  if (process.platform === "darwin") {
    loginPath ??= readLoginPath();
    const path = await loginPath;
    if (path) env.PATH = path;
  }
  return env;
}

/** `PATH` from an interactive login shell (`-ilc`: that is where `brew shellenv` and `mise activate` from `.zprofile` and `.zshrc` run). */
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
