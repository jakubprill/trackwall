import { agentsApi } from "@trackwall/protocol";
import { Activity, FolderGit2, Network, Orbit, Settings, SquareTerminal } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { ActivityBar, type ActivityView } from "@/components/ActivityBar";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import type { DaemonEvents } from "@/lib/daemon-events";
import type { SessionSelection } from "@/lib/session-entries";
import { waitingCount } from "@/lib/session-state";
import { useConnection } from "@/lib/use-connection";
import { useDaemonEvents } from "@/lib/use-daemon-events";
import { useRemote } from "@/lib/use-remote";
import { useSessionFocus } from "@/lib/use-session-focus";
import { DaemonPanel } from "@/views/daemon/DaemonPanel";
import { GraphView } from "@/views/graph/GraphView";
import { HomeView } from "@/views/home/HomeView";
import { ReposView } from "@/views/repos/ReposView";
import { SessionsView } from "@/views/sessions/SessionsView";
import { SettingsView } from "@/views/settings/SettingsView";

/** Kolejność i skróty paska widoków; „Home” jest pierwszy (ADR-33), następne widoki pracy dostają kolejne cyfry. */
const VIEWS = [
  { id: "home", label: "Home", icon: Orbit, shortcut: "1", placement: "top" },
  { id: "repos", label: "Repos", icon: FolderGit2, shortcut: "2", placement: "top" },
  { id: "sessions", label: "Sessions", icon: SquareTerminal, shortcut: "3", placement: "top" },
  { id: "graph", label: "Overview", icon: Network, shortcut: "4", placement: "top" },
  { id: "daemon", label: "Daemon", icon: Activity, shortcut: "9", placement: "bottom" },
  { id: "settings", label: "Settings", icon: Settings, shortcut: ",", placement: "bottom" },
] as const satisfies readonly ActivityView<string>[];
type View = (typeof VIEWS)[number]["id"];

/**
 * Lista sesji przychodzi na żywo z WebSocketu zdarzeń (ADR-36), bo pasek widoków pokazuje, ile czeka. Bez połączenia
 * zdarzeń jest odpytywana, częściej, gdy otwarty jest widok, który pokazuje sesje („Home” albo „Sessions”).
 */
const SESSIONS_POLL_MS = { open: 1000, closed: 3000 };

export function App() {
  // Repo otwarte z pulpitu należy do przejścia, nie do widoku: każde inne przejście do „Repos” zaczyna bez niego.
  const [{ view, repo }, setNav] = useState<{ view: View; repo?: string }>({ view: "home" });
  const setView = useCallback((next: View, openRepo?: string) => setNav({ view: next, repo: openRepo }), []);
  const [session, setSession] = useState<SessionSelection>();
  const { conn, epoch, error, retry } = useConnection();
  const events = useDaemonEvents(conn);
  const sessions = useSessions(conn, events, view === "sessions" || view === "home");
  const openSession = (id: string) => {
    setView("sessions");
    setSession({ kind: "session", id });
  };
  // Skok do sesji z traya (ADR-26): powłoka pokazuje okno i podaje sesję, która czeka.
  useSessionFocus(openSession);
  return (
    <div className="flex h-screen">
      <ActivityBar views={VIEWS} active={view} onSelect={setView} badges={{ sessions: waitingCount(sessions.data?.sessions ?? []) }} />
      <div className="flex min-w-0 flex-1 flex-col">
        {error && (
          <div className="bg-destructive/10 flex items-center gap-3 border-b px-4 py-2">
            <p className="text-destructive min-w-0 flex-1 text-sm whitespace-pre-wrap">{error}</p>
            <Button variant="outline" size="sm" onClick={retry}>
              Try again
            </Button>
          </div>
        )}
        <main className="hud-grid min-h-0 flex-1 overflow-y-auto">
          {!conn && !error && (
            <div className="p-6">
              <Loading text="Connecting to the daemon…" />
            </div>
          )}
          {conn && view === "home" && (
            <HomeView
              key={epoch}
              conn={conn}
              events={events}
              sessions={sessions}
              onOpenSession={openSession}
              onOpenRepo={(id) => setView("repos", id)}
              onOpenDaemon={() => setView("daemon")}
              onOpenSettings={() => setView("settings")}
            />
          )}
          {conn && view === "repos" && (
            <ReposView key={epoch} conn={conn} initialRepo={repo} onRetry={retry} onOpenSettings={() => setView("settings")} />
          )}
          {conn && view === "sessions" && (
            <SessionsView key={epoch} conn={conn} sessions={sessions} selected={session} onSelect={setSession} />
          )}
          {conn && view === "graph" && <GraphView key={epoch} conn={conn} />}
          {conn && view === "daemon" && (
            <div className="flex justify-center p-6">
              <DaemonPanel key={epoch} conn={conn} onRetry={retry} />
            </div>
          )}
          {conn && view === "settings" && (
            <div className="flex justify-center p-6">
              <SettingsView key={epoch} conn={conn} onRetry={retry} onSaved={() => setView("repos")} />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function useSessions(conn: Connection | undefined, events: DaemonEvents | undefined, open: boolean) {
  const load = useMemo(() => conn && (() => post(conn, agentsApi.sessions, {})), [conn]);
  const live = useMemo(() => events?.feed("sessions.changed"), [events]);
  return useRemote(load, { pollMs: () => (open ? SESSIONS_POLL_MS.open : SESSIONS_POLL_MS.closed), live });
}
