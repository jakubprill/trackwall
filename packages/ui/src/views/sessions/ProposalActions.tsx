import type { Task, TaskProposal } from "@trackwall/protocol";
import { FolderX, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ProposalReject } from "./ProposalReject.tsx";
import { SameRepoTasks } from "./SameRepoTasks.tsx";

/**
 * Below a proposal's prompt, in the proposals panel and in a grid tile (ADR-55): the tasks already in its repo (in each repo of a change),
 * “Start task” (“Start change” for a change, ADR-171) and “Reject…”; for a proposal to remove a repo (ADR-83), “Remove
 * repo” instead.
 */
export function ProposalActions({
  proposal,
  tasks,
  pending,
  canStart,
  onStart,
  onRemoveRepo,
  onReject,
}: {
  proposal: TaskProposal;
  tasks: readonly Task[];
  pending: boolean;
  /**
   * False with an empty prompt or a model that is not an id, for a change with fewer than two repos kept, and in a grid
   * tile for a proposal without approvals or for a change.
   */
  canStart: boolean;
  onStart: () => void;
  onRemoveRepo: () => void;
  onReject: (reason: string) => void;
}) {
  return (
    <>
      {(proposal.parts?.map((part) => part.repo) ?? [proposal.repo]).map((repo) => (
        <SameRepoTasks key={repo} repo={repo} tasks={tasks} />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        {proposal.kind === "remove_repo" ? (
          <Button size="sm" variant="destructive" onClick={onRemoveRepo} disabled={pending}>
            <FolderX /> Remove repo
          </Button>
        ) : (
          <Button size="sm" onClick={onStart} disabled={pending || !canStart}>
            <GitBranch /> {proposal.kind === "change" ? "Start change" : "Start task"}
          </Button>
        )}
        <ProposalReject title={proposal.title} disabled={pending} onReject={onReject} />
      </div>
    </>
  );
}

/** The error of the last decision on a proposal, shown also while the proposal is closed. */
export function ProposalError({ error, className }: { error: string | undefined; className?: string }) {
  return error ? <p className={cn("text-destructive text-xs whitespace-pre-wrap", className)}>{error}</p> : null;
}
