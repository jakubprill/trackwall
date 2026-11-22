import type { Repo, RepoStatusOk, ServerCheckState, SessionList, UnpushedWork } from "@trackwall/protocol";
import { allReposRows, newOnServerSince } from "@/lib/all-repos";
import type { PullState } from "@/lib/use-pull";
import type { SyncRunHandle } from "@/lib/use-sync-run";
import { AllReposView } from "@/views/repos/AllRepos";
import type { GalleryState } from "./gallery-state.ts";
import { LONG_REPO, minutesAgo, NO_DAEMON, sessionList, stateOf, task, waiting } from "./sample-data.ts";

/** No sync since the daemon started, so the header has no "Results". */
const NO_SYNC: SyncRunHandle = { run: null, running: false, error: undefined, start: () => {} };

function repo(id: string, status: Repo["status"]): Repo {
  return { id, path: `/projects/${id}`, remote: `gitlab.example.com/shop/${id}`, status };
}

/** A repo git read, on `main` tracking `origin/main`, fetched `fetched` minutes ago (`null`: never). */
function ok(id: string, of: Partial<RepoStatusOk> & { behind?: number; ahead?: number; fetched?: number | null } = {}): Repo {
  const { behind = 0, ahead = 0, fetched = 4, ...status } = of;
  return repo(id, {
    kind: "ok",
    branch: "main",
    head: null,
    changes: 0,
    untracked: 0,
    upstream: { name: "origin/main", ahead, behind },
    fetchedAt: fetched === null ? null : minutesAgo(fetched),
    ...status,
  });
}

const CLEAN = ["admin-bff", "admin-web", "api-gateway", "auth", "customers", "notifications", "reviews", "search"].map((id) =>
  ok(id, { fetched: 2 * 24 * 60 }),
);

/** All repos for `repos` as the panel shows them, with the sessions, the work only in a container and the pulls given. */
function AllReposOf({
  repos,
  unpushed,
  serverCheck,
  sessions,
  all = repos.length,
  pulls,
}: {
  repos: readonly Repo[];
  unpushed?: UnpushedWork;
  serverCheck?: ServerCheckState;
  sessions?: SessionList;
  /** The repos before the tag filter, when it leaves fewer. */
  all?: number;
  pulls?: Readonly<Record<string, PullState>>;
}) {
  return (
    <AllReposView
      conn={NO_DAEMON}
      rows={allReposRows(repos, unpushed, newOnServerSince(repos, serverCheck), new Date())}
      inContainer={unpushed?.inContainer === true}
      serverCheck={serverCheck}
      filter={{ shown: repos.length, all }}
      sessions={sessions}
      running={[]}
      sync={NO_SYNC}
      canSync
      onShowSync={() => {}}
      onOpenRepo={() => {}}
      onOpenInSessions={() => {}}
      initialPulls={pulls}
    />
  );
}

const busy: GalleryState = {
  name: "Everything to look at, in a container",
  render: () => (
    <AllReposOf
      repos={[
        ok("catalog", { behind: 15 }),
        ok(LONG_REPO, { changes: 128, untracked: 3, behind: 4 }),
        ok("inventory", { behind: 3, ahead: 1 }),
        ok("shipping"),
        ok("pricing", { branch: "trackwall/publish-a-price-changed-event-when-a-price-changes", fetched: null }),
        repo("billing", { kind: "unavailable", message: "fatal: not a git repository (or any of the parent directories): .git" }),
        ...CLEAN,
      ]}
      unpushed={{
        inContainer: true,
        repos: [
          { repo: "shipping", commits: 1, branches: ["main"], noRemote: false, stashes: 0, changes: 0, changedWorktrees: 0 },
          { repo: LONG_REPO, commits: 12, branches: ["main"], noRemote: false, stashes: 2, changes: 131, changedWorktrees: 1 },
          {
            repo: "pricing",
            commits: 3,
            branches: ["trackwall/publish-a-price-changed-event-when-a-price-changes"],
            noRemote: true,
            stashes: 0,
            changes: 2,
            changedWorktrees: 1,
          },
        ],
        unreadable: [],
      }}
      sessions={sessionList({
        sessions: [
          waiting(1, 12, { repo: "catalog", state: stateOf("Input") }),
          waiting(2, 3, { repo: LONG_REPO, state: stateOf("Approval") }),
          waiting(3, 1, { repo: LONG_REPO, state: stateOf("Plan", "medium") }),
        ],
        tasks: [task(4, { repo: "pricing" })],
      })}
      all={20}
      // Its line across the table counts the column a container adds.
      pulls={{ catalog: { kind: "asking" } }}
    />
  ),
};

const outside: GalleryState = {
  name: "Commits to pull, outside a container",
  render: () => <AllReposOf repos={[ok("catalog", { behind: 320 }), ok("orders-api", { changes: 2, untracked: 1 }), ...CLEAN]} />,
};

/** The question and the failure take a line of their own under the row, across the whole table. */
const pulls: GalleryState = {
  name: "A pull asks first, another failed",
  render: () => (
    <AllReposOf
      repos={[ok("catalog", { behind: 15 }), ok("payments", { behind: 2 }), ...CLEAN]}
      sessions={sessionList({ sessions: [waiting(1, 12, { repo: "catalog", state: stateOf("Input") })] })}
      pulls={{
        catalog: { kind: "asking" },
        payments: {
          kind: "failed",
          message: "fatal: unable to access 'https://git.example.com/shop/payments.git/': Could not resolve host: git.example.com",
        },
      }}
    />
  ),
};

/** Found by the server check without a fetch (ADR-295): a pull where nothing is in its way, Changes where a file is. */
const newOnServer: GalleryState = {
  name: "New commits on the server, found without a fetch",
  render: () => (
    <AllReposOf
      repos={[
        ok("catalog", { fetched: 3 * 60 }),
        ok("orders-api", { changes: 1, fetched: 3 * 60 }),
        ok("payments", { behind: 2 }),
        ...CLEAN,
      ]}
      serverCheck={{
        on: true,
        last: {
          endedAt: minutesAgo(4),
          newCommits: [
            { repo: "catalog", checkedAt: minutesAgo(4) },
            { repo: "orders-api", checkedAt: minutesAgo(4) },
          ],
          unreached: [],
        },
      }}
    />
  ),
};

/** Without a VPN, the company's server does not answer: the header says so calmly, and the rows stay as of their fetch. */
const unreached: GalleryState = {
  name: "Servers out of reach",
  render: () => (
    <AllReposOf
      repos={[ok("catalog", { behind: 2 }), ...CLEAN]}
      serverCheck={{ on: true, last: { endedAt: minutesAgo(9), newCommits: [], unreached: ["catalog", ...CLEAN.map((r) => r.id)] } }}
    />
  ),
};

const clean: GalleryState = { name: "All clean", render: () => <AllReposOf repos={CLEAN} /> };

const loading: GalleryState = {
  name: "git still reads the repos",
  render: () => (
    <AllReposOf repos={[ok("catalog", { behind: 2 }), ...CLEAN.map((r) => ({ ...r, status: { kind: "loading" as const } }))]} />
  ),
};

export const ALL_REPOS_STATES: readonly GalleryState[] = [busy, outside, pulls, newOnServer, unreached, clean, loading];
