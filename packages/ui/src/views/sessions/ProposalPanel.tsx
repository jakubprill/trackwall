import { agentsApi, type Session, TASK_PROMPT_MAX, type Task, type TaskProposal } from "@trackwall/protocol";
import { GitBranch, Lightbulb, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { proposerLabel } from "@/lib/session-entries";
import { useAction } from "@/lib/use-action";

/**
 * Propozycja zadania od sesji albo agenta spoza Trackwall (ADR-39): tytuł, repo i polecenie, które użytkownik może
 * poprawić przed startem. „Start task” robi z niej zadanie z tym samym identyfikatorem (worktree i sesja jak przy
 * zadaniu z formularza), „Reject” ją odrzuca; do tej chwili nic się nie uruchamia.
 */
export function ProposalPanel({
  conn,
  proposal,
  sessions,
  onApproved,
  onRejected,
}: {
  conn: Connection;
  proposal: TaskProposal;
  sessions: readonly Session[];
  onApproved: (task: Task) => void;
  onRejected: () => void;
}) {
  const [prompt, setPrompt] = useState(proposal.prompt);
  const approve = useAction(() => post(conn, agentsApi.approveProposal, { proposal: proposal.id, prompt }), onApproved);
  const reject = useAction(() => post(conn, agentsApi.rejectProposal, { proposal: proposal.id }), onRejected);
  const pending = approve.pending || reject.pending;
  const error = approve.error ?? reject.error;

  return (
    <div className="flex max-w-3xl flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <h3 className="hud-label flex items-center gap-2">
          <Lightbulb className="size-3.5" aria-hidden /> Task proposal
        </h3>
        <p className="text-lg font-medium">{proposal.title}</p>
        <p className="text-muted-foreground text-xs">
          {proposal.repo} · {proposerLabel(proposal.proposedBy, sessions)} · {relativeTime(proposal.createdAt, new Date())}
        </p>
      </div>
      <p className="text-muted-foreground max-w-prose text-sm">
        Nothing runs until you start the task. Trackwall then creates a new branch from the default branch of {proposal.repo} in a separate
        worktree and starts Copilot CLI there with this prompt. The prompt comes from an agent, so read it before you start; you can edit
        it.
      </p>
      <Textarea
        aria-label="Prompt for the agent"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        maxLength={TASK_PROMPT_MAX}
        rows={10}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={approve.run} disabled={pending || prompt.trim() === ""}>
          <GitBranch /> Start task
        </Button>
        <Button variant="outline" onClick={reject.run} disabled={pending}>
          <X /> Reject
        </Button>
      </div>
      {error && <p className="text-destructive text-sm whitespace-pre-wrap">{error}</p>}
    </div>
  );
}
