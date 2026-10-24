import type { Repo, RunningMiseTask, Session } from "@trackwall/protocol";
import {
  DAEMON_KEY,
  type HomeKey,
  type HomeModel,
  type HomeRepo,
  type HomeSessionState,
  parseHomeKey,
  repoKey,
  sessionKey,
} from "@trackwall/scene/model";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { twoDigits } from "@/lib/format";
import { homeDaemonStatus, homeRepoStatus, pullLabel } from "@/lib/home-model";
import { branchLabel } from "@/lib/repo-status";
import { sessionStateLabel } from "@/lib/session-state";

/**
 * Prawy panel pulpitu: szczegóły wybranego obiektu i przycisk, który do niego przechodzi. Bez wyboru pokazuje
 * podsumowanie środowiska, żeby panel nigdy nie był pusty, a pulpit dało się czytać bez sceny 3D.
 */
export function HomeDetails({
  selected,
  model,
  repos,
  sessions,
  running,
  onSelect,
  onOpen,
}: {
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
            Open Daemon
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
        <Panel title={session.repo} onClose={close}>
          <SessionDetails session={session} onSelect={onSelect} />
          <Button size="sm" onClick={() => onOpen(sessionKey(session.id))}>
            Open session
          </Button>
        </Panel>
      );
    }
    return (
      <div className="flex flex-col gap-4 p-4">
        <h2 className="hud-label">Environment</h2>
        <Summary model={model} />
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
          {/* Repo ze zmianami ma stan „changed”, więc commity do pobrania widać dopiero tutaj. */}
          {homeRepo.state === "changed" && behind > 0 && <span className="text-warning">{` · ${pullLabel(behind)}`}</span>}
        </Field>
      )}
      <Field name="Tasks">{tasks.length === 0 ? "none running" : tasks.map((t) => t.miseTask).join(", ")}</Field>
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
  return (
    <dl className="grid w-full grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
      <Field name="State">
        <StatusLabel {...sessionStateLabel(session)} />
      </Field>
      <Field name="Repo">
        <button type="button" className="hover:text-primary font-mono" onClick={() => onSelect(repoKey(session.repo))}>
          {session.repo}
        </button>
      </Field>
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

/** Stan środowiska słowami: to samo, co mówi rdzeń sceny i liczby obiektów na niej. */
function Summary({ model }: { model: HomeModel }) {
  const count = (state: HomeSessionState) => model.sessions.filter((s) => s.state === state).length;
  const rows = [
    ["Repos", model.repos.length],
    ["Not clean", model.repos.filter((r) => r.state !== "clean").length],
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
