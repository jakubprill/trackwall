import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COPILOT_HOOK_EVENTS, type CopilotHookEvent } from "./copilot-hooks.ts";

/**
 * Wtyczka sesji (§4.4, ADR-16): katalog podawany Copilot CLI przez `--plugin-dir`, który rejestruje hooki
 * zgłaszające stan. Działa tylko w tej jednej sesji, więc nie zmienia konfiguracji użytkownika
 * (`~/.copilot`) ani plików w repo (`.github/hooks`).
 */

const COPILOT_PLUGIN_NAME = "trackwall-session";

/** Program uruchamiany bez powłoki (`exec` + `args`), więc ścieżki ze spacjami nie wymagają cytowania. */
export interface HookCommand {
  exec: string;
  args: string[];
}

/** Hook stanu ma odpowiedzieć od razu; dłuższe czekanie tylko spowalnia agenta. */
const HOOK_TIMEOUT_SEC = 5;

export function writeCopilotPlugin(dir: string, command: (event: CopilotHookEvent) => HookCommand): void {
  mkdirSync(dir, { recursive: true });
  const manifest = { name: COPILOT_PLUGIN_NAME, version: "0.0.0", description: "Trackwall: stan sesji zadania" };
  const hooks = Object.fromEntries(
    COPILOT_HOOK_EVENTS.map((event) => [event, [{ type: "command", ...command(event), timeoutSec: HOOK_TIMEOUT_SEC }]]),
  );
  writeFileSync(join(dir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, "hooks.json"), `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`);
}
