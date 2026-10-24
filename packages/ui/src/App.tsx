import { agentsApi } from "@trackwall/protocol";
import { Activity, FolderGit2, Network, Settings, SquareTerminal } from "lucide-react";
import { useMemo, useState } from "react";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import type { SessionSelection } from "@/lib/session-entries";
import { waitingCount } from "@/lib/session-state";
import { useConnection } from "@/lib/use-connection";
import { useRemote } from "@/lib/use-remote";
import { useSessionFocus } from "@/lib/use-session-focus";
import { ActivityBar, type ActivityView } from "./ActivityBar.tsx";
import { DaemonPanel } from "./DaemonPanel.tsx";
import { GraphView } from "./GraphView.tsx";
import { ReposView } from "./ReposView.tsx";
import { SessionsView } from "./SessionsView.tsx";
import { SettingsView } from "./SettingsView.tsx";

/** Kolejność i skróty paska widoków; następne widoki pracy dostają kolejne cyfry. */
const VIEWS = [
  { id: "repos", label: "Repo", icon: FolderGit2, shortcut: "1", placement: "top" },
  { id: "sessions", label: "Sesje", icon: SquareTerminal, shortcut: "2", placement: "top" },
  { id: "graph", label: "Przegląd", icon: Network, shortcut: "3", placement: "top" },
  { id: "daemon", label: "Daemon", icon: Activity, shortcut: "9", placement: "bottom" },
  { id: "settings", label: "Ustawienia", icon: Settings, shortcut: ",", placement: "bottom" },
] as const satisfies readonly ActivityView<string>[];
type View = (typeof VIEWS)[number]["id"];

/** Lista sesji jest odpytywana zawsze, bo pasek widoków pokazuje, ile czeka; częściej, gdy widok „Sesje” jest otwarty. */
const SESSIONS_POLL_MS = { open: 1000, closed: 3000 };

export function App() {
  const [view, setView] = useState<View>("repos");
  const [session, setSession] = useState<SessionSelection>();
  const { conn, epoch, error, retry } = useConnection();
  const sessions = useSessions(conn, view === "sessions");
  // Skok do sesji z traya (ADR-26): powłoka pokazuje okno i podaje sesję, która czeka.
  useSessionFocus((id) => {
    setView("sessions");
    setSession({ kind: "session", id });
  });
  return (
    <div className="flex h-screen">
      <ActivityBar views={VIEWS} active={view} onSelect={setView} badges={{ sessions: waitingCount(sessions.data?.sessions ?? []) }} />
      <div className="flex min-w-0 flex-1 flex-col">
        {error && (
          <div className="bg-destructive/10 flex items-center gap-3 border-b px-4 py-2">
            <p className="text-destructive min-w-0 flex-1 text-sm whitespace-pre-wrap">{error}</p>
            <Button variant="outline" size="sm" onClick={retry}>
              Spróbuj ponownie
            </Button>
          </div>
        )}
        <main className="hud-grid min-h-0 flex-1 overflow-y-auto">
          {!conn && !error && (
            <div className="p-6">
              <Loading text="Łączenie z daemonem…" />
            </div>
          )}
          {conn && view === "repos" && <ReposView key={epoch} conn={conn} onRetry={retry} onOpenSettings={() => setView("settings")} />}
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

function useSessions(conn: Connection | undefined, open: boolean) {
  const load = useMemo(() => conn && (() => post(conn, agentsApi.sessions, {})), [conn]);
  return useRemote(load, { pollMs: () => (open ? SESSIONS_POLL_MS.open : SESSIONS_POLL_MS.closed) });
}
