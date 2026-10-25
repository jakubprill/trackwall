import { agentsApi, type Task } from "@trackwall/protocol";
import { useState } from "react";
import { errorMessage, post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { type ProposalStart, selectionAfterDecision, showsGroup, startProposals } from "./proposal-decisions.ts";
import type { ProposalsEntry, SessionSelection } from "./session-entries.ts";

/**
 * Start and reject for the task proposals of one main session (ADR-55), shared by the proposals panel and the grid
 * tile: one request at a time and an error per proposal. A decision first selects the group by its proposer, so the
 * panel stays while its proposals turn into tasks, then reloads the list and moves on (`selectionAfterDecision`),
 * unless the user has gone elsewhere meanwhile.
 */
export function useProposalDecisions({
  conn,
  group,
  onChanged,
  onSelect,
  currentSelection,
}: {
  conn: Connection;
  group: ProposalsEntry;
  onChanged: () => void;
  onSelect: (selection: SessionSelection) => void;
  /** The selection at the moment the decision ends, not at the render that started it. */
  currentSelection: () => SessionSelection;
}) {
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const begin = () => {
    setPending(true);
    onSelect({ kind: "proposals", proposer: group.proposer });
  };
  const settle = (failed: ReadonlyMap<string, string>, decided: ReadonlySet<string>, started: readonly Task[]) => {
    setErrors(failed);
    setPending(false);
    onChanged();
    if (decided.size > 0 && showsGroup(currentSelection(), group)) onSelect(selectionAfterDecision(group, decided, started));
  };

  const start = (starts: readonly ProposalStart[]) => {
    begin();
    void startProposals(starts, (item) => post(conn, agentsApi.approveProposal, { proposal: item.id, prompt: item.prompt })).then(
      ({ started, failed }) => settle(failed, new Set(started.map((t) => t.id)), started),
    );
  };

  const reject = (id: string, reason: string) => {
    begin();
    post(conn, agentsApi.rejectProposal, { proposal: id, reason }).then(
      () => settle(new Map(), new Set([id]), []),
      (err: unknown) => settle(new Map([[id, errorMessage(err)]]), new Set(), []),
    );
  };

  return { pending, errors, start, reject };
}
