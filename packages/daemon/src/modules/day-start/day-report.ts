import {
  type Commit,
  DAY_REPORT_COMMITS,
  type DayReport,
  type DayReportCommits,
  type DayReportRepo,
  type DayReportTask,
  type Session,
  SyncOutcome,
  type SyncRepo,
  type SyncRun,
  TASK_TITLE_MAX,
  type Task,
} from "@trackwall/protocol";
import { mapLimit } from "../../infra/map-limit.ts";

/**
 * The day report (ADR-70): what came onto each repo's remote default branch since the last day start, the repos the
 * sync did not update, and every open task with how far its repo moved on. Read from git refs and objects after the
 * day start's sync, so it needs no network; a repo git cannot read only loses its commits, not the report.
 */

/** Repos read at once: each is a few short git processes. */
const REPORT_CONCURRENCY = 4;
/**
 * A repo without a remote is a deliberate local repo and its sync is skipped every day for the same reason, so that
 * alone does not make it news.
 */
const QUIET_SYNC_STATES: ReadonlySet<SyncOutcome["state"]> = new Set(["updated", "up-to-date"]);

/** The main remote's default branch (`origin/main`) and its commit. */
interface BranchTip {
  name: string;
  commit: string;
}

/** What the report reads from git (`vcs`, wired in the facade; a module declares what it uses on its own side, §4). */
export interface ReportVcs {
  /** The remote address without scheme (`Repo.remote`). */
  remote(dir: string): Promise<string | null>;
  remoteDefaultBranch(dir: string): Promise<BranchTip | null>;
  isAncestor(dir: string, ancestor: string, commit: string): Promise<boolean>;
  countBetween(dir: string, from: string, to: string): Promise<number | undefined>;
  commitsBetween(dir: string, from: string, to: string, limit: number): Promise<{ total: number; commits: Commit[] } | undefined>;
  newestCommits(dir: string, commit: string, limit: number): Promise<Commit[]>;
}

/** A repo of the projects folder: its identifier and root. */
interface ReportRepo {
  id: string;
  path: string;
}

/** A repo with its remote address and its remote default branch now; `tip: null` when unknown or unreadable. */
interface RepoTip {
  repo: ReportRepo;
  remote: string | null;
  tip: BranchTip | null;
}

export interface ReportInput {
  /** ISO 8601, when this day start began. */
  startedAt: string;
  /**
   * The last day start's time and the commit of each repo's remote default branch then, by repo root (a path, like the
   * sync result: the projects folder can change, and an id can pass to another directory, ADR-18); `null` before the first.
   */
  previous: { startedAt: string; heads: Readonly<Record<string, string>> } | null;
  repos: readonly ReportRepo[];
  /** This day start's sync, finished. */
  sync: SyncRun;
  tasks: readonly Task[];
  /** Newest first, as on the session list. */
  sessions: readonly Session[];
}

/** The report, and the commit of each repo's remote default branch now by repo root, which the next day start compares with. */
export async function dayReport(
  vcs: ReportVcs,
  input: ReportInput,
  log: (msg: string) => void,
): Promise<{ report: DayReport; heads: Record<string, string> }> {
  const failed = (repo: ReportRepo) => (err: unknown) => {
    log(`day report: ${repo.id}: ${String(err)}`);
    return null;
  };
  const tips: RepoTip[] = await mapLimit(input.repos, REPORT_CONCURRENCY, async (repo) => {
    const [remote, tip] = await Promise.all([
      vcs.remote(repo.path).catch(failed(repo)),
      vcs.remoteDefaultBranch(repo.path).catch(failed(repo)),
    ]);
    return { repo, remote, tip };
  });
  const tipOf = new Map(tips.map((entry) => [entry.repo.id, entry]));
  const [repos, tasks] = await Promise.all([
    mapLimit(tips, REPORT_CONCURRENCY, (entry) => repoEntry(vcs, input, entry, log)),
    mapLimit(input.tasks, REPORT_CONCURRENCY, (task) => taskEntry(vcs, input.sessions, task, tipOf.get(task.repo), log)),
  ]);
  const heads: Record<string, string> = {};
  for (const { head, repo } of repos) if (head !== undefined) heads[repo] = head;
  const entries = repos.map((r) => r.entry);
  return { report: { startedAt: input.startedAt, since: input.previous?.startedAt ?? null, ...quietCounted(entries), tasks }, heads };
}

