import {
  type Commit,
  DAY_REPORT_COMMITS,
  type DayReport,
  type DayReportCommits,
  type DayReportRepo,
  type DayReportTask,
  type Repo,
  type Session,
  SyncOutcome,
  type SyncRepo,
  type SyncRun,
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
/** A task typed in the UI has no title; the report names it by the start of its prompt. */
const TASK_TITLE_CHARS = 80;
/**
 * A repo without a remote is a deliberate local repo and its sync is skipped every day for the same reason, so that
 * alone does not make it news.
 */
const QUIET_SYNC_STATES: ReadonlySet<SyncOutcome["state"]> = new Set(["updated", "up-to-date"]);

/** What the report reads from git (`vcs`, wired in the facade). */
export interface ReportVcs {
  remoteDefaultBranch(dir: string): Promise<{ name: string; commit: string } | null>;
  isAncestor(dir: string, ancestor: string, commit: string): Promise<boolean>;
  commitsBetween(dir: string, from: string | null, to: string, limit: number): Promise<{ total: number; commits: Commit[] } | undefined>;
}

export interface ReportInput {
  /** ISO 8601, when this day start began. */
  startedAt: string;
  /** The last day start's time and the commit of each repo's remote default branch then; `null` before the first. */
  previous: { startedAt: string; heads: Readonly<Record<string, string>> } | null;
  repos: readonly Repo[];
  /** This day start's sync, finished. */
  sync: SyncRun;
  tasks: readonly Task[];
  /** Newest first, as on the session list. */
  sessions: readonly Session[];
}

/** The report, and the commit of each repo's remote default branch now, which the next day start compares with. */
export async function dayReport(
  vcs: ReportVcs,
  input: ReportInput,
  log: (msg: string) => void,
): Promise<{ report: DayReport; heads: Record<string, string> }> {
  const tips = await mapLimit(input.repos, REPORT_CONCURRENCY, (repo) =>
    vcs.remoteDefaultBranch(repo.path).catch((err: unknown) => {
      log(`day report: ${repo.id}: ${String(err)}`);
      return null;
    }),
  );
  const tipOf = new Map(input.repos.map((repo, i) => [repo.id, { repo, tip: tips[i] ?? null }]));
  const repos = await mapLimit(input.repos, REPORT_CONCURRENCY, (repo) =>
    repoEntry(vcs, input, repo, tipOf.get(repo.id)?.tip ?? null, log),
  );
  const tasks = await mapLimit(input.tasks, REPORT_CONCURRENCY, (task) => taskEntry(vcs, input.sessions, task, tipOf.get(task.repo), log));
  const heads: Record<string, string> = {};
  for (const [id, { tip }] of tipOf) if (tip !== null) heads[id] = tip.commit;
  const news = repos.filter((entry) => !isQuiet(entry));
  return {
    report: {
      startedAt: input.startedAt,
      since: input.previous?.startedAt ?? null,
      repos: news,
      quietRepos: repos.length - news.length,
      tasks,
    },
    heads,
  };
}

async function repoEntry(
  vcs: ReportVcs,
  input: ReportInput,
  repo: Repo,
  tip: { name: string; commit: string } | null,
  log: (msg: string) => void,
): Promise<DayReportRepo> {
  // A repo joins its sync result by path, because the id can change together with the directory name (ADR-18).
  const synced = input.sync.repos.find((r) => r.path === repo.path);
  const sync = synced === undefined ? null : syncOutcome(synced);
  const commits =
    tip === null || input.previous === null
      ? null
      : await newCommits(vcs, repo.path, input.previous.heads[repo.id], tip.commit).catch((err: unknown) => {
          log(`day report: ${repo.id}: ${String(err)}`);
          return null;
        });
  return { repo: repo.id, remote: repo.remote, remoteBranch: tip?.name ?? null, commits, sync };
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
    const newest = await vcs.commitsBetween(dir, null, tip, DAY_REPORT_COMMITS);
    return { kind: "rewritten", commits: newest?.commits ?? [] };
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
  repo: { repo: Repo; tip: { commit: string } | null } | undefined,
  log: (msg: string) => void,
): Promise<DayReportTask> {
  const session = sessions.find((s) => s.task === task.id && s.run.kind !== "exited");
  const behind =
    repo?.tip == null
      ? null
      : await vcs.commitsBetween(repo.repo.path, task.base, repo.tip.commit, 0).then(
          (range) => range?.total ?? null,
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

function promptStart(prompt: string): string {
  const line = prompt.trim().split("\n")[0] ?? "";
  return line.length > TASK_TITLE_CHARS ? `${line.slice(0, TASK_TITLE_CHARS - 1)}…` : line;
}
