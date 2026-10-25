import type { TaskProposal } from "@trackwall/protocol";
import { GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import type { SessionSelection } from "@/lib/session-entries";
import { useProposalDecisions } from "@/lib/use-proposal-decisions";
import { ProposalReject } from "./ProposalReject.tsx";

/**
 * The body of a grid tile with task proposals (ADR-48, ADR-55): every prompt in full, to read before “Start task”,
 * which starts it as proposed, and “Reject…”. Editing a prompt or starting several at once is in the full panel.
 */
export function ProposalTile({
  conn,
  proposer,
  proposals,
  onChanged,
  onDecided,
}: {
  conn: Connection;
  proposer: string | null;
  proposals: readonly TaskProposal[];
  onChanged: () => void;
  onDecided: (selection: SessionSelection) => void;
}) {
  const decisions = useProposalDecisions({ conn, proposer, proposals, onChanged, onDecided });
  return (
    <ul aria-label="Task proposals" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-2">
      {proposals.map((p) => {
        const error = decisions.errors.get(p.id);
        return (
          <li key={p.id} className="flex flex-col gap-2 border-b pb-3 last:border-b-0">
            <span className="text-xs font-medium">
              {p.repo} · {p.title}
            </span>
            <p className="text-muted-foreground font-mono text-xs whitespace-pre-wrap">{p.prompt}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => decisions.start([{ id: p.id, prompt: p.prompt }])} disabled={decisions.pending}>
                <GitBranch /> Start task
              </Button>
              <ProposalReject title={p.title} disabled={decisions.pending} onReject={(reason) => decisions.reject(p.id, reason)} />
            </div>
            {error && <p className="text-destructive text-xs whitespace-pre-wrap">{error}</p>}
          </li>
        );
      })}
    </ul>
  );
}
