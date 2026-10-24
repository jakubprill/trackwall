import { useEffect } from "react";
import { Loading } from "@/components/Loading";
import { QueueItem } from "@/components/QueueItem";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { twoDigits } from "@/lib/format";
import { PROPOSAL_STATUS, sessionStateLabel, sessionTitle } from "@/lib/session-state";
import { openFromTrayPanel, type TrayPanelTarget, trayPanelEntries } from "@/lib/tray-panel";
import { useConnection } from "@/lib/use-connection";
import { useDaemonEvents } from "@/lib/use-daemon-events";
import { useSessions } from "@/lib/use-sessions";

/**
 * The tray panel (ADR-50): a small window next to the tray icon, with the task proposals and the sessions waiting for
 * you. A click opens the entry in the main window, the same way as the tray menu; the shell hides the panel. The page
 * stays loaded while the shell runs, so it asks for the daemon's connection again each time it is shown or focused:
 * the daemon may have been restarted from the main window with a new port and token.
 */
export function TrayPanel() {
  const { conn, error, refresh } = useConnection();
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);
  const events = useDaemonEvents(conn);
  // Hidden most of the time: without the event connection it polls at the slower pace.
  const sessions = useSessions(conn, events, false);
  const entries = sessions.data && trayPanelEntries(sessions.data);
  const open = (target?: TrayPanelTarget) => {
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
              <QueueItem key={p.id} title={`${p.repo} · ${p.title}`} active={false} onClick={() => open({ kind: "proposal", id: p.id })}>
                <StatusLabel {...PROPOSAL_STATUS} />
              </QueueItem>
            ))}
            {entries.sessions.map((s) => (
              <QueueItem key={s.id} title={sessionTitle(s)} active={false} onClick={() => open({ kind: "session", id: s.id })}>
                <StatusLabel {...sessionStateLabel(s)} />
              </QueueItem>
            ))}
          </ul>
        )}
      </div>
      <div className="border-t p-2">
        <Button variant="outline" size="sm" className="w-full" onClick={() => open()}>
          Open Trackwall
        </Button>
      </div>
    </div>
  );
}
