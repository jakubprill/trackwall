import { type Session, TASK_PROMPT_MAX, type Task, type TaskApprovals, type TaskProposal } from "@trackwall/protocol";
import { ChevronDown, ChevronRight, GitBranch, Lightbulb } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { type ProposalStart, typedModel } from "@/lib/proposal-decisions";
import {
  type ProposalsEntry,
  proposalKindLabel,
  proposalName,
  proposalsName,
  proposerLabel,
  type SessionSelection,
} from "@/lib/session-entries";
import { toggle } from "@/lib/set-toggle";
import { useProposalDecisions } from "@/lib/use-proposal-decisions";
import { cn } from "@/lib/utils";
import { ProposalActions, ProposalError } from "./ProposalActions.tsx";
import { ProposalModel } from "./ProposalModel.tsx";
import { RepoRemovalNote } from "./RepoRemovalNote.tsx";
import { TaskApprovalsChoice } from "./TaskApprovalsChoice.tsx";

/**
 * The task proposals of one main session or of agents outside Trackwall (ADR-39, ADR-55), reviewed together as the plan
 * they are: each with its repo, title, prompt, model (ADR-98) and approvals mode (ADR-105), which the user opens to read and may edit before the start. The user
 * starts one, or ticks several and starts them together; a proposal can be ticked only once it has been opened, so a
 * prompt from an agent is never started unread. “Reject…” takes an optional reason for the session that proposed it.
 * Until then nothing runs. `focus` is the proposal to open (from the list, the tray, a link or the last decision).
 */