/** The repos with something to say, and how many of the rest. */
function quietCounted(repos: readonly DayReportRepo[]): Pick<DayReport, "repos" | "quietRepos"> {
  const news = repos.filter((entry) => !isQuiet(entry));
  return { repos: news, quietRepos: repos.length - news.length };
}

/**
 * A repo's report entry, and the commit the next day start compares it with (`head`, by repo root): its tip now, or,
 * when the tip or its commits could not be read this time, the one from before, so what lands meanwhile is reported
 * next time rather than lost.
 */
async function repoEntry(
  vcs: ReportVcs,
  input: ReportInput,
  { repo, remote, tip }: RepoTip,
  log: (msg: string) => void,
): Promise<{ entry: DayReportRepo; repo: string; head: string | undefined }> {
  // `Object.hasOwn`: a directory named like an `Object` property (`constructor`) is no saved commit.
  const previousHead = input.previous && Object.hasOwn(input.previous.heads, repo.path) ? input.previous.heads[repo.path] : undefined;
  const synced = input.sync.repos.find((r) => r.path === repo.path);
  const sync = synced === undefined ? null : syncOutcome(synced);
  let commits: DayReportCommits | null = null;
  let head = tip?.commit ?? previousHead;
  if (tip !== null && input.previous !== null) {
    try {
      commits = await newCommits(vcs, repo.path, previousHead, tip.commit);
    } catch (err) {
      log(`day report: ${repo.id}: ${String(err)}`);
      head = previousHead;
    }
  }
  return { entry: { repo: repo.id, remote, remoteBranch: tip?.name ?? null, commits, sync }, repo: repo.path, head };
}

/**
 * A finished repo's sync result without the repo's identity, which the report entry already has; `null` for one still
 * waiting or running. Through the schema, because TypeScript does not narrow `SyncRepo` by its `state` enum.
 */
function syncOutcome(synced: SyncRepo): SyncOutcome | null {
  const parsed = SyncOutcome.safeParse(synced);
  return parsed.success ? parsed.data : null;
}

/** `null` when the branch has not moved since `previous`. */
async function newCommits(vcs: ReportVcs, dir: string, previous: string | undefined, tip: string): Promise<DayReportCommits | null> {
  if (previous === undefined) return { kind: "first-seen" };
  if (previous === tip) return null;
  if (!(await vcs.isAncestor(dir, previous, tip))) {
    return { kind: "rewritten", commits: await vcs.newestCommits(dir, tip, DAY_REPORT_COMMITS) };
  }
  const range = await vcs.commitsBetween(dir, previous, tip, DAY_REPORT_COMMITS);
  if (range === undefined || range.total === 0) return null;
  return { kind: "new", total: range.total, commits: range.commits };
}

function isQuiet(entry: DayReportRepo): boolean {
  if (entry.commits !== null) return false;
  if (entry.sync === null) return true;
  return QUIET_SYNC_STATES.has(entry.sync.state) || (entry.sync.state === "skipped" && entry.sync.reason === "no-remote");
}

async function taskEntry(
  vcs: ReportVcs,
  sessions: readonly Session[],
  task: Task,
  repo: RepoTip | undefined,
  log: (msg: string) => void,
): Promise<DayReportTask> {
  const session = sessions.find((s) => s.task === task.id && s.run.kind !== "exited");
  const tip = repo?.tip ?? null;
  const behind =
    repo === undefined || tip === null
      ? null
      : await vcs.countBetween(repo.repo.path, task.base, tip.commit).then(
          (count) => count ?? null,
          (err: unknown) => {
            log(`day report: task ${task.id}: ${String(err)}`);
            return null;
          },
        );
  return {
    task: task.id,
    repo: task.repo,
    title: task.title ?? promptStart(task.prompt),
    branch: task.branch,
    sessionState: session?.state?.state ?? null,
    needsAttention: session?.needsAttention ?? false,
    summaryAt: task.summary?.reportedAt ?? null,
    behind,
  };
}

/** A task typed in the UI has no title; the report names it by the start of its prompt, as long as a title may be. */
function promptStart(prompt: string): string {
  const line = prompt.trim().split("\n")[0] ?? "";
  return line.length > TASK_TITLE_MAX ? `${line.slice(0, TASK_TITLE_MAX - 1)}…` : line;
}
