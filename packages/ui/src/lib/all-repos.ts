import { type Repo, type RepoStatusOk, type ServerCheckState, trackedChanges, type UnpushedWork } from "@trackwall/protocol";
import { clockTime, relativeTime, workingTreeLabel } from "./format.ts";
import { branchLabel, type StatusTone, serverLabel } from "./repo-status.ts";
import { type UnpushedRow, unpushedRows } from "./unpushed-work.ts";
import { type PullOffer, upstreamOffer } from "./upstream-pull.ts";

/**
 * "All repos", the first entry of the repo list and the panel the "Repos" view opens on (ADR-293): every repo's state
 * against the server in one table, so a repo whose branch lacks commits of the remote, or whose work is only in this
 * container, shows without opening it. A row needs a look when git cannot read the repo, it has uncommitted files, its
 * branch lacks commits of the branch it tracks (as of the repo's last fetch, or newer ones the server check found on the
 * server since, ADR-295), or, in a container, it has work on no remote (ADR-162); the other repos fold into one line. Each row offers the one next step that already exists: the pull
 * of the Upstream tile (ADR-269), or the repo's tab where the way out is. What goes on in each repo (ADR-103) the panel
 * adds from the sessions and running mise tasks, which the repo list's entry does not need.
 */

/** The row's next step: the pull itself, or the repo's tab where the way out is (`null`: the repo opens as it opens from the list). */
type AllReposAction = PullOffer | { kind: "open"; tab: "changes" | "shell" | null };

interface RowBase {
  repo: string;
  /** Work on no remote while the daemon runs in a container, or why git could not read it; `null` otherwise. */
  onlyHere: UnpushedRow | null;
  /** `null` when nothing in the repo needs doing, or git has not read it yet. */
  action: AllReposAction | null;
}

export type AllReposRow =
  /** git has not read the repo yet (ADR-113). */
  | (RowBase & { kind: "loading" })
  | (RowBase & { kind: "unavailable"; message: string })
  | (RowBase & {
      kind: "ok";
      branch: string;
      /** Uncommitted files: "2 changed, 1 new"; `null` for none. */
      changes: string | null;
      /**
       * What the branch lacks from the one it tracks: "15 to pull" or "diverged", or "new on the server" when only the
       * server check knows of commits to pull; `null` for nothing.
       */
      server: string | null;
      /** The server cell's tooltip, also over an empty cell: what the branch is compared with, as of which fetch. */
      serverTitle: string;
      /** When the repo last fetched (`RepoStatusOk.fetchedAt`). */
      fetchedAt: string | null;
    });

/**
 * `unpushed`: `undefined` until the daemon answers; outside a container it lists nothing. `newOnServer`: the repos whose
 * server has commits they have not fetched (`newOnServerSince`).
 */
export function allReposRows(
  repos: readonly Repo[],
  unpushed: UnpushedWork | undefined,
  newOnServer: ReadonlyMap<string, string>,
  now: Date,
): AllReposRow[] {
  const onlyHere = new Map(unpushedRows(unpushed).map((row) => [row.repo, row]));
  const toPush = new Set((unpushed?.repos ?? []).filter((r) => r.commits > 0 || r.stashes > 0).map((r) => r.repo));
  return repos.map((repo) => {
    const base = { repo: repo.id, onlyHere: onlyHere.get(repo.id) ?? null };
    const { status } = repo;
    if (status.kind === "loading") return { ...base, kind: "loading", action: null };
    // Opened, the repo says what git answered.
    if (status.kind === "unavailable")
      return { ...base, kind: "unavailable", message: status.message, action: { kind: "open", tab: null } };
    const newSince = newOnServer.get(repo.id) ?? null;
    return {
      ...base,
      kind: "ok",
      branch: branchLabel(status),
      changes: workingTreeLabel(trackedChanges(status), status.untracked) ?? null,
      server: serverLabel(status, newSince !== null),
      serverTitle: serverTitle(status, newSince, now),
      fetchedAt: status.fetchedAt,
      action: rowAction(status, newSince !== null, base.onlyHere !== null, toPush.has(repo.id)),
    };
  });
}

/**
 * The repos whose server has commits they have not fetched, for the table and the repo list (ADR-295): the ones the
 * server check's last round found new commits in, each with the moment it read the repo (`checkedAt`), unless the repo
 * fetched after that moment, which brought what the server had then.
 */
export function newOnServerSince(repos: readonly Repo[], serverCheck: ServerCheckState | undefined): ReadonlyMap<string, string> {
  const found = new Map((serverCheck?.last?.newCommits ?? []).map((n) => [n.repo, n.checkedAt]));
  return new Map(
    repos.flatMap(({ id, status }): [string, string][] => {
      const checkedAt = found.get(id);
      if (checkedAt === undefined || status.kind !== "ok") return [];
      const fetchedSince = status.fetchedAt !== null && Date.parse(status.fetchedAt) >= Date.parse(checkedAt);
      return fetchedSince ? [] : [[id, checkedAt]];
    }),
  );
}

/**
 * What makes a repo need a look, in the order the list's entry counts them: one list, so the table and the entry's
 * line cannot disagree about which repos need one.
 */
const NEEDS = [
  { word: "to pull", long: "with commits to pull", has: (r: AllReposRow) => r.kind === "ok" && r.server !== null },
  { word: "changed", long: "with uncommitted files", has: (r: AllReposRow) => r.kind === "ok" && r.changes !== null },
  { word: "only here", long: "with work only in this container", has: (r: AllReposRow) => r.onlyHere !== null },
  { word: "unavailable", long: "git cannot read", has: (r: AllReposRow) => r.kind === "unavailable" },
];

