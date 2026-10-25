import { actionIsNewer } from "./use-remote.ts";

/** A background run in the UI (ADR-21, ADR-27): the pure rule for `useBackgroundRun`, also used for the answer to the start at sign-in switch (ADR-65); tests in `test/background-run.test.ts`. */

/**
 * What to show: an action's result is newer than any response to a request sent before it (including one in flight),
 * and gives way to the first response to a request sent after it, `null` included (a restarted daemon does not know
 * the run), so that it does not hang on screen forever.
 */
export function currentRun<R>(
  acted: { run: R | null; afterLoad: number } | undefined,
  remote: { data?: R | null; loadNumber?: number },
): R | null | undefined {
  if (acted && actionIsNewer(acted.afterLoad, remote.loadNumber)) return acted.run;
  return remote.data;
}
