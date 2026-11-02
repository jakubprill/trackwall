import { type FollowedMergeRequest, mergeRequestNumber, type Task, type TaskMergeRequest, type TaskOutcome } from "@trackwall/protocol";
import { errorMessage } from "./api.ts";
import { canPush, mergeRequestStateLabel } from "./merge-request.ts";
import type { StatusTone } from "./repo-status.ts";

/**
 * The merge requests of a change (ADR-171, ADR-172) as one piece of work: its parts in their merge order, each with the
 * merge request the daemon follows from its branch, the change block a part's merge request description starts with,
 * the same list for a comment on the merge requests opened earlier, and the note that says what to merge first. Only
 * the parts still on the task list are known: a part that ended is no longer listed (§4.4). Trackwall writes nothing to the
 * repo host (ADR-77): the user pastes the list. No React here, so the wording is tested on its own.
 */

/** What a part of a change shows while it has no merge request, in the panel and in the Markdown list alike. */
export const NO_MERGE_REQUEST_YET = "no merge request yet";

/** One part of a change: its task, its number in the merge order counted from 1, and the merge request from its branch. */
export interface ChangePart {
  task: Task;
  number: number;
  /** `null` before one was found. */
  mergeRequest: FollowedMergeRequest | null;
}

/** The parts of the task's change in their merge order, the task among them; `null` for a task that is no part of a change. */
export function changePartsOf(task: Task, tasks: readonly Task[], outcomes: ReadonlyMap<string, TaskOutcome>): ChangePart[] | null {
  const change = task.change;
  if (!change) return null;
  return [task, ...tasks.filter((t) => t.id !== task.id)]
    .flatMap((t) => (t.change?.id === change.id ? [{ task: t, number: t.change.position + 1 }] : []))
    .sort((a, b) => a.number - b.number)
    .map((part) => ({ ...part, mergeRequest: outcomes.get(part.task.id)?.mergeRequest ?? null }));
}

/**
 * The parts as a Markdown list in their merge order, each with its number as text: a numbered list would be numbered
 * again by the repo host and lose the gap a part that ended leaves. `current` is the part whose merge request the list
 * goes into, which says "this merge request" instead of a link, since that does not exist yet.
 */
function orderList(parts: readonly ChangePart[], current: ChangePart | null): string {
  return parts
    .map((part) => {
      const what = part.task.id === current?.task.id ? "this merge request" : mergeRequestLink(part.mergeRequest);
      return `- Part ${part.number}, \`${part.task.repo}\`: ${what}`;
    })
    .join("\n");
}

/** `[group/payments!12](url) (open)`, or that the part has none yet. */
function mergeRequestLink(mergeRequest: FollowedMergeRequest | null): string {
  if (!mergeRequest) return NO_MERGE_REQUEST_YET;
  const name = `${mergeRequest.project.path}${mergeRequestNumber(mergeRequest.project, mergeRequest.number)}`;
  return `[${name}](${markdownUrl(mergeRequest.url)}) (${mergeRequestStateLabel(mergeRequest.state).label})`;
}

/** The repo host's address, with what would end a Markdown link's target encoded. */
function markdownUrl(url: string): string {
  return url.replace(/[()<> ]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The block a part's merge request description starts with, so the reviewer of each repo sees the others and the order
 * to merge them in. `null` for a task that is no part of a change.
 */
export function changeBlock(task: Task, parts: readonly ChangePart[] | null): string | null {
  const current = parts?.find((part) => part.task.id === task.id);
  if (!parts || !current) return null;
  return [
    `This merge request is part ${current.number} of a change across several repos, all on the branch \`${task.branch}\`. Merge in this order:`,
    orderList(parts, current),
  ].join("\n\n");
}

/**
 * The same list for a comment on the merge requests opened before the others existed, which "Copy links" puts on the
 * clipboard: the user pastes it, since Trackwall writes nothing to the repo host. Every part shares the task's branch.
 */
export function changeLinks(task: Task, parts: readonly ChangePart[]): string {
  return [`Part of a change across several repos, all on the branch \`${task.branch}\`. Merge in this order:`, orderList(parts, null)].join(
    "\n\n",
  );
}

/** Merged means done; a closed merge request is left to the user, who closed it. */
function merged(part: ChangePart): boolean {
  return part.mergeRequest?.state === "merged";
}

/**
 * What the order means for this part now: a warning once it was merged before an earlier part that is not, since the
 * repos may not work together until that one is; a reminder of the earlier parts while it waits. Nothing once every
 * earlier part is merged, and nothing to enforce: the user merges on the repo host (ADR-9).
 */
export function mergeOrderNote(self: ChangePart, parts: readonly ChangePart[]): { tone?: StatusTone; text: string } | null {
  const earlier = parts.filter((part) => part.number < self.number && !merged(part));
  if (earlier.length === 0) return null;
  const names = earlier.map((part) => part.task.repo).join(", ");
  if (merged(self)) return { tone: "warning", text: `Merged before ${names}, which comes earlier in the change and is not merged yet.` };
  return { text: `Merge after ${names}, which comes earlier in the change.` };
}

/** What "Push all parts" is about to do, for its confirmation. */
export function pushAllConsequence(parts: readonly ChangePart[]): string {
  const repos = parts.map((part) => part.task.repo).join(", ");
  return `Push the branch of every part that has commits to push: ${repos}. Each push is the same as the part's own Push: never forced, only to the repo host its remote is on.`;
}

/** How one part's push went in "Push all parts". */
export type PartPush = { repo: string } & ({ kind: "pushed" } | { kind: "nothing" } | { kind: "failed"; message: string });

/**
 * "Push all parts": one part after another, each through the part's own Push, so every safeguard of that push holds.
 * A part with nothing to push is skipped rather than refused, and a failed part does not stop the others. One at a
 * time, so the user's credentials helper asks at most once at a time and the summary follows the merge order.
 */
export async function pushAllParts(
  parts: readonly ChangePart[],
  api: { get: (task: string) => Promise<TaskMergeRequest>; push: (task: string) => Promise<unknown> },
): Promise<PartPush[]> {
  const pushes: PartPush[] = [];
  for (const { task } of parts) {
    try {
      const { push } = await api.get(task.id);
      if (!push || !canPush(push)) {
        pushes.push({ repo: task.repo, kind: "nothing" });
        continue;
      }
      await api.push(task.id);
      pushes.push({ repo: task.repo, kind: "pushed" });
    } catch (err) {
      pushes.push({ repo: task.repo, kind: "failed", message: errorMessage(err) });
    }
  }
  return pushes;
}

/** `Pushed orders-api, payments · nothing to push in shop-web · shop-web: …`, after "Push all parts". */
export function pushAllSummary(pushes: readonly PartPush[]): { tone?: StatusTone; text: string } {
  const of = (kind: PartPush["kind"]) => pushes.filter((p) => p.kind === kind).map((p) => p.repo);
  const pushed = of("pushed");
  const nothing = of("nothing");
  const failed = pushes.flatMap((p) => (p.kind === "failed" ? [`${p.repo}: ${p.message}`] : []));
  const lines = [
    ...(pushed.length > 0 ? [`Pushed ${pushed.join(", ")}`] : []),
    ...(nothing.length > 0 ? [`nothing to push in ${nothing.join(", ")}`] : []),
    ...failed,
  ];
  return { tone: failed.length > 0 ? "error" : "ok", text: lines.join(" · ") };
}
