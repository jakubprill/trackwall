import type { DoctorCheck } from "@trackwall/protocol";
import { firstLine } from "./first-line.ts";

/**
 * The doctor's check that git reaches the repo hosts (ADR-195). Trackwall carries no git credentials into a container:
 * started without VS Code, a container has none of the computer's SSH keys or sign-ins, and a sync or a push fails there
 * while a terminal of VS Code works. The check names the host, the kind of failure and what to do about it.
 */

type Outcome = Omit<DoctorCheck, "id">;

/** One repo host as `workspace.remoteReach` read it. */
export interface RemoteReachRead {
  host: string;
  repo: string;
  error: string | null;
}

/** Why git could not reach a remote, as far as git's message tells; `other` shows git's message alone. */
export type RemoteFailure = "ssh-key" | "host-key" | "sign-in" | "unreachable" | "other";

const GUIDE = '"Git and SSH" in the dev container guide';

const HOST_KEY = /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No \w+ host key is known/i;
const SSH_KEY = /Permission denied \((?:publickey|keyboard-interactive|password)/i;
const SIGN_IN =
  /could not read (?:Username|Password)|terminal prompts disabled|Authentication failed|HTTP Basic: Access denied|returned error: 40[13]/i;
/** `did not finish within`: Trackwall's own time limit, a host that never answers. */
const UNREACHABLE =
  /Could not resolve host|Connection refused|Network is unreachable|No route to host|timed out|Failed to connect|did not finish within/i;

/** The kind of a failure from git's message (ssh's and curl's wording, in English as git runs them here). */
export function remoteFailure(message: string): RemoteFailure {
  if (HOST_KEY.test(message)) return "host-key";
  if (SSH_KEY.test(message)) return "ssh-key";
  if (SIGN_IN.test(message)) return "sign-in";
  if (UNREACHABLE.test(message)) return "unreachable";
  return "other";
}

/** Lines of git's or ssh's message that say nothing about the cause. */
const NOISE = /^(?:fatal: Could not read from remote repository\.?|warning:.*|Please make sure you have the correct access rights)/i;

/**
 * git's message for a person: its first line that says something, without a user or token someone put in a URL (up to
 * the last `@` before the path, since a password may hold one).
 */
export function shownRemoteError(message: string): string {
  const clean = message.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/gi, "$1");
  return firstLine(clean, (line) => !NOISE.test(line));
}

const REASONS: Record<RemoteFailure, string> = {
  "ssh-key": "no SSH key it accepts",
  "host-key": "its SSH host key is not known here, or changed",
  "sign-in": "no sign-in for HTTPS",
  unreachable: "the host cannot be reached",
  other: "git failed",
};

function fixFor(kind: RemoteFailure, host: string, repo: string, inContainer: boolean): string {
  const tryIt = `Run \`git ls-remote\` with the repo's remote in ${repo} in a terminal to see why.`;
  if (kind === "unreachable") return `Check the network, VPN and proxy to ${host}. ${tryIt}`;
  if (!inContainer) {
    if (kind === "host-key")
      return `Connect to ${host} once with ssh in a terminal (such as \`ssh -T git@${host}\`, with the user and port of the repo's address) and accept the host key after comparing its fingerprint with the one ${host} publishes.`;
    return `Sign in to ${host} for git as you would in a terminal (an SSH key in ssh-agent, or a credential helper). ${tryIt}`;
  }
  if (kind === "host-key")
    return `In the container's Shell, connect to ${host} once with ssh (such as \`ssh -T git@${host}\`) and accept the host key after comparing its fingerprint; see ${GUIDE}.`;
  return `Trackwall in the container has none of your computer's keys or sign-ins, also while VS Code is open: give it its own, as ${GUIDE} shows. ${tryIt}`;
}

export function remoteOutcome(reads: readonly RemoteReachRead[], inContainer: boolean): Outcome | null {
  if (reads.length === 0) return null;
  const failed = reads.filter((r): r is RemoteReachRead & { error: string } => r.error !== null);
  const reached = reads.filter((r) => r.error === null).map((r) => r.host);
  const first = failed[0];
  if (first === undefined) return { status: "ok", summary: `git reaches ${reached.join(", ")}.`, fix: null };
  const kind = remoteFailure(first.error);
  const others =
    failed.length > 1
      ? ` Also failing: ${failed
          .slice(1)
          .map((f) => f.host)
          .join(", ")}.`
      : "";
  const fine = reached.length > 0 ? ` git reaches ${reached.join(", ")}.` : "";
  return {
    status: "fail",
    summary: `git cannot reach ${first.host} (from ${first.repo}): ${REASONS[kind]} (${shownRemoteError(first.error)}).${others}${fine}`,
    fix: fixFor(kind, first.host, first.repo, inContainer),
  };
}
