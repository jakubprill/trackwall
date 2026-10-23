import { homedir } from "node:os";
import { join } from "node:path";
import { PITWALL_HOME_ENV } from "@pitwall/protocol";

/** Katalog stanu daemona: `~/.pitwall` albo `PITWALL_HOME` (testy, kilka instancji obok siebie). */
export function pitwallHome(override?: string): string {
  return override ?? process.env[PITWALL_HOME_ENV] ?? join(homedir(), ".pitwall");
}
