import type { Task } from "@trackwall/protocol";
import type { Connection } from "@/lib/connection";
import { type ProposalsEntry, proposalName, type SessionSelection } from "@/lib/session-entries";
import { useProposalDecisions } from "@/lib/use-proposal-decisions";
import { ProposalActions, ProposalError } from "./ProposalActions.tsx";

/**
 * The body of a grid tile with task proposals (ADR-48, ADR-55): every prompt in full, to read before “Start task”,
 * which starts it as proposed (with the proposed model, ADR-98), and “Reject…”. A proposal that asks to run without
 * approvals (ADR-105) starts only from the full panel, where its pill can be turned off. Editing a prompt, a model or the mode, or starting
 * several at once is in the full panel.
 */
export function ProposalTile({
  conn,
  group,
  tasks,
  onChanged,
  onSelect,
  currentSelection,
}: {
  conn: Connection;
  group: ProposalsEntry;
  tasks: readonly Task[];
  onChanged: () => void;
  onSelect: (selection: SessionSelection) => void;
  currentSelection: () => SessionSelection;
}) {
  const decisions = useProposalDecisions({ conn, group, onChanged, onSelect, currentSelection });
  return (
    <ul aria-label="Task proposals" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-2">
      {group.proposals.map((p) => (
        <li key={p.id} className="flex flex-col gap-2 border-b pb-3 last:border-b-0">
          <span className="text-xs font-medium">{proposalName(p)}</span>
          <p className="text-muted-foreground font-mono text-xs whitespace-pre-wrap">{p.prompt}</p>
          {p.model !== null && <p className="text-muted-foreground text-xs">Model: {p.model}</p>}
          {p.approvals === "auto" && (
            <p className="text-destructive text-xs">Asks to run without approvals: open it in the proposals panel to start it.</p>
          )}
          <ProposalActions
            proposal={p}
            tasks={tasks}
            pending={decisions.pending}
            canStart={p.approvals === "ask"}
            onStart={() => decisions.start([{ id: p.id, prompt: p.prompt, model: p.model, approvals: p.approvals, view: "terminal" }])}
            onRemoveRepo={() => decisions.removeRepo(p.id)}
            onReject={(reason) => decisions.reject(p.id, reason)}
          />
          <ProposalError error={decisions.errors.get(p.id)} />
        </li>
      ))}
    </ul>
  );
}
