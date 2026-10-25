/**
 * The daemon with the real Copilot CLI (ADR-67): the pinned binary from `scripts/copilot-cli.ts`, in BYOK mode against
 * the scripted model, with its own `COPILOT_HOME`, so no account, no network and nothing from the developer's Copilot
 * configuration takes part. Everything else is the daemon as `main.ts` builds it: the session plugin's hooks, the MCP
 * stdio bridge and the session instructions.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copilotCli } from "../../scripts/copilot-cli.ts";
import { CopilotHookRecord } from "../../src/modules/agents/copilot-hook-record.ts";
import { startSessionApi } from "../../test/support/session-api.ts";
import { SCRIPTED_MODEL, type ScriptedModel } from "./scripted-model.ts";

/** Variables that would let Copilot CLI sign in to GitHub instead of using the scripted model. */
const GITHUB_TOKENS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];

/**
 * The environment of the sessions: offline BYOK mode, and a Copilot home that trusts the projects folder and the
 * state directory (task worktrees), so the folder trust dialog does not stop the session at its start.
 */
function byokEnv(model: ScriptedModel, dirs: { home: string; projects: string }): NodeJS.ProcessEnv {
  const copilotHome = join(dirs.home, "copilot-home");
  mkdirSync(copilotHome, { recursive: true });
  writeFileSync(join(copilotHome, "config.json"), JSON.stringify({ trustedFolders: [dirs.projects, dirs.home] }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COPILOT_HOME: copilotHome,
    COPILOT_OFFLINE: "true",
    COPILOT_AUTO_UPDATE: "false",
    COPILOT_PROVIDER_BASE_URL: model.url,
    COPILOT_MODEL: SCRIPTED_MODEL,
  };
  for (const name of GITHUB_TOKENS) delete env[name];
  return env;
}

const TOKEN = "c".repeat(43);

/** The daemon API with the real Copilot CLI on a projects folder with the one repo `shop`. */
export async function startRealCopilotDaemon(model: ScriptedModel) {
  const command = [await copilotCli()];
  return startSessionApi(TOKEN, {
    repos: { shop: { "README.md": "# shop\n" } },
    miseCommand: ["mise"],
    copilot: { command, env: (dirs) => byokEnv(model, dirs) },
  });
}

/** The hook records the session plugin wrote for session `id`, in order. */
export function hookRecords(home: string, id: string): CopilotHookRecord[] {
  return readFileSync(join(home, "sessions", id, "hooks.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => CopilotHookRecord.parse(JSON.parse(line)));
}
