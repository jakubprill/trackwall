/**
 * The daemon with the real Copilot CLI (ADR-67): the pinned binary from `scripts/copilot-cli.ts`, in BYOK mode against
 * the scripted model, with its own `COPILOT_HOME` and without the developer's `COPILOT_*` variables, so no account, no
 * network and not the developer's Copilot settings take part. Everything else is the daemon as `main.ts` builds it: the session plugin's hooks, the MCP
 * stdio bridge and the session instructions.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copilotCli, PINNED_COPILOT_ENV } from "../../scripts/copilot-cli.ts";
import { sessionHooksFile } from "../../src/modules/agents/agents.ts";
import { CopilotHookRecord } from "../../src/modules/agents/copilot-hook-record.ts";
import { jsonOf } from "../../src/modules/agents/json.ts";
import { ONE_REPO, startSessionApi } from "../../test/support/session-api.ts";
import { SCRIPTED_MODEL, type ScriptedModel } from "./scripted-model.ts";

/**
 * Variables from the developer's environment that would change Copilot CLI: a GitHub sign-in instead of the scripted
 * model, and any `COPILOT_*` setting (another provider, model or home).
 */
function isCopilotSetting(name: string): boolean {
  // Upper case: environment names on Windows are case-insensitive.
  const upper = name.toUpperCase();
  return upper.startsWith("COPILOT_") || upper === "GH_TOKEN" || upper === "GITHUB_TOKEN";
}

/**
 * The environment of the sessions: offline BYOK mode, and a Copilot home that trusts the projects folder and the
 * state directory (task worktrees), so the folder trust dialog does not stop the session at its start.
 */
function byokEnv(model: ScriptedModel, dirs: { home: string; projects: string }): NodeJS.ProcessEnv {
  const copilotHome = join(dirs.home, "copilot-home");
  mkdirSync(copilotHome, { recursive: true });
  writeFileSync(join(copilotHome, "config.json"), JSON.stringify({ trustedFolders: [dirs.projects, dirs.home] }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !isCopilotSetting(name)));
  return {
    ...inherited,
    COPILOT_HOME: copilotHome,
    COPILOT_OFFLINE: "true",
    ...PINNED_COPILOT_ENV,
    COPILOT_PROVIDER_BASE_URL: model.url,
    COPILOT_MODEL: SCRIPTED_MODEL,
  };
}

const TOKEN = "c".repeat(43);

/**
 * The daemon API with the real Copilot CLI on a projects folder with the one repo `shop`, and the path of the Copilot
 * CLI binary.
 */
export async function startRealCopilotDaemon(model: ScriptedModel) {
  const copilot = await copilotCli();
  const api = await startSessionApi(TOKEN, {
    ...ONE_REPO,
    copilot: { command: [copilot], env: (dirs) => byokEnv(model, dirs) },
  });
  return { ...api, copilot };
}

/** The hook records the session plugin wrote for session `id`, in order. */
export function hookRecords(home: string, id: string): CopilotHookRecord[] {
  return readFileSync(sessionHooksFile(home, id), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => jsonOf(CopilotHookRecord).parse(line));
}
