import {
  agentsApi,
  type ChangePart,
  changePromptsFit,
  type Session,
  type SessionView,
  TASK_PROMPT_MAX,
  type Task,
  type TaskApprovals,
  type TaskProposal,
} from "@trackwall/protocol";
import { ChevronDown, ChevronRight, GitBranch, Lightbulb } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { keptChangeParts, type ProposalStart } from "@/lib/proposal-decisions";
import { sandboxNote } from "@/lib/sandbox";
import {
  type ProposalsEntry,
  proposalKindLabel,
  proposalName,
  proposalsName,
  proposerLabel,
  type SessionSelection,
} from "@/lib/session-entries";
import { toggle } from "@/lib/set-toggle";
import { impactProposalNote } from "@/lib/task-impact";
import { typedModel } from "@/lib/task-model";
import { useProposalDecisions } from "@/lib/use-proposal-decisions";
import { useProviderModels } from "@/lib/use-provider-models";
import { useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";
import { ChangeOrderHints } from "./ChangeOrderHints.tsx";
import { ChangeProposalParts } from "./ChangeProposalParts.tsx";
import { ProposalActions, ProposalError } from "./ProposalActions.tsx";
import { RepoRemovalNote } from "./RepoRemovalNote.tsx";
import { RunningTasksNote } from "./RunningTasksNote.tsx";
import { StartOptions } from "./StartOptions.tsx";

/**
 * The task proposals of one main session or of agents outside Trackwall (ADR-39, ADR-55), reviewed together as the plan
 * they are: each with its repo, title, prompt, model (ADR-98) and approvals mode (ADR-105), which the user opens to read and may edit before the start. The user
 * starts one, or ticks several and starts them together; a proposal can be ticked only once it has been opened, so a
 * prompt from an agent is never started unread. “Reject…” takes an optional reason for the session that proposed it.
 * A proposed change (ADR-171) lists its repos with their notes, which the user may untick and edit, and starts as one. Until then nothing runs. `focus` is the proposal to open (from the list, the tray, a link or the last decision).
 */
/** What the user changed on a proposed change before starting it (ADR-171): the repos unticked and the notes edited. */
interface ChangeEdit {
  dropped: ReadonlySet<string>;
  /** By repo. */
  notes: ReadonlyMap<string, string>;
}
const NO_CHANGE_EDIT: ChangeEdit = { dropped: new Set(), notes: new Map() };

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
  // Whether a proposal started without approvals runs in Copilot CLI's sandbox, or is refused (ADR-181).
  const loadStartOptions = useCallback(() => post(conn, agentsApi.startOptions, {}), [conn]);
  const startOptions = useRemote(loadStartOptions).data;
  const sandbox = startOptions?.sandbox;
  const providerModels = useProviderModels(conn).models;
  const [prompts, setPrompts] = useState<ReadonlyMap<string, string>>(new Map());
  const [models, setModels] = useState<ReadonlyMap<string, string>>(new Map());
  const [approvals, setApprovals] = useState<ReadonlyMap<string, TaskApprovals>>(new Map());
  const [views, setViews] = useState<ReadonlyMap<string, SessionView>>(new Map());
  // The repos the user unticked and the notes they edited on each proposed change (ADR-171).
  const [changeEdits, setChangeEdits] = useState<ReadonlyMap<string, ChangeEdit>>(new Map());
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
  // A proposal names no view: its task shows in a terminal unless the user turns Chat on (ADR-137).
  const viewOf = (p: TaskProposal): SessionView => views.get(p.id) ?? "terminal";
  /** The start as the user left the proposal, or `undefined` while its prompt is empty or its model not an id. */
  const startOf = (p: TaskProposal): ProposalStart | undefined => {
    const model = typedModel(modelTextOf(p));
    return promptOf(p).trim() === "" || model === undefined
      ? undefined
      : { id: p.id, prompt: promptOf(p), model, approvals: approvalsOf(p), view: viewOf(p) };
  };
  const editOf = (p: TaskProposal): ChangeEdit => changeEdits.get(p.id) ?? NO_CHANGE_EDIT;
  const edit = (p: TaskProposal, change: Partial<ChangeEdit>) =>
    setChangeEdits(new Map(changeEdits).set(p.id, { ...editOf(p), ...change }));
  /** A change's parts as the user left them, or `undefined` while fewer than two are kept or a prompt is too long. */
  const partsOf = (p: TaskProposal, prompt: string): ChangePart[] | undefined => {
    const parts = p.parts === null ? undefined : keptChangeParts(p.parts, editOf(p).dropped, editOf(p).notes);
    return parts !== undefined && changePromptsFit(prompt, parts) ? parts : undefined;
  };
  const canStart = (p: TaskProposal) => {
    const start = startOf(p);
    return start !== undefined && (p.kind !== "change" || partsOf(p, start.prompt) !== undefined);
  };
  const decide = (p: TaskProposal) => {
    const start = startOf(p);
    if (start === undefined) return;
    if (p.kind !== "change") return decisions.start([start]);
    const parts = partsOf(p, start.prompt);
    if (parts !== undefined) decisions.startChange(start, parts);
  };
  const toStart = proposals.filter((p) => ticked.has(p.id));
  /**
   * The tasks a start would add (ADR-248): the ticked ones for "Start selected", otherwise those of the open proposal's
   * own button, a task per repo kept for a change.
   */
  const tasksStarting = () => {
    if (toStart.length > 0) return toStart.length;
    const open = proposals.find((p) => p.id === shown);
    return open?.parts ? open.parts.length - editOf(open).dropped.size : 1;
  };
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
      {proposals.some((p) => p.kind !== "remove_repo") && (
        <p className="text-muted-foreground max-w-prose text-sm">
          Nothing runs until you start a task. Trackwall then creates a new branch from the default branch of its repo in a separate
          worktree and starts Copilot CLI there with the prompt. The prompts come from an agent, so read them before you start; you can edit
          them
          {several ? ", and tick a proposal once you have opened it" : ""}.
        </p>
      )}
      {proposals.some((p) => p.kind !== "remove_repo") && (
        <RunningTasksNote sessions={sessions} warning={startOptions?.runningTasksWarning} starting={tasksStarting()} />
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
                  <ProposalHeading proposal={p} prompt={promptOf(p)} expanded={expanded} />
                </button>
              </div>
              {expanded && (
                <div className="flex flex-col gap-3 px-3 pb-3">
                  {p.kind === "remove_repo" ? (
                    <RepoRemovalNote proposal={p} />
                  ) : (
                    <>
                      {p.parts !== null && (
                        <ChangeProposalParts
                          title={p.title}
                          parts={p.parts}
                          dropped={editOf(p).dropped}
                          notes={editOf(p).notes}
                          disabled={decisions.pending}
                          onDropped={(dropped) => edit(p, { dropped })}
                          onNotes={(notes) => edit(p, { notes })}
                        />
                      )}
                      {p.parts && (
                        <ChangeOrderHints
                          conn={conn}
                          repos={p.parts.map((part) => part.repo).filter((repo) => !editOf(p).dropped.has(repo))}
                        />
                      )}
                      <Textarea
                        aria-label={`Prompt for the agent: ${p.title}`}
                        value={promptOf(p)}
                        onChange={(e) => setPrompts(new Map(prompts).set(p.id, e.target.value))}
                        maxLength={TASK_PROMPT_MAX}
                        rows={8}
                      />
                      <StartOptions
                        subject={p.title}
                        approvals={{ value: approvalsOf(p), onChange: (value) => setApprovals(new Map(approvals).set(p.id, value)) }}
                        sandbox={sandboxNote(sandbox, approvalsOf(p))}
                        model={{
                          value: modelTextOf(p),
                          onChange: (value) => setModels(new Map(models).set(p.id, value)),
                          suggestions: providerModels,
                        }}
                        view={{ value: viewOf(p), onChange: (value) => setViews(new Map(views).set(p.id, value)) }}
                        disabled={decisions.pending}
                      />
                    </>
                  )}
                  <ProposalActions
                    proposal={p}
                    tasks={tasks}
                    pending={decisions.pending}
                    canStart={canStart(p)}
                    onStart={() => decide(p)}
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

/** A proposal's name, why Trackwall made it when it did (ADR-198), and its prompt's start while it is closed. */
function ProposalHeading({ proposal, prompt, expanded }: { proposal: TaskProposal; prompt: string; expanded: boolean }) {
  const note = impactProposalNote(proposal);
  return (
    <span className="flex min-w-0 flex-col">
      <span className="text-sm font-medium">{proposalName(proposal)}</span>
      {note && <span className="text-muted-foreground text-xs">{note}</span>}
      {!expanded && <span className="text-muted-foreground truncate text-xs">{prompt}</span>}
    </span>
  );
}
