import type { Session } from "@trackwall/protocol";
import { type HomeKey, type HomeModel, repoKey, sessionKey } from "@trackwall/scene/model";
import type { ReactNode } from "react";
import { StatusLabel } from "@/components/StatusLabel";
import { twoDigits } from "@/lib/format";
import { homeRepoStateText } from "@/lib/home-model";
import { sessionStateLabel } from "@/lib/session-state";
import { cn } from "@/lib/utils";

/**
 * Kolejka po lewej stronie pulpitu: najpierw sesje, które czekają na Ciebie albo skończyły się błędem, potem repo,
 * które nie są czyste. To ta sama lista co etykiety na scenie, więc pulpit da się obsłużyć także bez WebGL.
 */
export function NeedsYouPanel({
  model,
  sessions,
  selected,
  onSelect,
  onOpen,
}: {
  model: HomeModel;
  sessions: ReadonlyMap<string, Session>;
  selected: HomeKey | null;
  onSelect: (key: HomeKey) => void;
  onOpen: (key: HomeKey) => void;
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
          const session = sessions.get(s.id);
          const state = session ? sessionStateLabel(session) : { label: s.state };
          return (
            <Row key={s.id} id={sessionKey(s.id)} selected={selected} onSelect={onSelect} onOpen={onOpen} title={s.repo}>
              <StatusLabel tone={s.state === "error" ? "error" : "warning"} label={state.label} />
            </Row>
          );
        })}
      </ul>
      <h2 className="hud-label px-4 pt-4 pb-2">
        Repos <span className="text-primary">{`// ${twoDigits(repos.length)} of ${twoDigits(model.repos.length)}`}</span>
      </h2>
      <ul aria-label="Repos with changes" className="min-h-0 flex-1 overflow-y-auto px-2">
        {repos.map((r) => (
          <Row key={r.id} id={repoKey(r.id)} selected={selected} onSelect={onSelect} onOpen={onOpen} title={r.id}>
            <StatusLabel tone={r.state === "unavailable" ? "error" : "warning"} label={homeRepoStateText(r)} />
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
