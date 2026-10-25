import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { TRACKWALL_HOME_ENV } from "@trackwall/protocol";

/**
 * The daemon's state directory: `--home`, then `TRACKWALL_HOME`, then `~/.trackwall`.
 * An empty value means "not set", the same as in the Tauri shell.
 */
export function trackwallHome(override?: string): string {
  return resolve(override || process.env[TRACKWALL_HOME_ENV] || defaultTrackwallHome());
}

/** `~/.trackwall`: the state directory when neither `--home` nor `TRACKWALL_HOME` points to one. */
export function defaultTrackwallHome(): string {
  return join(homedir(), ".trackwall");
}