/** Whether the row stands in the table rather than in the folded line under it. */
export function needsLook(row: AllReposRow): boolean {
  return NEEDS.some((need) => need.has(row));
}

/**
 * The rows the table shows, in the list's order, and the ones folded into the line under it. A row that needed a look
 * earlier in this visit (`kept`) stays, so that a pull or a sync shows as the row turning clean, not as a row vanishing.
 */
export function splitRows(rows: readonly AllReposRow[], kept: ReadonlySet<string>): { shown: AllReposRow[]; folded: AllReposRow[] } {
  const stays = (row: AllReposRow) => needsLook(row) || kept.has(row.repo);
  return { shown: rows.filter(stays), folded: rows.filter((row) => !stays(row)) };
}

/**
 * The pull the Upstream tile offers, also for commits only the server check knows of; otherwise the tab with the way
 * out: Changes for uncommitted files, Shell for a diverged branch and for commits or stashes only here, and the repo
 * itself for other work only here.
 */
function rowAction(status: RepoStatusOk, newOnServer: boolean, onlyHere: boolean, toPush: boolean): AllReposAction | null {
  const offer = upstreamOffer(status, newOnServer);
  if (offer.kind === "pull") return offer;
  if (offer.kind === "blocked") return { kind: "open", tab: offer.way };
  if (status.changes > 0) return { kind: "open", tab: "changes" };
  if (toPush) return { kind: "open", tab: "shell" };
  return onlyHere ? { kind: "open", tab: null } : null;
}

/** `newSince`: when the server check found commits the repo has not fetched (`newOnServerSince`). */
function serverTitle(status: RepoStatusOk, newSince: string | null, now: Date): string {
  const { upstream, fetchedAt } = status;
  if (upstream === null) return status.branch === null ? "A detached HEAD tracks no branch" : `${status.branch} tracks no remote branch`;
  const fetched = fetchedAt === null ? "not fetched since it was cloned" : `fetched ${relativeTime(fetchedAt, now)}`;
  const diverged = upstream.ahead > 0 && upstream.behind > 0 ? ` (${upstream.ahead} local, ${upstream.behind} remote)` : "";
  const news = newSince === null ? "" : `; the server had newer commits ${relativeTime(newSince, now)}`;
  return `Compared with ${upstream.name}${diverged}, ${fetched}${news}`;
}

/** The state of all repos in one line, for the list's entry: "5 to pull · 2 changed · 4 only here", counting repos. */
export function allReposSummary(rows: readonly AllReposRow[]): { tone?: StatusTone; label: string; title?: string } {
  const parts = NEEDS.map((need) => ({ ...need, count: rows.filter(need.has).length })).filter((p) => p.count > 0);
  if (parts.length > 0)
    return {
      tone: "warning",
      label: parts.map((p) => `${p.count} ${p.word}`).join(" · "),
      title: parts.map((p) => `Repos ${p.long}: ${p.count}`).join("\n"),
    };
  // No tone while git reads the repos: a dot would claim a state the view does not know yet (ADR-113).
  return rows.some((r) => r.kind === "loading") ? { label: "loading" } : { tone: "ok", label: "all clean" };
}

/**
 * When the repos last fetched from the server, for the panel's header: the commits to pull are counted as of each repo's
 * own fetch, so the line gives the oldest and the newest; `null` while no repo has fetched.
 */
export function fetchedLine(rows: readonly AllReposRow[], now: Date): string | null {
  const times = rows.flatMap((r) => (r.kind === "ok" && r.fetchedAt !== null ? [Date.parse(r.fetchedAt)] : []));
  if (times.length === 0) return null;
  const oldest = relativeTime(new Date(Math.min(...times)).toISOString(), now);
  const newest = relativeTime(new Date(Math.max(...times)).toISOString(), now);
  return oldest === newest ? `Fetched from the server ${oldest}.` : `Fetched from the server between ${oldest} and ${newest}.`;
}

/**
 * The server check's last round, for the panel's header (ADR-295): when it asked, or, calmly, which servers did not
 * answer and when, with the repos in the tooltip; `null` while it is off or has not asked yet.
 */
export function serverCheckLine(serverCheck: ServerCheckState | undefined, now: Date): { text: string; title?: string } | null {
  const last = serverCheck?.last;
  if (!last) return null;
  const { unreached, endedAt } = last;
  if (unreached.length === 0) return { text: `Checked the servers for new commits ${relativeTime(endedAt, now)}.` };
  const repos = unreached.length === 1 ? unreached[0] : `${unreached.length} repos`;
  return {
    text: `Could not reach the server of ${repos} at ${clockTime(endedAt)}.`,
    title: `${unreached.join(", ")}\nSettings > Diagnostics says why git could not reach them.`,
  };
}

/** The line under the table for the folded rows: "11 more repos: clean, nothing to pull"; `null` when none is folded. */
export function foldedLine(folded: readonly AllReposRow[], shown: number): string | null {
  if (folded.length === 0) return null;
  const repos = `${folded.length} ${shown > 0 ? "more " : ""}${folded.length === 1 ? "repo" : "repos"}`;
  const loading = folded.filter((r) => r.kind === "loading").length;
  if (loading === folded.length) return `${repos}: git is still reading ${folded.length === 1 ? "it" : "them"}`;
  return loading > 0 ? `${repos}: clean, nothing to pull (${loading} still loading)` : `${repos}: clean, nothing to pull`;
}
