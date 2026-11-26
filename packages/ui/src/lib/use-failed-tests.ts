import { agentsApi, type Verification, verificationApi } from "@trackwall/protocol";
import { useContext, useState } from "react";
import { post } from "./api.ts";
import { inDesktopShell } from "./app-window.ts";
import type { Connection } from "./connection.ts";
import { DaemonPlaceContext, editorLinkFor, NO_DESKTOP_NOTE, openOutside, opensEditor } from "./desktop.ts";
import { atLine } from "./failed-test.ts";
import { deliveryMessage } from "./review-drafts.ts";
import { useAction } from "./use-action.ts";

/**
 * The actions on the failed tests of a task (ADR-302, ADR-304): "Fix" hands one or all of them to the task's agent,
 * and a frame of a test's stack trace opens its file in VS Code at its line, where the daemon runs it, or in its
 * container through this page (ADR-121).
 */

/** Opening a frame of a failed test's trace in the task's worktree. */
export function useTraceFrames(conn: Connection, task: string) {
  const place = useContext(DaemonPlaceContext);
  const openFrame = useAction(
    async (frame: string) => {
      const file = await post(conn, agentsApi.taskFrameFile, { task, frame, open: place.desktop });
      if (place.desktop) return;
      const link = editorLinkFor(place, file.path);
      if (link === undefined) throw new Error(NO_DESKTOP_NOTE);
      // The desktop app hands it to the system (ADR-130); a browser hands a vscode: address to VS Code itself.
      if (inDesktopShell()) await openOutside(atLine(link, file.line));
      else window.location.assign(atLine(link, file.line));
    },
    () => {},
  );
  return {
    openFrame: openFrame.run,
    opening: openFrame.pending,
    /** VS Code opens somewhere: on the daemon's desktop, or in its container through this page. */
    canOpen: opensEditor(place),
    error: openFrame.error,
  };
}

export type TraceFrames = ReturnType<typeof useTraceFrames>;

/** The failed tests of a task's verification: "Fix" sends one by its index in the verification, or all of them. */
export function useFailedTests(conn: Connection, verification: Verification) {
  const { task, runId } = verification;
  const frames = useTraceFrames(conn, task);
  // A note about the run it was sent for: the next verification has not been sent.
  const [sent, setSent] = useState<{ runId: string; text: string }>();
  const fix = useAction(
    (failure: number | null) => post(conn, verificationApi.fixTests, { task, runId, failure }),
    ({ delivery }) => setSent({ runId, text: deliveryMessage(delivery, "the failed tests") }),
  );
  return {
    ...frames,
    fix: fix.run,
    fixing: fix.pending,
    sent: sent?.runId === runId ? sent.text : undefined,
    error: fix.error ?? frames.error,
  };
}

export type FailedTestsActions = ReturnType<typeof useFailedTests>;
