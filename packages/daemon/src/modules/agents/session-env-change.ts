import { createHmac, randomBytes } from "node:crypto";
import type { EnvironmentChange, SessionEnvironment } from "@trackwall/protocol";
import type { SessionMiseEnv, SessionMiseLaunch } from "./session-env.ts";

/**
 * What the daemon keeps of the environment a session started with, to tell later whether mise would give it another
 * one (ADR-119). Copilot CLI reads its environment once, so a new token in `mise.toml` or a name added to `agentSecrets`
 * reaches only a session started after it. The values are kept as keyed digests: the key lives only in daemon memory,
 * so a digest tells that a value changed without giving away a short secret to whoever reads it.
 */
export interface EnvironmentSnapshot {
  environment: SessionEnvironment;
  /** A digest of each variable's value, by name. */
  digests: ReadonlyMap<string, string>;
}

/** The key of a daemon's digests; a new one at each start, since snapshots live only as long as their sessions. */
export function newDigestKey(): Buffer {
  return randomBytes(32);
}

export function environmentSnapshot(mise: SessionMiseEnv, launch: SessionMiseLaunch, key: Buffer): EnvironmentSnapshot {
  const { environment } = launch;
  const digests = new Map(environment.variables.map((name) => [name, digest(mise.vars[name] ?? "", key)]));
  return { environment, digests };
}

/** How `now` differs from `started`; `null` when a restart would give the session the same environment. */
export function environmentChange(started: EnvironmentSnapshot, now: EnvironmentSnapshot): EnvironmentChange | null {
  const before = started.environment;
  const after = now.environment;
  const change: EnvironmentChange = {
    added: missingFrom(after.variables, before.variables),
    removed: missingFrom(before.variables, after.variables),
    changed: after.variables.filter((name) => {
      const startedWith = started.digests.get(name);
      return startedWith !== undefined && startedWith !== now.digests.get(name);
    }),
    shared: missingFrom(after.agentSecrets, before.agentSecrets),
    unshared: missingFrom(before.agentSecrets, after.agentSecrets).filter((name) => after.variables.includes(name)),
  };
  return Object.values(change).some((names) => names.length > 0) ? change : null;
}

function digest(value: string, key: Buffer): string {
  return createHmac("sha256", key).update(value).digest("base64");
}

function missingFrom(names: readonly string[], other: readonly string[]): string[] {
  return names.filter((name) => !other.includes(name));
}
