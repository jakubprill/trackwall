import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type StateDirSource, TRACKWALL_HOME_ENV } from "@trackwall/protocol";

/**
 * The daemon's state directory: `--home`, then `TRACKWALL_HOME`, then `~/.trackwall`.
 * An empty value means "not set", the same as in the Tauri shell.
 */
export function trackwallHome(override?: string): string {
  return resolveTrackwallHome(override).path;
}

/** The state directory with which of the three chose it, for the view of the config files (ADR-108). */
export function resolveTrackwallHome(override?: string): { path: string; from: StateDirSource } {
  if (override) return { path: resolve(override), from: "flag" };
  const fromEnv = process.env[TRACKWALL_HOME_ENV];
  if (fromEnv) return { path: resolve(fromEnv), from: "env" };
  return { path: resolve(defaultTrackwallHome()), from: "default" };
}

/** `~/.trackwall`: the state directory when neither `--home` nor `TRACKWALL_HOME` points to one. */
export function defaultTrackwallHome(): string {
  return join(homedir(), ".trackwall");
}
