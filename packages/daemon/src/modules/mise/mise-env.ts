import { z } from "zod";
import { isSecretName } from "../../infra/secret-name.ts";
import { type MiseCliResult, miseFailure, runMiseCli } from "./mise-cli.ts";

/**
 * The environment mise sets in a directory (ADR-93): the `[env]` of every mise config from the directory up to the root
 * and the global one, with age-encrypted values decrypted, as `mise env --json` gives it, so a session gets what the
 * user's terminal gets there. The secrets are the variables mise redacts (`mise env --redacted --json`: `redact = true`,
 * `redactions` and every age value) and those whose names say they are secrets (`isSecretName`). When mise cannot say
 * which ones it redacts, the result is `unredacted`: a session refuses it, since a decrypted value with an ordinary name
 * would otherwise reach the agent's tools unhidden, and a run masks at least the secret-like names.
 */

/** What mise sets: variable values by name, the names among them that are secrets, and those secrets' values (to mask). */
export interface MiseEnv {
  vars: Record<string, string>;
  secretNames: string[];
  secretValues: string[];
}

/** The environment of a place where mise sets nothing. */
export const NO_MISE_ENV: MiseEnv = { vars: {}, secretNames: [], secretValues: [] };

export type MiseEnvResult =
  | { kind: "ok"; env: MiseEnv }
  /** There is no `mise` program: nothing to add, and nothing to tell a user who does not use mise. */
  | { kind: "not_installed" }
  /** mise did not give the environment (an untrusted config, a missing age key, a timeout); the message is mise's. */
  | { kind: "error"; message: string }
  /** mise gave the environment but not its redactions; the secrets are only the ones named like secrets. */
  | { kind: "unredacted"; message: string; env: MiseEnv };

const EnvJson = z.record(z.string(), z.string());

export async function readMiseEnv(command: readonly string[], dir: string, env: NodeJS.ProcessEnv): Promise<MiseEnvResult> {
  const [all, redacted] = await Promise.all([
    runMiseCli(command, ["env", "--json"], dir, env),
    runMiseCli(command, ["env", "--redacted", "--json"], dir, env),
  ]);
  const vars = parseEnvJson(all);
  if (vars.kind !== "ok") return vars;
  const hidden = parseEnvJson(redacted);
  const redactedNames = hidden.kind === "ok" ? hidden.vars : {};
  const secretNames = Object.keys(vars.vars).filter((name) => Object.hasOwn(redactedNames, name) || isSecretName(name));
  const found = { vars: vars.vars, secretNames, secretValues: secretNames.map((name) => vars.vars[name] ?? "") };
  if (hidden.kind === "ok") return { kind: "ok", env: found };
  return { kind: "unredacted", message: hidden.kind === "error" ? hidden.message : "mise did not start", env: found };
}

function parseEnvJson(
  result: MiseCliResult,
): { kind: "ok"; vars: Record<string, string> } | { kind: "not_installed" } | { kind: "error"; message: string } {
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
