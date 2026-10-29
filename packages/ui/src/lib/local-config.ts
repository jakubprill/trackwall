import type { LocalConfigFileState, LocalConfigStore, RepoLocalConfig } from "@trackwall/protocol";
import { relativeTime } from "./format.ts";
import type { StatusTone } from "./repo-status.ts";

/**
 * The local config store in the UI (ADR-86): what each local config file of a repo says against the store, which actions
 * a repo offers, and one line for the store in the settings. Pure functions, tested in `test/local-config.test.ts`.
 */

/** A file git does not ignore can be committed by anyone working in the repo, an agent included: a warning, not an error. */
export function localConfigFileStatus(state: LocalConfigFileState): { tone?: StatusTone; label: string } {
  switch (state.kind) {
    case "absent":
      return { label: "not in this repo" };
    case "tracked":
      return { label: "in the repo's commits, not backed up" };
    case "missing":
      return { tone: "warning", label: "only in the store" };
    case "backed_up":
      return state.ignored ? { tone: "ok", label: "backed up" } : { tone: "warning", label: "backed up, git does not ignore it" };
    case "pending":
      return state.ignored ? { label: "backing up…" } : { tone: "warning", label: "backing up…, git does not ignore it" };
  }
}

/** Restore: the store has a file the repo lacks, for example in a new clone. */
export function canRestore(config: RepoLocalConfig): boolean {
  return config.files.some((f) => f.kind === "missing");
}

/** Ignore locally: the repo has a local config file that git neither tracks nor ignores. */
export function canIgnore(config: RepoLocalConfig): boolean {
  return config.files.some((f) => (f.kind === "backed_up" || f.kind === "pending") && !f.ignored);
}

/** Whether the repo has anything to show: a repo with no local config file anywhere gets one short line. */
export function hasLocalConfig(config: RepoLocalConfig): boolean {
  return config.files.some((f) => f.kind !== "absent");
}

/** The last backup, and the push to the address the user allowed (ADR-127), in one line each. */
export function localConfigStoreLines(store: LocalConfigStore, now: Date): { backup: string; push: { tone?: StatusTone; text: string } } {
  const backup = store.lastBackup
    ? `Last backup ${relativeTime(store.lastBackup.date, now)}: ${store.lastBackup.subject}`
    : "Nothing backed up yet.";
  if (store.pushesTo === null) {
    if (store.remote === null) return { backup, push: { text: "No remote: the backups stay on this computer." } };
    return { backup, push: { tone: "warning", text: "Not pushed: the backups stay on this computer until you allow the store's remote." } };
  }
  switch (store.push.kind) {
    case "none":
      return { backup, push: { text: `Pushes to ${store.pushesTo} after the next backup.` } };
    case "ok":
      return { backup, push: { tone: "ok", text: `Pushed to ${store.pushesTo} ${relativeTime(store.push.at, now)}.` } };
    case "failed":
      return { backup, push: { tone: "error", text: `Push to ${store.pushesTo} failed: ${store.push.message}` } };
  }
}

/**
 * The store's remote when it is not the address the store is pushed to (ADR-127): the user added it, or an agent did, so
 * the user decides. `problem` says why it cannot be allowed; `null` when it is the allowed one or there is none.
 */
export function remoteToAllow(store: LocalConfigStore): { remote: string; problem: string | null } | null {
  if (store.remote === null || store.remoteAllowed) return null;
  return { remote: store.remote, problem: store.remoteProblem };
}
