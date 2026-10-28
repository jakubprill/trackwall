import type { CloneJob } from "@trackwall/protocol";

/** The clone of `fullName` once it is no longer running, polled from the clone list as the UI does. */
export async function finishedClone(jobs: () => CloneJob[], fullName: string): Promise<CloneJob | undefined> {
  for (let i = 0; i < 200; i++) {
    const job = jobs().find((j) => j.fullName === fullName);
    if (job?.state !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`the clone of ${fullName} did not finish within the test`);
}
