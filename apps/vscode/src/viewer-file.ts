import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { TRACKWALL_DIR, TRACKWALL_HOME_ENV, VIEWER_FILE, ViewerFile } from "@trackwall/protocol";

/**
 * Where the extension finds the daemon (ADR-221): `viewer.json` in Trackwall's state folder, which the daemon writes only
 * while the user has turned on "VS Code extension" in Settings. The folder is the one the daemon itself picks
 * (`resolveTrackwallHome` in the daemon, whose code an extension cannot import): the extension's setting, then `TRACKWALL_HOME`, then `.trackwall` in the home folder. The extension runs where the
 * workspace is (in a dev container, inside it), which is where a daemon in that container writes its folder.
 */

export function stateFolder(setting: string, env: NodeJS.ProcessEnv = process.env): string {
  if (setting.trim() !== "") return resolve(setting.trim());
  const fromEnv = env[TRACKWALL_HOME_ENV];
  if (fromEnv) return resolve(fromEnv);
  return join(homedir(), TRACKWALL_DIR);
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
