import type { Session, TaskProposal } from "@trackwall/protocol";
import { type HomeKey, type HomeModel, repoKey, sessionKey } from "@trackwall/scene/model";
import { Lightbulb } from "lucide-react";
import type { ReactNode } from "react";
import { StatusLabel } from "@/components/StatusLabel";
import { twoDigits } from "@/lib/format";
import { HOME_SESSION_STATUS, homeRepoStatus } from "@/lib/home-model";
import { PROPOSAL_STATUS } from "@/lib/session-entries";
import { sessionStateLabel } from "@/lib/session-state";
import { cn } from "@/lib/utils";

/**
 * Kolejka po lewej stronie pulpitu: najpierw sesje, które czekają na Ciebie albo skończyły się błędem, potem propozycje
 * zadań (ADR-39), potem repo, które nie są czyste. Sesje i repo to te same obiekty co etykiety na scenie, więc pulpit
 * da się obsłużyć także bez WebGL. Propozycji nie ma na scenie, a decyzja (z poprawką polecenia) zapada w widoku
 * „Sessions”, więc klik w propozycję od razu ją tam otwiera.
 */
export function NeedsYouPanel({
  model,
  sessions,
  proposals,
  selected,
  onSelect,
  onOpen,
  onOpenProposal,
}: {
  model: HomeModel;
  sessions: ReadonlyMap<string, Session>;
  proposals: readonly TaskProposal[];
  selected: HomeKey | null;
  onSelect: (key: HomeKey) => void;
  onOpen: (key: HomeKey) => void;
  onOpenProposal: (id: string) => void;
}) {
  const urgent = model.sessions.filter((s) => s.state === "attention" || s.state === "error");
  const repos = model.repos.filter((r) => r.state !== "clean");
  const working = model.sessions.filter((s) => s.state === "working").length;

  return (
    <aside className="bg-card flex min-h-0 flex-col border-r">
      <h2 className="hud-label px-4 pt-3 pb-2">
        Needs you <span className="text-primary">{`// ${twoDigits(urgent.length)}`}</span>
      </h2>
      <ul aria-label="Sessions that need you" className="px-2">
        {urgent.length === 0 && <li className="text-muted-foreground px-2 py-1 text-sm">No session is waiting for you.</li>}
        {urgent.map((s) => {
          // Pełny stan z widoku „Sessions” (np. „asking for approval”), a tytuł okna odróżnia dwie sesje jednego repo.
          const session = sessions.get(s.id);
          const status = session ? sessionStateLabel(session) : HOME_SESSION_STATUS[s.state];
          const title = session?.windowTitle ? `${s.repo} · ${session.windowTitle}` : s.repo;
          return (
            <Row key={s.id} id={sessionKey(s.id)} selected={selected} onSelect={onSelect} onOpen={onOpen} title={title}>
              <StatusLabel tone={status.tone} label={status.label} />
            </Row>
          );
        })}
      </ul>
      {proposals.length > 0 && (
        <>
          <h2 className="hud-label flex items-center gap-1.5 px-4 pt-4 pb-2">
            <Lightbulb className="text-warning size-3" aria-hidden />
            Proposals <span className="text-primary">{`// ${twoDigits(proposals.length)}`}</span>
          </h2>
          <ul aria-label="Task proposals waiting for your decision" className="px-2">
            {proposals.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onOpenProposal(p.id)}
                  className="flex w-full flex-col items-start gap-1 rounded-md border border-transparent px-2 py-2 text-left transition-colors hover:bg-accent"
                >
                  <span className="w-full truncate text-sm font-medium">{`${p.repo} · ${p.title}`}</span>
                  <span className="text-xs">
                    <StatusLabel {...PROPOSAL_STATUS} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <h2 className="hud-label px-4 pt-4 pb-2">
        Repos <span className="text-primary">{`// ${twoDigits(repos.length)} of ${twoDigits(model.repos.length)}`}</span>
      </h2>
      <ul aria-label="Repos that are not clean" className="min-h-0 flex-1 overflow-y-auto px-2">
        {repos.map((r) => (
          <Row key={r.id} id={repoKey(r.id)} selected={selected} onSelect={onSelect} onOpen={onOpen} title={r.id}>
            <StatusLabel {...homeRepoStatus(r)} />
          </Row>
        ))}
      </ul>
      <p className="text-muted-foreground border-t px-4 py-2 font-mono text-xs">{`${twoDigits(working)} working`}</p>
    </aside>
  );
}

function Row({
  id,
  title,
  selected,
  onSelect,
  onOpen,
  children,
}: {
  id: HomeKey;
  title: string;
  selected: HomeKey | null;
  onSelect: (key: HomeKey) => void;
  onOpen: (key: HomeKey) => void;
  children: ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={id === selected || undefined}
        onClick={() => onSelect(id)}
        onDoubleClick={() => onOpen(id)}
        className={cn(
          "flex w-full flex-col items-start gap-1 rounded-md border border-transparent px-2 py-2 text-left transition-colors hover:bg-accent",
          id === selected && "bg-accent border-primary/25 hud-active-edge",
        )}
      >
        <span className="w-full truncate text-sm font-medium">{title}</span>
        <span className="text-xs">{children}</span>
      </button>
    </li>
  );
}
