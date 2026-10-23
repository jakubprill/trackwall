import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PITWALL_HOME_ENV } from "@pitwall/protocol";

/**
 * Katalog stanu daemona: `--home`, potem `PITWALL_HOME`, potem `~/.pitwall`.
 * Pusta wartość znaczy „nie ustawiono”, tak samo jak w powłoce Tauri.
 */
export function pitwallHome(override?: string): string {
  return resolve(override || process.env[PITWALL_HOME_ENV] || join(homedir(), ".pitwall"));
}
