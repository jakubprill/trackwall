import { git } from "./git.ts";

/**
 * The branch a local branch tracks, read from the branch's configuration (`branch.<name>.remote` and `.merge`), so also
 * when its remote-tracking ref is gone, which `@{upstream}` would only report as an error. One reader for the pull of the
 * checked-out branch (ADR-269) and the server check (ADR-295).
 */
export interface TrackedBranch {
  /** The remote-tracking ref, `refs/remotes/origin/main`, or the local branch for remote `.`. */
  ref: string;
  /** The same, short: `origin/main`. */
  short: string;
  /** The remote's name, or `.` for a local branch. */
  remote: string;
  /** The branch's name on the remote, `refs/heads/main`. */
  remoteRef: string;
}

/** What `head` (a full ref such as `refs/heads/main`) tracks; `undefined` when it tracks nothing. */
export async function trackedBranch(dir: string, head: string): Promise<TrackedBranch | undefined> {
  const { stdout } = await git(dir, [
    "for-each-ref",
    "--format=%(upstream)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)",
    "--",
    head,
  ]);
  const [ref = "", short = "", remote = "", remoteRef = ""] = stdout.toString("utf8").replace(/\n$/, "").split("\0");
  if (ref === "") return undefined;
  return { ref, short, remote: remote === "" ? "." : remote, remoteRef };
}
