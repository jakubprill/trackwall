import type { Task } from "@trackwall/protocol";
import type { Connection } from "@/lib/connection";
import { type ProposalsEntry, proposalName, type SessionSelection } from "@/lib/session-entries";
import { useProposalDecisions } from "@/lib/use-proposal-decisions";
import { ProposalActions } from "./ProposalActions.tsx";

/**
 * The body of a grid tile with task proposals (ADR-48, ADR-55): every prompt in full, to read before “Start task”,
 * which starts it as proposed, and “Reject…”. Editing a prompt or starting several at once is in the full panel.
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
          <ProposalActions
            proposal={p}
            tasks={tasks}
            pending={decisions.pending}
            canStart
            error={decisions.errors.get(p.id)}
            onStart={() => decisions.start([{ id: p.id, prompt: p.prompt }])}
            onReject={(reason) => decisions.reject(p.id, reason)}
          />
        </li>
      ))}
    </ul>
  );
}
