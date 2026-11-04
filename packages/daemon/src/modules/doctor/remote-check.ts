import type { DoctorCheck } from "@trackwall/protocol";

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

/** A program's error in a summary: its first line, cut. */
const MAX_MESSAGE_CHARS = 200;

const GUIDE = '"Git and SSH" in the dev container guide';

/** The kind of a failure from git's message (ssh's and curl's wording, in English as git runs them here). */
export function remoteFailure(message: string): RemoteFailure {
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No \w+ host key is known/i.test(message)) return "host-key";
  if (/Permission denied \((?:publickey|keyboard-interactive|password)/i.test(message)) return "ssh-key";
  if (
    /could not read (?:Username|Password)|terminal prompts disabled|Authentication failed|HTTP Basic: Access denied|returned error: 40[13]/i.test(
      message,
    )
  )
    return "sign-in";
  if (
    /Could not resolve host|Connection (?:refused|timed out)|Network is unreachable|No route to host|timed out|Failed to connect/i.test(
      message,
    )
  )
    return "unreachable";
  return "other";
}

/** git's message for a person: its first line that says something, without a user or token someone put in a URL. */
export function shownRemoteError(message: string): string {
  const line =
    message
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "" && !/^fatal: Could not read from remote repository\.?$/i.test(l)) ?? message.trim();
  const clean = line.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1");
  return clean.length > MAX_MESSAGE_CHARS ? `${clean.slice(0, MAX_MESSAGE_CHARS - 1)}…` : clean;
}

const REASONS: Record<RemoteFailure, string> = {
  "ssh-key": "no SSH key it accepts",
  "host-key": "its SSH host key is not known here, or changed",
  "sign-in": "no sign-in for HTTPS",
  unreachable: "the host cannot be reached",
  other: "git failed",
};

function fixFor(kind: RemoteFailure, host: string, repo: string, inContainer: boolean): string {
  const tryIt = `Run \`git ls-remote origin\` in ${repo} in a terminal to see why.`;
  if (kind === "unreachable") return `Check the network, VPN and proxy to ${host}. ${tryIt}`;
  if (!inContainer) {
    if (kind === "host-key")
      return `Run \`ssh -T git@${host}\` in a terminal once and accept the host key after comparing its fingerprint with the one ${host} publishes.`;
    return `Sign in to ${host} for git as you would in a terminal (an SSH key in ssh-agent, or a credential helper). ${tryIt}`;
  }
  if (kind === "host-key")
    return `In the container's Shell, run \`ssh -T git@${host}\` once and accept the host key after comparing its fingerprint; see ${GUIDE}.`;
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
