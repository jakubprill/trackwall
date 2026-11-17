import type { Repo, Session, TaskProposal, UnpushedWork } from "@trackwall/protocol";
import { homeModel } from "@/lib/home-model";
import { unpushedRows } from "@/lib/unpushed-work";
import { NeedsYouPanel } from "@/views/home/NeedsYouPanel";
import type { GalleryState } from "./gallery-state.ts";
import { exited, LONG_REPO, LONG_TITLE, proposal, session, stateOf, waiting } from "./sample-data.ts";

function repo(id: string, status: Repo["status"]): Repo {
  return { id, path: `/projects/${id}`, remote: `gitlab.example.com/shop/${id}`, status };
}

/** A repo git read: `changes` changed files, `behind` commits to pull. */
function repoWith(id: string, changes: number, behind = 0): Repo {
  return repo(id, {
    kind: "ok",
    branch: "main",
    head: null,
    changes,
    untracked: 0,
    upstream: { name: "origin/main", ahead: 0, behind },
  });
}

/** Home's "Needs you" column for these repos, sessions, proposals and work only in a container, with `selected` picked. */
function NeedsYouOf({
  repos,
  sessions = [],
  proposals = [],
  unpushed,
  loading = false,
}: {
  repos: readonly Repo[];
  sessions?: readonly Session[];
  proposals?: readonly TaskProposal[];
  unpushed?: UnpushedWork;
  loading?: boolean;
}) {
  const model = homeModel({ repos, sessions, graph: undefined, running: [], services: [], daemonRunning: true });
  const first = model.sessions[0];
  return (
    <NeedsYouPanel
      loading={loading}
      model={model}
      sessions={new Map(sessions.map((s) => [s.id, s]))}
      proposals={proposals}
      unpushed={unpushedRows(unpushed)}
      selected={first ? `session:${first.id}` : null}
      onSelect={() => {}}
      onOpen={() => {}}
      onOpenProposal={() => {}}
    />
  );
}

const busy: GalleryState = {
  name: "Everything that needs you",
  render: () => (
    <NeedsYouOf
      repos={[
        repoWith("shop", 3),
        repoWith(LONG_REPO, 128, 4),
        repoWith("orders-api", 0, 17),
        repo("billing", { kind: "unavailable", message: "not a git repository" }),
      ]}
      sessions={[
        waiting(1, 135, { state: stateOf("Approval"), windowTitle: "Running the tests" }),
        waiting(2, 2, { repo: LONG_REPO, state: stateOf("Plan", "medium"), windowTitle: LONG_TITLE }),
        session(3, { repo: "orders-api", run: exited(1), state: stateOf("Error") }),
        session(4, { repo: "billing" }),
      ]}
      proposals={[proposal(10, 1, { title: LONG_TITLE }), proposal(11, 1)]}
      unpushed={{
        inContainer: true,
        repos: [
          { repo: LONG_REPO, commits: 12, branches: ["trackwall/task-1"], noRemote: false, stashes: 3, changes: 128, changedWorktrees: 4 },
          { repo: "scratch", commits: 1, branches: [], noRemote: true, stashes: 0, changes: 0, changedWorktrees: 0 },
        ],
        unreadable: [{ repo: "billing", message: "not a git repository" }],
      }}
    />
  ),
};

const quiet: GalleryState = { name: "Nothing needs you", render: () => <NeedsYouOf repos={[repoWith("shop", 0)]} /> };

const loading: GalleryState = { name: "Loading", render: () => <NeedsYouOf repos={[]} loading /> };

export const HOME_STATES: readonly GalleryState[] = [busy, quiet, loading];
