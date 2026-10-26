import type { Session, TaskProposal } from "@trackwall/protocol";
import { type HomeKey, type HomeModel, repoKey, sessionKey } from "@trackwall/scene/model";
import { Lightbulb } from "lucide-react";
import type { ReactNode } from "react";
import { Loading } from "@/components/Loading";
import { QueueItem } from "@/components/QueueItem";
import { StatusLabel } from "@/components/StatusLabel";
import { twoDigits } from "@/lib/format";
import { HOME_SESSION_STATUS, homeRepoStatus } from "@/lib/home-model";
import { proposalName } from "@/lib/session-entries";
import { PROPOSAL_STATUS, sessionStateLabel, sessionTitle } from "@/lib/session-state";

/**
 * The queue on the left of the dashboard: first sessions that are waiting for you or ended with an error, then task
 * proposals (ADR-39), then repos that are not clean. Sessions and repos are the same objects as the labels on the scene,
 * so the dashboard also works without WebGL. Proposals are not on the scene, and the decision (with an edited prompt)
 * is made in the Sessions view, so a click on a proposal opens it there right away. Until the lists arrive it says it
 * is loading, rather than counts of zero.
 */
export function NeedsYouPanel({
  loading,
  model,
  sessions,
  proposals,
  selected,
  onSelect,
  onOpen,
  onOpenProposal,
}: {
  /** The repo or session list has not arrived yet. */
  loading: boolean;
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
  if (loading) {
    return (
      <aside className="bg-card flex min-h-0 flex-col border-r">
        <h2 className="hud-label px-4 pt-3 pb-2">Needs you</h2>
        <div className="px-4">
          <Loading />
        </div>
      </aside>
    );
  }

  return (
    <aside className="bg-card flex min-h-0 flex-col border-r">
      <h2 className="hud-label px-4 pt-3 pb-2">
        Needs you <span className="text-primary">{`// ${twoDigits(urgent.length)}`}</span>
      </h2>
      <ul aria-label="Sessions that need you" className="px-2">
        {urgent.length === 0 && <li className="text-muted-foreground px-2 py-1 text-sm">No session is waiting for you.</li>}
        {urgent.map((s) => {
          // The full state from the "Sessions" view (for example "asking for approval"), and the window title tells two
          // sessions of one repo apart.
          const session = sessions.get(s.id);
          const status = session ? sessionStateLabel(session) : HOME_SESSION_STATUS[s.state];
          const title = session ? sessionTitle(session) : s.repo;
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
              <QueueItem key={p.id} title={proposalName(p)} active={false} onClick={() => onOpenProposal(p.id)}>
                <StatusLabel {...PROPOSAL_STATUS} />
              </QueueItem>
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
    <QueueItem title={title} active={id === selected} onClick={() => onSelect(id)} onDoubleClick={() => onOpen(id)}>
      {children}
    </QueueItem>
  );
}
