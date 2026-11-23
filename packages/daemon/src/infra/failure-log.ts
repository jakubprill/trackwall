import { messageOf } from "./errors.ts";

/**
 * Where a job that a timer starts reports how it ended, such as a comparison of the repo watch or a round of the server
 * check: from a timer a rejection would be an unhandled one, which ends the process under Node, so its message goes to
 * the log instead, once while it repeats, so that a lasting failure (a missing projects folder) does not write a line on
 * every tick; a job that succeeds clears it.
 */
export function failureLog(label: string, log: (msg: string) => void): (job: Promise<unknown>) => void {
  let last: string | undefined;
  return (job) => {
    job.then(
      () => {
        last = undefined;
      },
      (err: unknown) => {
        const message = messageOf(err);
        if (last !== message) log(`${label}: ${message}`);
        last = message;
      },
    );
  };
}
