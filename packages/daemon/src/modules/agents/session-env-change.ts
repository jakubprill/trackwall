import { createHmac, randomBytes } from "node:crypto";
import type { EnvironmentChange, SessionEnvironment } from "@trackwall/protocol";
import type { SessionMiseEnv, SessionMiseLaunch } from "./session-env.ts";

/**
 * The environment each listed session started with, to tell later whether mise would give it another one (ADR-119).
 * Copilot CLI reads its environment once, so a new token in `mise.toml` or a name added to `agentSecrets` reaches only a
 * session started after it. The values are kept as keyed digests: the key lives only in daemon memory, so a digest tells
 * that a value changed without giving away a short secret to whoever reads it.
 */
export class SessionEnvironments {
  readonly #started = new Map<string, Snapshot>();
  /** New at each daemon start, since the snapshots live only as long as their sessions. */
  readonly #key = randomBytes(32);

  /** What session `id` starts with. */
  remember(id: string, mise: SessionMiseEnv, launch: SessionMiseLaunch): void {
    this.#started.set(id, this.#snapshot(mise, launch));
  }

  forget(id: string): void {
    this.#started.delete(id);
  }

  /** How what mise gives session `id`'s place now differs from what it started with; `null` for none or an unknown session. */
  changeSince(id: string, mise: SessionMiseEnv, launch: SessionMiseLaunch): EnvironmentChange | null {
    const started = this.#started.get(id);
    return started === undefined ? null : environmentChange(started, this.#snapshot(mise, launch));
  }

  #snapshot(mise: SessionMiseEnv, launch: SessionMiseLaunch): Snapshot {
    const { environment } = launch;
    return { environment, digests: new Map(environment.variables.map((name) => [name, this.#digest(mise.vars[name] ?? "")])) };
  }

  #digest(value: string): string {
    return createHmac("sha256", this.#key).update(value).digest("base64");
  }
}

interface Snapshot {
  environment: SessionEnvironment;
  /** A digest of each variable's value, by name. */
  digests: ReadonlyMap<string, string>;
}

function environmentChange(started: Snapshot, now: Snapshot): EnvironmentChange | null {
  const before = started.environment;
  const after = now.environment;
  // A name the tools do not get is a secret outside `agentSecrets`: one added there, or one mise no longer redacts,
  // reaches them; one taken out, or a variable mise now redacts, no longer does. `MISE_AGE_KEY` from the user's own
  // environment is not mise's, so it is not compared.
  const hiddenBefore = hiddenFromTools(before);
  const hiddenAfter = hiddenFromTools(after);
  const change: EnvironmentChange = {
    added: missingFrom(after.variables, before.variables),
    removed: missingFrom(before.variables, after.variables),
    changed: after.variables.filter((name) => {
      const startedWith = started.digests.get(name);
      return startedWith !== undefined && startedWith !== now.digests.get(name);
    }),
    shared: [
      ...missingFrom(hiddenBefore, hiddenAfter).filter((name) => after.variables.includes(name)),
      // A new secret the tools get at once, being in `agentSecrets` already.
      ...missingFrom(after.agentSecrets, before.variables),
    ],
    unshared: missingFrom(hiddenAfter, hiddenBefore).filter((name) => before.variables.includes(name)),
  };
  return Object.values(change).some((names) => names.length > 0) ? change : null;
}

function hiddenFromTools(environment: SessionEnvironment): string[] {
  return missingFrom(environment.secrets, environment.agentSecrets);
}

function missingFrom(names: readonly string[], other: readonly string[]): string[] {
  return names.filter((name) => !other.includes(name));
}
