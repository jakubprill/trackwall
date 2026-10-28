import type { Repo, RunningMiseTask, Session } from "@trackwall/protocol";
import {
  DAEMON_KEY,
  type HomeKey,
  type HomeModel,
  type HomeRepo,
  type HomeSessionState,
  parseHomeKey,
  repoKey,
  repoNeedsYou,
  sessionKey,
} from "@trackwall/scene/model";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { AgentDialogCard } from "@/components/AgentDialogCard";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { twoDigits } from "@/lib/format";
import { homeDaemonStatus, homeRepoStatus, pullLabel } from "@/lib/home-model";
import { branchLabel } from "@/lib/repo-status";
import { sessionPlace, sessionStateLabel } from "@/lib/session-state";

/**
 * The dashboard's right panel: details of the selected object and a button that goes to it. Without a selection it shows
 * a summary of the environment, so that the panel is never empty and the dashboard can be read without the 3D scene.
 * A session asking for approval shows its agent dialog, answered from here (ADR-66).
 */
export function HomeDetails({
  conn,
  loading,
  selected,
  model,
  repos,
  sessions,
  running,
  onSelect,
  onOpen,
}: {
  conn: Connection;
  /** The repo or session list has not arrived yet: the summary says so instead of counts of zero. */
  loading: boolean;
  selected: HomeKey | null;
  model: HomeModel;
  repos: ReadonlyMap<string, Repo>;
  sessions: ReadonlyMap<string, Session>;
  running: readonly RunningMiseTask[];
  onSelect: (key: HomeKey | null) => void;
  onOpen: (key: HomeKey) => void;
}) {
  const target = selected && parseHomeKey(selected);
  const close = () => onSelect(null);
  const body = () => {
    if (target?.kind === "daemon") {
      return (
        <Panel title="Daemon" onClose={close}>
          <Summary model={model} />
          <Button size="sm" onClick={() => onOpen(DAEMON_KEY)}>
            Open Diagnostics
          </Button>
        </Panel>
      );
    }
    const repo = target?.kind === "repo" ? repos.get(target.id) : undefined;
    const homeRepo = repo && model.repos.find((r) => r.id === repo.id);
    if (repo && homeRepo) {
      return (
        <Panel title={repo.id} onClose={close}>
          <RepoDetails
            repo={repo}
            homeRepo={homeRepo}
            running={running}
            sessions={[...sessions.values()].filter((s) => s.repo === repo.id)}
            onSelect={onSelect}
          />
          <Button size="sm" onClick={() => onOpen(repoKey(repo.id))}>
            Open repo
          </Button>
        </Panel>
      );
    }
    const session = target?.kind === "session" ? sessions.get(target.id) : undefined;
    if (session) {
      return (
        <Panel title={sessionPlace(session)} onClose={close}>
          <SessionDetails session={session} onSelect={onSelect} />
          {session.dialog && (
            <AgentDialogCard
              key={`${session.id}:${session.dialog.id}`}
              conn={conn}
              session={session.id}
              dialog={session.dialog}
              onOpen={() => onOpen(sessionKey(session.id))}
            />
          )}
          <Button size="sm" onClick={() => onOpen(sessionKey(session.id))}>
            Open session
          </Button>
        </Panel>
      );
    }
    return (
      <div className="flex flex-col gap-4 p-4">
        <h2 className="hud-label">Environment</h2>
        {loading ? <Loading /> : <Summary model={model} />}
        <p className="text-muted-foreground text-xs">Click an object to see it here; double-click to open it.</p>
      </div>
    );
  };
  return (
    <aside aria-label="Details" className="bg-card flex min-h-0 flex-col overflow-y-auto border-l">
      {body()}
    </aside>
  );
}

function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-4 p-4">
      <header className="flex w-full items-center justify-between gap-2">
        <h2 className="min-w-0 truncate text-sm font-medium">{title}</h2>
        <Button variant="ghost" size="icon" aria-label="Close details" onClick={onClose}>
          <X />
        </Button>
      </header>
      {children}
    </div>
  );
}

function RepoDetails({
  repo,
  homeRepo,
  running,
  sessions,
  onSelect,
}: {
  repo: Repo;
  homeRepo: HomeRepo;
  running: readonly RunningMiseTask[];
  sessions: readonly Session[];
  onSelect: (key: HomeKey) => void;
}) {
  const tasks = running.filter((t) => t.repo === repo.id);
  const behind = repo.status.kind === "ok" ? (repo.status.upstream?.behind ?? 0) : 0;
  return (
    <dl className="grid w-full grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
      <Field name="State">
        <StatusLabel {...homeRepoStatus(homeRepo)} />
      </Field>
      {repo.status.kind === "ok" && (
        <Field name="Branch">
          <span className="font-mono">{branchLabel(repo.status)}</span>
          {/* A repo with changes has the state "changed", so commits to pull show only here. */}
          {homeRepo.state === "changed" && behind > 0 && <span className="text-warning">{` · ${pullLabel(behind)}`}</span>}
        </Field>
      )}
      <Field name="Tasks">
        {tasks.length === 0 ? "none running" : tasks.map((t) => (t.task === null ? t.miseTask : `${t.miseTask} (in a task)`)).join(", ")}
      </Field>
      <Field name="Sessions">
        {sessions.length === 0
          ? "none"
          : sessions.map((s) => (
              <button key={s.id} type="button" className="hover:text-primary block text-left" onClick={() => onSelect(sessionKey(s.id))}>
                <StatusLabel {...sessionStateLabel(s)} />
              </button>
            ))}
      </Field>
    </dl>
  );
}

function SessionDetails({ session, onSelect }: { session: Session; onSelect: (key: HomeKey) => void }) {
  const { repo } = session;
  return (
    <dl className="grid w-full grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
      <Field name="State">
        <StatusLabel {...sessionStateLabel(session)} />
      </Field>
      {repo !== null && (
        <Field name="Repo">
          <button type="button" className="hover:text-primary font-mono" onClick={() => onSelect(repoKey(repo))}>
            {repo}
          </button>
        </Field>
      )}
      {session.windowTitle && <Field name="Window">{session.windowTitle}</Field>}
      {session.task && (
        <Field name="Task">
          <span className="font-mono">{session.task}</span>
        </Field>
      )}
    </dl>
  );
}

function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{name}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** The environment's state in words: the same as the scene's core and the object counts on it say. */
function Summary({ model }: { model: HomeModel }) {
  const count = (state: HomeSessionState) => model.sessions.filter((s) => s.state === state).length;
  const rows = [
    ["Repos", model.repos.length],
    ["Not clean", model.repos.filter((r) => repoNeedsYou(r.state)).length],
    ["Sessions working", count("working")],
    ["Waiting for you", count("attention")],
    ["Sessions idle", count("idle")],
    ["Links", model.links.length],
  ] as const;
  return (
    <div className="flex w-full flex-col gap-4">
      <StatusLabel {...homeDaemonStatus(model.daemonRunning)} />
      <dl className="grid grid-cols-[1fr_auto] gap-y-2 text-xs">
        {rows.map(([name, value]) => (
          <Field key={name} name={name}>
            <span className="font-mono">{twoDigits(value)}</span>
          </Field>
        ))}
      </dl>
    </div>
  );
}
