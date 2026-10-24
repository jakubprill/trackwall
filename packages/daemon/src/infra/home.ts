import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { TRACKWALL_HOME_ENV } from "@trackwall/protocol";

/**
 * Katalog stanu daemona: `--home`, potem `TRACKWALL_HOME`, potem `~/.trackwall`.
 * Pusta wartość znaczy „nie ustawiono”, tak samo jak w powłoce Tauri.
 */
export function trackwallHome(override?: string): string {
  return resolve(override || process.env[TRACKWALL_HOME_ENV] || defaultTrackwallHome());
}

/** `~/.trackwall`: katalog stanu, gdy ani `--home`, ani `TRACKWALL_HOME` go nie wskazują. */
export function defaultTrackwallHome(): string {
  return join(homedir(), ".trackwall");
}
