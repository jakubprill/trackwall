import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { TRACKWALL_DIR, TRACKWALL_HOME_ENV, VIEWER_FILE, ViewerFile } from "@trackwall/protocol";

/**
 * Where the extension finds the daemon (ADR-221): `viewer.json` in Trackwall's state folder, which the daemon writes only
 * while the user has turned on "VS Code extension" in Settings. The folder is the one the daemon itself picks
 * (`resolveTrackwallHome` in the daemon, whose code an extension cannot import): the extension's setting, then `TRACKWALL_HOME`, then `.trackwall` in the home folder. The extension runs where the
 * workspace is (in a dev container, inside it), which is where a daemon in that container writes its folder.
 *
 * VS Code applies a user setting written on the host also in a dev container's window, where a host path such as
 * `/Users/…` does not exist. A set folder that does not exist on this machine is therefore ignored (ADR-221): no
 * daemon can have written `viewer.json` there, and the folder comes from `TRACKWALL_HOME` or the home folder as if the
 * setting were empty. The side bar names the ignored setting, so the choice is never silent.
 */

export interface StateFolder {
  path: string;
  /** The set folder, when it does not exist here and `path` comes from the defaults instead. */
  ignoredSetting: string | null;
}

export function stateFolder(setting: string, env: NodeJS.ProcessEnv = process.env): StateFolder {
  const set = setting.trim() === "" ? null : resolve(setting.trim());
  if (set !== null && existsSync(set)) return { path: set, ignoredSetting: null };
  return { path: defaultStateFolder(env), ignoredSetting: set };
}

function defaultStateFolder(env: NodeJS.ProcessEnv): string {
  const fromEnv = env[TRACKWALL_HOME_ENV];
  if (fromEnv) return resolve(fromEnv);
  return join(homedir(), TRACKWALL_DIR);
}

/** The side bar's text while there is no `viewer.json`: which file it looked for, and why not where the setting points. */
export function notSharingMessage(folder: StateFolder): string {
  const ignored =
    folder.ignoredSetting === null
      ? ""
      : ` "Trackwall: State Folder" is ${folder.ignoredSetting}, which does not exist on this machine, so it is ignored here.`;
  return (
    `Trackwall is not sharing its sessions with VS Code yet: there is no ${join(folder.path, VIEWER_FILE)}.${ignored}` +
    ` Turn on "VS Code extension" in Trackwall's Settings > App. This side bar fills in a few seconds later.`
  );
}

export type ViewerFileRead = { kind: "found"; file: ViewerFile } | { kind: "missing" } | { kind: "invalid"; reason: string };

export async function readViewerFile(folder: string): Promise<ViewerFileRead> {
  let text: string;
  try {
    text = await readFile(join(folder, VIEWER_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid", reason: (err as Error).message };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "invalid", reason: `${VIEWER_FILE} is not JSON` };
  }
  const parsed = ViewerFile.safeParse(json);
  return parsed.success ? { kind: "found", file: parsed.data } : { kind: "invalid", reason: `${VIEWER_FILE} is not what Trackwall writes` };
}
