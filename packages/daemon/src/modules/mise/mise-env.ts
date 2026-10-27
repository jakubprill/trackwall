import { z } from "zod";
import { isSecretName } from "../../infra/secret-name.ts";
import { type MiseCliResult, miseFailure, runMiseCli } from "./mise-cli.ts";

/**
 * The environment mise sets in a directory (ADR-93): the `[env]` of every mise config from the directory up to the root
 * and the global one, with age-encrypted values decrypted, as `mise env --json` gives it, so a session gets what the
 * user's terminal gets there. The secrets are the variables mise redacts (`mise env --redacted --json`: `redact = true`,
 * `redactions` and every age value) and those whose names say they are secrets (`isSecretName`).
 */

/** What mise sets: variable values by name, and the names among them that are secrets. */
export interface MiseEnv {
  vars: Record<string, string>;
  secretNames: string[];
}

export type MiseEnvResult =
  | { kind: "ok"; env: MiseEnv }
  /** There is no `mise` program: nothing to add, and nothing to tell a user who does not use mise. */
  | { kind: "not_installed" }
  /** mise did not give the environment (an untrusted config, a missing age key, a timeout); the message is mise's. */
  | { kind: "error"; message: string };

const EnvJson = z.record(z.string(), z.string());

export async function readMiseEnv(command: readonly string[], dir: string, env: NodeJS.ProcessEnv): Promise<MiseEnvResult> {
  const [all, redacted] = await Promise.all([
    runMiseCli(command, ["env", "--json"], dir, env),
    runMiseCli(command, ["env", "--redacted", "--json"], dir, env),
  ]);
  const vars = parseEnvJson(all);
  if (vars.kind !== "ok") return vars;
  // A mise older than `--redacted` still gives the environment; its secrets are then only the ones named like secrets.
  const hidden = parseEnvJson(redacted);
  const redactedNames = hidden.kind === "ok" ? hidden.vars : {};
  const secretNames = Object.keys(vars.vars).filter((name) => Object.hasOwn(redactedNames, name) || isSecretName(name));
  return { kind: "ok", env: { vars: vars.vars, secretNames } };
}

function parseEnvJson(result: MiseCliResult): { kind: "ok"; vars: Record<string, string> } | Exclude<MiseEnvResult, { kind: "ok" }> {
  if (result.kind === "not_started") return { kind: "not_installed" };
  if (result.kind === "failed") return { kind: "error", message: result.message };
  if (result.code !== 0) return { kind: "error", message: miseFailure(result.stderr, result.code) };
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    return { kind: "error", message: "mise env --json returned something that is not JSON" };
  }
  const parsed = EnvJson.safeParse(json);
  if (!parsed.success) return { kind: "error", message: `unexpected mise env --json format: ${z.prettifyError(parsed.error)}` };
  return { kind: "ok", vars: parsed.data };
}