export function ProposalInbox({
  conn,
  group,
  focus,
  sessions,
  tasks,
  onChanged,
  onSelect,
  currentSelection,
}: {
  conn: Connection;
  group: ProposalsEntry;
  focus: string | undefined;
  sessions: readonly Session[];
  tasks: readonly Task[];
  onChanged: () => void;
  onSelect: (selection: SessionSelection) => void;
  currentSelection: () => SessionSelection;
}) {
  const { proposals } = group;
  const decisions = useProposalDecisions({ conn, group, onChanged, onSelect, currentSelection });
  const [prompts, setPrompts] = useState<ReadonlyMap<string, string>>(new Map());
  const [models, setModels] = useState<ReadonlyMap<string, string>>(new Map());
  const [approvals, setApprovals] = useState<ReadonlyMap<string, TaskApprovals>>(new Map());
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  // `null` once the user closed it; an id that is no longer waiting falls back to the first proposal.
  const [open, setOpen] = useState<string | null>(focus ?? proposals[0].id);
  // Proposals that have been open. A ticked one has been too; it counts by itself as well, so that a box can never be
  // checked and locked at once, whatever the order of the effect below.
  const [read, setRead] = useState<ReadonlySet<string>>(new Set());
  const shown = open !== null && !proposals.some((p) => p.id === open) ? proposals[0].id : open;
  const wasRead = (id: string) => id === shown || read.has(id) || ticked.has(id);
  useEffect(() => {
    if (shown !== null) setRead((r) => (r.has(shown) ? r : new Set(r).add(shown)));
  }, [shown]);
  useEffect(() => {
    if (focus) setOpen(focus);
  }, [focus]);
  const promptOf = (p: TaskProposal) => prompts.get(p.id) ?? p.prompt;
  const modelTextOf = (p: TaskProposal) => models.get(p.id) ?? p.model ?? "";
  const approvalsOf = (p: TaskProposal) => approvals.get(p.id) ?? p.approvals;
  /** The start as the user left the proposal, or `undefined` while its prompt is empty or its model not an id. */
  const startOf = (p: TaskProposal): ProposalStart | undefined => {
    const model = typedModel(modelTextOf(p));
    return promptOf(p).trim() === "" || model === undefined
      ? undefined
      : { id: p.id, prompt: promptOf(p), model, approvals: approvalsOf(p) };
  };
  const toStart = proposals.filter((p) => ticked.has(p.id));
  // Ticking and "Start selected" are for tasks; a folder action has its own button (ADR-83).
  const several = proposals.filter((p) => p.kind === "task").length > 1;

  return (
    <div className="flex max-w-3xl flex-col gap-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="hud-label flex items-center gap-2">
            <Lightbulb className="size-3.5" aria-hidden />{" "}
            {proposals.length > 1 ? proposalsName(proposals) : proposalKindLabel(proposals[0])}
          </h3>
          <p className="text-muted-foreground text-xs">
            {proposerLabel(proposals[0].proposedBy, sessions)} · {relativeTime(proposals[0].createdAt, new Date())}
          </p>
        </div>
        {several && (
          <Button
            onClick={() => decisions.start(toStart.flatMap((p) => startOf(p) ?? []))}
            disabled={decisions.pending || toStart.length === 0 || toStart.some((p) => startOf(p) === undefined)}
          >
            <GitBranch /> {toStart.length === 0 ? "Start selected" : `Start ${toStart.length} selected`}
          </Button>
        )}
      </div>
      {proposals.some((p) => p.kind === "task") && (
        <p className="text-muted-foreground max-w-prose text-sm">
          Nothing runs until you start a task. Trackwall then creates a new branch from the default branch of its repo in a separate
          worktree and starts Copilot CLI there with the prompt. The prompts come from an agent, so read them before you start; you can edit
          them
          {several ? ", and tick a proposal once you have opened it" : ""}.
        </p>
      )}
      <ul aria-label="Task proposals" className="flex flex-col gap-2">
        {proposals.map((p) => {
          const expanded = shown === p.id;
          return (
            <li key={p.id} className={cn("bg-card rounded-md border", expanded && "border-primary/40")}>
              <div className="flex items-start gap-3 px-3 py-2">
                {several && p.kind === "task" && (
                  <input
                    type="checkbox"
                    className="accent-primary mt-1 size-4 shrink-0"
                    aria-label={wasRead(p.id) ? `Select “${p.title}”` : `Open “${p.title}” to read it before you select it`}
                    title={wasRead(p.id) ? undefined : "Open the proposal to read its prompt first"}
                    disabled={!wasRead(p.id) || decisions.pending}
                    checked={ticked.has(p.id)}
                    onChange={() => setTicked(toggle(ticked, p.id))}
                  />
                )}
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-start gap-2 text-left"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : p.id)}
                >
                  {expanded ? (
                    <ChevronDown className="mt-0.5 size-4 shrink-0" aria-hidden />
                  ) : (
                    <ChevronRight className="mt-0.5 size-4 shrink-0" aria-hidden />
                  )}
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium">{proposalName(p)}</span>
                    {!expanded && <span className="text-muted-foreground truncate text-xs">{promptOf(p)}</span>}
                  </span>
                </button>
              </div>
              {expanded && (
                <div className="flex flex-col gap-3 px-3 pb-3">
                  {p.kind === "remove_repo" ? (
                    <RepoRemovalNote proposal={p} />
                  ) : (
                    <>
                      <Textarea
                        aria-label={`Prompt for the agent: ${p.title}`}
                        value={promptOf(p)}
                        onChange={(e) => setPrompts(new Map(prompts).set(p.id, e.target.value))}
                        maxLength={TASK_PROMPT_MAX}
                        rows={8}
                      />
                      <ProposalModel
                        title={p.title}
                        value={modelTextOf(p)}
                        onChange={(value) => setModels(new Map(models).set(p.id, value))}
                      />
                      <TaskApprovalsChoice
                        label={`Run without asking for approvals: ${p.title}`}
                        value={approvalsOf(p)}
                        onChange={(value) => setApprovals(new Map(approvals).set(p.id, value))}
                      />
                    </>
                  )}
                  <ProposalActions
                    proposal={p}
                    tasks={tasks}
                    pending={decisions.pending}
                    canStart={startOf(p) !== undefined}
                    onStart={() => {
                      const start = startOf(p);
                      if (start) decisions.start([start]);
                    }}
                    onRemoveRepo={() => decisions.removeRepo(p.id)}
                    onReject={(reason) => decisions.reject(p.id, reason)}
                  />
                </div>
              )}
              <ProposalError error={decisions.errors.get(p.id)} className="px-3 pb-3" />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
