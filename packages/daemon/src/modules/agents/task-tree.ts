import { proposalRepos, type Task, type TaskProposal } from "@trackwall/protocol";

/**
 * Task trees (§4.4, ADR-259): a task and the subtasks proposed from it (ADR-140), at any depth, are one piece of work, so
 * one repo gets one task of the tree. A subtask that proposes a repo where a task of its tree already works, or where its
 * tree's proposal waits, would pay twice for the same change; it is told which task has that repo instead, and the
 * daemon's impact proposals (ADR-198) skip such a repo too. The tree is read from `proposedBy` of the open tasks and
 * proposals, so nothing is stored.
 */

type TreeTask = Pick<Task, "id" | "repo" | "title" | "proposedBy">;
type TreeProposal = Pick<TaskProposal, "id" | "repo" | "parts" | "title" | "proposedBy" | "fromImpact">;

/** A task or a waiting proposal of a tree that covers a repo. */
export interface TreeWork {
  kind: "task" | "proposal";
  id: string;
  title: string | null;
  repos: string[];
  /** A proposal the daemon made from a task's impact (ADR-198), which an agent's own proposal replaces. */
  fromImpact: boolean;
}

/**
 * The tree of task `task`: the topmost task along the proposers. A proposer task that has ended still names the tree, so
 * the subtasks it left stay in one tree.
 */
export function treeOf(task: string, tasks: readonly Pick<Task, "id" | "proposedBy">[]): string {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  let top = task;
  for (;;) {
    seen.add(top);
    const proposer = byId.get(top)?.proposedBy?.task ?? null;
    if (proposer === null || seen.has(proposer)) return top;
    top = proposer;
  }
}

/** The open tasks of the tree of task `task`, then the proposals its tasks made that wait for the user. */
export function treeWork(task: string, tasks: readonly TreeTask[], proposals: readonly TreeProposal[]): TreeWork[] {
  const tree = treeOf(task, tasks);
  const inTree = (id: string | null) => id !== null && treeOf(id, tasks) === tree;
  return [
    ...tasks
      .filter((t) => inTree(t.id))
      .map((t) => ({ kind: "task" as const, id: t.id, title: t.title, repos: [t.repo], fromImpact: false })),
    ...proposals
      .filter((p) => inTree(p.proposedBy.task))
      .map((p) => ({ kind: "proposal" as const, id: p.id, title: p.title, repos: proposalRepos(p), fromImpact: p.fromImpact })),
  ];
}
