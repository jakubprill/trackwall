import { agentsApi, type Task, type TaskProposal } from "@trackwall/protocol";
import { useState } from "react";
import { errorMessage, post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { type ProposalStart, selectionAfterDecision, startProposals } from "./proposal-decisions.ts";
import type { SessionSelection } from "./session-entries.ts";

/**
 * Start and reject for the task proposals of one main session (ADR-55), shared by the proposals panel and the grid
 * tile: one request at a time, an error per proposal, then a reload of the list and the selection after the decision.
 */
export function useProposalDecisions({
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
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const settle = (failed: ReadonlyMap<string, string>, decided: ReadonlySet<string>, started: readonly Task[]) => {
    setErrors(failed);
    setPending(false);
    onChanged();
    if (decided.size > 0) onDecided(selectionAfterDecision(proposals, decided, proposer, started));
  };

  const start = (starts: readonly ProposalStart[]) => {
    setPending(true);
    void startProposals(starts, (item) => post(conn, agentsApi.approveProposal, { proposal: item.id, prompt: item.prompt })).then(
      ({ started, failed }) => settle(failed, new Set(started.map((t) => t.id)), started),
    );
  };

  const reject = (id: string, reason: string) => {
    setPending(true);
    post(conn, agentsApi.rejectProposal, { proposal: id, reason }).then(
      () => settle(new Map(), new Set([id]), []),
      (err: unknown) => settle(new Map([[id, errorMessage(err)]]), new Set(), []),
    );
  };

  return { pending, errors, start, reject };
}
