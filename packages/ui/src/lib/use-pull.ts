import { type PullResult, workspaceApi } from "@trackwall/protocol";
import { useState } from "react";
import { errorMessage, post } from "./api.ts";
import type { Connection } from "./connection.ts";

/** The pull's own state: running, its result or error, or the question asked first when something works in the folder. */
export type PullState =
  | { kind: "idle" }
  | { kind: "asking" }
  /** The user chose to put the changes aside first; the Upstream tile lists the files. */
  | { kind: "putting-aside" }
  | { kind: "running" }
  | { kind: "done"; result: PullResult }
  | { kind: "failed"; message: string };

export interface PullHandle {
  state: PullState;
  /** Pulls, or first asks when something works in the repo folder. */
  start: () => void;
  /** Pulls now: "Pull anyway" after the question, and "Retry". */
  run: () => void;
  putAside: () => void;
  /** Back to the offer: the question cancelled, or the changes put aside (the pull ran there, or not at all). */
  reset: () => void;
}

/**
 * The pull of one repo's checked-out branch (ADR-269), the same in the Upstream tile and in a row of All repos (ADR-291):
 * it asks first when something works in the repo folder (`workInRepoFolder`) and keeps its result until the next pull.
 * The new status comes with the repo list, which sees the moved HEAD. `initial` is the state it starts in: nothing pulled
 * in the app, any state in the gallery of view states.
 */
export function usePull(
  conn: Connection,
  repo: string,
  workInFolder: readonly string[],
  initial: PullState = { kind: "idle" },
): PullHandle {
  const [state, setState] = useState<PullState>(initial);
  const run = () => {
    setState({ kind: "running" });
    post(conn, workspaceApi.pull, { repo }).then(
      (result) => setState({ kind: "done", result }),
      (err: unknown) => setState({ kind: "failed", message: errorMessage(err) }),
    );
  };
  return {
    state,
    start: () => (workInFolder.length > 0 ? setState({ kind: "asking" }) : run()),
    run,
    putAside: () => setState({ kind: "putting-aside" }),
    reset: () => setState({ kind: "idle" }),
  };
}
