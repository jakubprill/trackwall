import {
  countLabel,
  type PullBranchOutcome,
  type PullResult,
  type RepoStatusOk,
  type RunningMiseTask,
  type SessionList,
  type StatusLabel,
  type SyncBranchOutcome,
  trackedChanges,
} from "@trackwall/protocol";
import { sessionTitle } from "./session-state.ts";

/**
 * The pull in the repo header's Upstream tile (ADR-268): when it is offered, why not, what the result says, and what
 * works in the repo folder itself and would see its files change. The daemon applies the same rules again after its
 * fetch, which can find more commits or a diverged branch; this is only what the tile shows before the click.
 */

/** What the Upstream tile offers: a pull, a reason with the way out, or nothing (no upstream, nothing to pull). */
export type UpstreamOffer =
  | { kind: "none" }
  | { kind: "pull"; behind: number }
  | { kind: "blocked"; message: string; way: "changes" | "shell" };

export function upstreamOffer(status: RepoStatusOk): UpstreamOffer {
  const { upstream, branch } = status;
  if (branch === null || upstream === null || upstream.behind === 0) return { kind: "none" };
  if (upstream.ahead > 0)
    return {
      kind: "blocked",
      message: `${branch} and ${upstream.name} have diverged (${upstream.ahead} local, ${upstream.behind} remote). Merge or rebase by hand.`,
      way: "shell",
    };
  const changed = trackedChanges(status);
  if (changed > 0)
    return {
      kind: "blocked",
      message: `${countLabel(changed, { one: "changed file", other: "changed files" })} on ${branch}. Commit or stash ${changed === 1 ? "it" : "them"} first.`,
      way: "changes",
    };
  return { kind: "pull", behind: upstream.behind };
}

/** The button's text: "Pull 320". */
export function pullLabel(behind: number): string {
  return `Pull ${behind}`;
}

/**
 * One line for the result: the checked-out branch first, since the tile is about it, then the default branch when the
 * pull also synced it. A skip of either is a warning: the user expected the number to go away.
 */
export function pullResultLine(result: PullResult): StatusLabel {
  const own = result.checkedOut ?? result.defaultBranch;
  const parts = [branchPart(own)];
  if (result.checkedOut !== null) {
    const other = defaultPart(result.defaultBranch);
    if (other) parts.push(other);
  }
  const skipped = own.state === "skipped" || (result.checkedOut !== null && result.defaultBranch.state === "skipped");
  return { tone: skipped ? "warning" : "ok", label: parts.join(" · ") };
}

function branchPart(outcome: PullBranchOutcome): string {
  if (outcome.state === "updated")
    return `Pulled ${countLabel(outcome.commits, { one: "commit", other: "commits" })} into ${outcome.branch}`;
  if (outcome.state === "up-to-date") return `${outcome.branch} is up to date with ${outcome.remoteBranch}`;
  return capitalize(outcome.message);
}

/** The default branch next to the checked-out one: its gain, or why it stayed; nothing when it was already up to date. */
function defaultPart(outcome: SyncBranchOutcome): string | undefined {
  if (outcome.state === "updated") return `${outcome.branch} +${outcome.commits}`;
  if (outcome.state === "up-to-date") return undefined;
  return `default branch not synced: ${outcome.message}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * What works in the repo folder itself and would see its files change under it: a session in the repo root that has not
 * ended and a mise task or service of the repo root that runs. A task works in its own worktree, which a pull does not touch.
 */
export function workInRepoFolder(repo: string, list: SessionList | undefined, running: readonly RunningMiseTask[]): string[] {
  const sessions = (list?.sessions ?? []).filter((s) => s.repo === repo && s.task === null && s.run.kind !== "exited");
  const miseTasks = running.filter((t) => t.repo === repo && t.task === null && t.run.kind !== "exited");
  return [...miseTasks.map((t) => `the mise task ${t.miseTask}`), ...sessions.map((s) => `the session "${sessionTitle(s)}"`)];
}

/** The question before a pull when something works in the folder: "The mise task dev and the session "Fix" work in this folder; …". */
export function folderWorkWarning(work: readonly string[]): string {
  const names = work.length <= 1 ? (work[0] ?? "") : `${work.slice(0, -1).join(", ")} and ${work.at(-1)}`;
  return `${capitalize(names)} ${work.length === 1 ? "works" : "work"} in this folder, and pulling changes files under ${work.length === 1 ? "it" : "them"}.`;
}
