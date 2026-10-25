import { type Session, TASK_PROMPT_MAX, type Task, type TaskProposal } from "@trackwall/protocol";
import { ChevronDown, ChevronRight, GitBranch, Lightbulb } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { proposerLabel, type SessionSelection } from "@/lib/session-entries";
import { useProposalDecisions } from "@/lib/use-proposal-decisions";
import { cn } from "@/lib/utils";
import { ProposalReject } from "./ProposalReject.tsx";
import { SameRepoTasks } from "./SameRepoTasks.tsx";

/**
 * The task proposals of one main session or of agents outside Trackwall (ADR-39, ADR-55), reviewed together as the plan
 * they are: each with its title, repo and prompt, which the user can edit before the start. The user starts the ones
 * they tick, or one at a time, and rejects with an optional reason for the session that proposed them. Until then
 * nothing runs. `focus` is the proposal to open first (from the list, the tray or a link).
 */
export function ProposalInbox({
  conn,
  proposer,
  proposals,
  focus,
  sessions,
  tasks,
  onChanged,
  onDecided,
}: {
  conn: Connection;
  proposer: string | null;
  proposals: readonly TaskProposal[];
  focus: string | undefined;
  sessions: readonly Session[];
  tasks: readonly Task[];
  onChanged: () => void;
  onDecided: (selection: SessionSelection) => void;
}) {
  const decisions = useProposalDecisions({ conn, proposer, proposals, onChanged, onDecided });
  const [prompts, setPrompts] = useState<ReadonlyMap<string, string>>(new Map());
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState(focus ?? proposals[0]?.id);
  useEffect(() => {
    if (focus) setOpen(focus);
  }, [focus]);
  const promptOf = (p: TaskProposal) => prompts.get(p.id) ?? p.prompt;
  const toStart = proposals.filter((p) => ticked.has(p.id));
  const [first] = proposals;
  if (!first) return null;

  return (
    <div className="flex max-w-3xl flex-col gap-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="hud-label flex items-center gap-2">
            <Lightbulb className="size-3.5" aria-hidden /> {proposals.length === 1 ? "Task proposal" : `${proposals.length} task proposals`}
          </h3>
          <p className="text-muted-foreground text-xs">
            {proposerLabel(first.proposedBy, sessions)} · {relativeTime(first.createdAt, new Date())}
          </p>
        </div>
        {proposals.length > 1 && (
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => decisions.start(toStart.map((p) => ({ id: p.id, prompt: promptOf(p) })))}
              disabled={decisions.pending || toStart.length === 0 || toStart.some((p) => promptOf(p).trim() === "")}
            >
              <GitBranch /> {toStart.length === 0 ? "Start selected" : `Start ${toStart.length} selected`}
            </Button>
            <Button variant="outline" onClick={() => setTicked(new Set(proposals.map((p) => p.id)))} disabled={decisions.pending}>
              Select all
            </Button>
          </div>
        )}
      </div>
      <p className="text-muted-foreground max-w-prose text-sm">
        Nothing runs until you start a task. Trackwall then creates a new branch from the default branch of its repo in a separate worktree
        and starts Copilot CLI there with the prompt. The prompts come from an agent, so read them before you start; you can edit them.
      </p>
      <ul aria-label="Task proposals" className="flex flex-col gap-2">
        {proposals.map((p) => {
          const expanded = open === p.id;
          const error = decisions.errors.get(p.id);
          return (
            <li key={p.id} className={cn("bg-card rounded-md border", expanded && "border-primary/40")}>
              <div className="flex items-start gap-3 px-3 py-2">
                {proposals.length > 1 && (
                  <input
                    type="checkbox"
                    className="accent-primary mt-1 size-4 shrink-0"
                    aria-label={`Select “${p.title}”`}
                    checked={ticked.has(p.id)}
                    onChange={(e) => setTicked(toggled(ticked, p.id, e.target.checked))}
                  />
                )}
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-start gap-2 text-left"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? undefined : p.id)}
                >
                  {expanded ? (
                    <ChevronDown className="mt-0.5 size-4 shrink-0" aria-hidden />
                  ) : (
                    <ChevronRight className="mt-0.5 size-4 shrink-0" aria-hidden />
                  )}
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium">
                      {p.repo} · {p.title}
                    </span>
                    {!expanded && <span className="text-muted-foreground truncate text-xs">{promptOf(p)}</span>}
                  </span>
                </button>
              </div>
              {expanded && (
                <div className="flex flex-col gap-3 px-3 pb-3">
                  <Textarea
                    aria-label={`Prompt for the agent: ${p.title}`}
                    value={promptOf(p)}
                    onChange={(e) => setPrompts(new Map(prompts).set(p.id, e.target.value))}
                    maxLength={TASK_PROMPT_MAX}
                    rows={8}
                  />
                  <SameRepoTasks repo={p.repo} tasks={tasks} />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => decisions.start([{ id: p.id, prompt: promptOf(p) }])}
                      disabled={decisions.pending || promptOf(p).trim() === ""}
                    >
                      <GitBranch /> Start task
                    </Button>
                    <ProposalReject title={p.title} disabled={decisions.pending} onReject={(reason) => decisions.reject(p.id, reason)} />
                  </div>
                </div>
              )}
              {error && <p className="text-destructive px-3 pb-3 text-sm whitespace-pre-wrap">{error}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function toggled(set: ReadonlySet<string>, id: string, on: boolean): Set<string> {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}
