import { agentsApi } from "@trackwall/protocol";
import { Activity, FolderGit2, Network, Orbit, Settings, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityBar, type ActivityView } from "@/components/ActivityBar";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Loading } from "@/components/Loading";
import { post } from "@/lib/api";
import { inDesktopShell, openWindow, reportShown, START_PARAMS, showViewMenu, startFromLocation } from "@/lib/app-window";
import type { Connection } from "@/lib/connection";
import type { DaemonEvents } from "@/lib/daemon-events";
import { IS_MAC } from "@/lib/platform";
import { entrySession, findEntry, type SessionSelection, sessionRows } from "@/lib/session-entries";
import { SESSION_LAYOUTS, type SessionLayout } from "@/lib/session-grid";
import { sessionShortcut } from "@/lib/session-shortcut";
import { attentionCount, nextWaitingShortcut } from "@/lib/session-state";
import { useConnection } from "@/lib/use-connection";
import { useDaemonEvents } from "@/lib/use-daemon-events";
import { useJumpRequest } from "@/lib/use-jump-request";
import { useRemote } from "@/lib/use-remote";
import { useWindowShortcuts } from "@/lib/use-window-shortcuts";
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
const VIEW_IDS = VIEWS.map((v) => v.id);

/**
 * Lista sesji przychodzi na żywo z WebSocketu zdarzeń (ADR-36), bo pasek widoków pokazuje, ile czeka. Bez połączenia
 * zdarzeń jest odpytywana, częściej, gdy otwarty jest widok, który pokazuje sesje („Home” albo „Sessions”).
 */
const SESSIONS_POLL_MS = { open: 1000, closed: 3000 };

export function App() {
  // Repo otwarte z pulpitu należy do przejścia, nie do widoku: każde inne przejście do „Repos” zaczyna bez niego.
  // An extra window starts with the view it was opened with or showed at the last run (ADR-49), the main window with Home.
  const [{ view, repo }, setNav] = useState<{ view: View; repo?: string }>(() => ({
    view: startFromLocation(window.location.search, START_PARAMS.view, VIEW_IDS) ?? "home",
  }));
  const setView = useCallback((next: View, openRepo?: string) => setNav({ view: next, repo: openRepo }), []);
  // A jump to a repo while "Repos" is open must still select it, and `ReposView` takes the repo only when it mounts.
  const [repoJumps, setRepoJumps] = useState(0);
  const [session, setSession] = useState<SessionSelection>();
  const [sessionLayout, setSessionLayout] = useState<SessionLayout>(
    () => startFromLocation(window.location.search, START_PARAMS.sessionLayout, SESSION_LAYOUTS) ?? "1",
  );
  const { conn, epoch, error, retry } = useConnection();
  const [windowError, setWindowError] = useState<string>();
  const newWindow = useMemo(() => {
    if (!inDesktopShell()) return undefined;
    const open = (id: View) => {
      setWindowError(undefined);
      openWindow(id).catch((err: unknown) => setWindowError(`Could not open a new window: ${String(err)}`));
    };
    const showMenu = (id: View) => {
      showViewMenu(() => open(id)).catch((err: unknown) => setWindowError(`Could not show the menu: ${String(err)}`));
    };
    return { open, showMenu };
  }, []);
  useEffect(() => {
    reportShown(view, sessionLayout).catch(() => {
      // Without the report a session from the tray opens in the last focused window, and the next start opens this
      // window with what it showed before; nothing to show.
    });
  }, [view, sessionLayout]);
  const events = useDaemonEvents(conn);
  const sessions = useSessions(conn, events, view === "sessions" || view === "home");
  const runningLive = useMemo(() => events?.feed("mise.running.changed"), [events]);
  const openInSessions = (selection: SessionSelection) => {
    setView("sessions");
    setSession(selection);
  };
  // Jump from the tray (ADR-26, ADR-39) or from a `trackwall://` link (ADR-52): the shell shows the window first.
  useJumpRequest((jump) => {
    if (jump.kind !== "repo") return openInSessions(jump);
    setView("repos", jump.id);
    setRepoJumps((n) => n + 1);
  });
  // Alt+J from every view (ADR-48), after the selected session like the "Next waiting" button.
  useWindowShortcuts(
    (event) => {
      const shortcut = sessionShortcut(event, IS_MAC);
      return shortcut?.kind === "next-waiting" ? shortcut : undefined;
    },
    () => {
      const inSessions = view === "sessions";
      const selected =
        inSessions && sessions.data
          ? entrySession(
              findEntry(
                sessionRows(sessions.data).map((r) => r.entry),
                session,
              ),
            )?.id
          : undefined;
      const { open, taken } = nextWaitingShortcut(sessions.data?.sessions ?? [], selected, inSessions);
      if (open) openInSessions({ kind: "session", id: open.id });
      return taken;
    },
  );
  return (
    <div className="flex h-screen">
      <ActivityBar
        views={VIEWS}
        active={view}
        onSelect={setView}
        newWindow={newWindow}
        badges={{ sessions: attentionCount(sessions.data) }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {error && <ErrorBanner message={error} action={{ label: "Try again", onClick: retry }} />}
        {windowError && <ErrorBanner message={windowError} action={{ label: "Dismiss", onClick: () => setWindowError(undefined) }} />}
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
              runningLive={runningLive}
              sessions={sessions}
              onOpenInSessions={openInSessions}
              onOpenRepo={(id) => setView("repos", id)}
              onOpenDaemon={() => setView("daemon")}
              onOpenSettings={() => setView("settings")}
            />
          )}
          {conn && view === "repos" && (
            <ReposView
              key={`${epoch}:${repoJumps}`}
              conn={conn}
              initialRepo={repo}
              onRetry={retry}
              onOpenSettings={() => setView("settings")}
            />
          )}
          {conn && view === "sessions" && (
            <SessionsView
              key={epoch}
              conn={conn}
              sessions={sessions}
              selected={session}
              onSelect={setSession}
              layout={sessionLayout}
              onLayout={setSessionLayout}
            />
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
