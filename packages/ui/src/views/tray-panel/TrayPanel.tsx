import { Lightbulb, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { twoDigits } from "@/lib/format";
import { PROPOSAL_STATUS, sessionStateLabel } from "@/lib/session-state";
import { openFromTrayPanel, type TrayPanelTarget, trayPanelEntries } from "@/lib/tray-panel";
import { useConnection } from "@/lib/use-connection";
import { useDaemonEvents } from "@/lib/use-daemon-events";
import { useSessions } from "@/lib/use-sessions";

/**
 * The tray panel (ADR-50): a small window next to the tray icon, with the task proposals and the sessions waiting for
 * you. A click opens the entry in the main window, the same way as the tray menu; the shell hides the panel.
 */
export function TrayPanel() {
  const { conn, error } = useConnection();
  const events = useDaemonEvents(conn);
  const sessions = useSessions(conn, events, true);
  const entries = sessions.data && trayPanelEntries(sessions.data);
  const open = (target: TrayPanelTarget) => {
    openFromTrayPanel(target).catch((err: unknown) => console.error(`[tray panel] ${errorMessage(err)}`));
  };
  const failure = error ?? sessions.error;
  const count = entries ? entries.proposals.length + entries.sessions.length : 0;

  return (
    <div className="bg-card flex h-screen flex-col border">
      <h1 className="hud-label px-4 pt-3 pb-2">
        Waiting for you <span className="text-primary">{`// ${twoDigits(count)}`}</span>
      </h1>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {failure && <p className="text-destructive px-2 py-1 text-sm">{failure}</p>}
        {!failure && !entries && (
          <div className="px-2 py-1">
            <Loading text="Connecting to the daemon…" />
          </div>
        )}
        {entries && count === 0 && <p className="text-muted-foreground px-2 py-1 text-sm">Nothing is waiting for you.</p>}
        {entries && count > 0 && (
          <ul aria-label="Waiting for you">
            {entries.proposals.map((p) => (
              <Entry
                key={p.id}
                icon={<Lightbulb className="text-warning size-3.5" aria-hidden />}
                title={`${p.repo} · ${p.title}`}
                onClick={() => open({ kind: "proposal", id: p.id })}
              >
                <StatusLabel {...PROPOSAL_STATUS} />
              </Entry>
            ))}
            {entries.sessions.map((s) => {
              const status = sessionStateLabel(s);
              return (
                <Entry
                  key={s.id}
                  icon={<SquareTerminal className="text-muted-foreground size-3.5" aria-hidden />}
                  title={s.windowTitle ? `${s.repo} · ${s.windowTitle}` : s.repo}
                  onClick={() => open({ kind: "session", id: s.id })}
                >
                  <StatusLabel tone={status.tone} label={status.label} />
                </Entry>
              );
            })}
          </ul>
        )}
      </div>
      <div className="border-t p-2">
        <Button variant="outline" size="sm" className="w-full" onClick={() => open(undefined)}>
          Open Trackwall
        </Button>
      </div>
    </div>
  );
}

function Entry({ icon, title, onClick, children }: { icon: ReactNode; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="hover:bg-accent flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors"
      >
        <span className="pt-0.5">{icon}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-sm font-medium">{title}</span>
          <span className="text-xs">{children}</span>
        </span>
      </button>
    </li>
  );
}
