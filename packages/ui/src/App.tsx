import { Activity, FolderGit2, Network, Orbit, Settings, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityBar, type ActivityView } from "@/components/ActivityBar";
import { ErrorBanner } from "@/components/ErrorBanner";
import { FolderDrop } from "@/components/FolderDrop";
import { Loading } from "@/components/Loading";
import { SupervisorPanel } from "@/components/SupervisorPanel";
import { UpdateBanner } from "@/components/UpdateBanner";
import { inDesktopShell, openWindow, reportShown, START_PARAMS, showViewMenu, startFromLocation } from "@/lib/app-window";
import { DROP_HINT } from "@/lib/dropped-folder";
import type { DroppedPaths } from "@/lib/file-drop";
import { KeyboardElsewhere } from "@/lib/keyboard-elsewhere";
import { IS_MAC } from "@/lib/platform";
import { entrySelection, findEntry, nextWaitingShortcut, type SessionSelection } from "@/lib/session-entries";
import { SESSION_LAYOUTS, type SessionLayout } from "@/lib/session-grid";
import { sessionShortcut } from "@/lib/session-shortcut";
import { attentionCount } from "@/lib/session-state";
import { selectsSupervisor, showingTakesKeyboard, supervisorSummary } from "@/lib/supervisor";
import { readSupervisorPinned, saveSupervisorPinned } from "@/lib/supervisor-pin";
import { useAppMenu } from "@/lib/use-app-menu";
import { useAppUpdate } from "@/lib/use-app-update";
import { useConnection } from "@/lib/use-connection";
import { useDaemonEvents } from "@/lib/use-daemon-events";
import { useFileDrop } from "@/lib/use-file-drop";
import { useJumpRequest } from "@/lib/use-jump-request";
import { useRepoWatch } from "@/lib/use-repo-watch";
import { useSessionTree } from "@/lib/use-session-tree";
import { useSessions } from "@/lib/use-sessions";
import { useWindowShortcuts } from "@/lib/use-window-shortcuts";
import { DaemonPanel } from "@/views/daemon/DaemonPanel";
import { GraphView } from "@/views/graph/GraphView";
import { HomeView } from "@/views/home/HomeView";
import { ReposView } from "@/views/repos/ReposView";
import { SessionsView } from "@/views/sessions/SessionsView";
import { SettingsView } from "@/views/settings/SettingsView";

/** Order and shortcuts of the view bar; "Home" is first (ADR-33), the next work views get the next digits. */
// The macOS menu bar has the same ids, labels and shortcuts (`app_menu.rs`); `apps/desktop/test/shell-events.test.ts`
// compares them and reads each entry's keys in this order.
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

export function App() {
  // A repo opened from the dashboard belongs to the navigation, not to the view: any other navigation to "Repos" starts without it.
  // An extra window starts with the view it was opened with or showed at the last run (ADR-49), the main window with
  // Home. `visit` grows with every opening of a repo, so that Repos is mounted again with it even when it is already open.
  const [{ view, repo, visit }, setNav] = useState<{ view: View; repo?: string; visit: number }>(() => ({
    view: startFromLocation(window.location.search, START_PARAMS.view, VIEW_IDS) ?? "home",
    visit: 0,
  }));
  const setView = useCallback((next: View) => setNav((nav) => ({ view: next, visit: nav.visit })), []);
  const openRepos = useCallback((openRepo?: string) => setNav((nav) => ({ view: "repos", repo: openRepo, visit: nav.visit + 1 })), []);
  const [session, setSession] = useState<SessionSelection>();
  const [sessionLayout, setSessionLayout] = useState<SessionLayout>(
    () => startFromLocation(window.location.search, START_PARAMS.sessionLayout, SESSION_LAYOUTS) ?? "1",
  );
  const { conn, epoch, error, retry } = useConnection();
  const appUpdate = useAppUpdate();
  // A folder dropped outside a session (ADR-51); `seq` mounts a new bar for every drop, also of the same folder. A drop
  // without a daemon connection is ignored, rather than answered whenever the connection comes back.
  const [dropped, setDropped] = useState<{ paths: DroppedPaths; seq: number }>();
  const dragging = useFileDrop((paths) => {
    if (conn) setDropped((last) => ({ paths, seq: (last?.seq ?? 0) + 1 }));
  });
  const openReposFromDrop = useCallback(
    (openRepo?: string) => {
      setDropped(undefined);
      openRepos(openRepo);
    },
    [openRepos],
  );
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
      // Without the report a session from the tray opens in the last focused window, the next start opens this
      // window with what it showed before, and the title stays; nothing to show.
    });
  }, [view, sessionLayout]);
  // The menu bar of macOS (ADR-49) shows a view or opens the current one in a new window, like the activity bar.
  useAppMenu((command) => {
    if (command.kind === "new-window") newWindow?.open(view);
    else {
      const id = VIEW_IDS.find((v) => v === command.view);
      if (id) setView(id);
    }
  });
  const events = useDaemonEvents(conn);
  // The supervisor panel (ADR-58) is on the right of every view; pinned, it shows the supervisor's state all the time.
  const [supervisorPinned, setSupervisorPinned] = useState(() => readSupervisorPinned(() => window.localStorage));
  const pinSupervisor = useCallback((pinned: boolean) => {
    setSupervisorPinned(pinned);
    saveSupervisorPinned(() => window.localStorage, pinned);
  }, []);
  const sessions = useSessions(conn, events, view === "sessions" || view === "home" || supervisorPinned);
  const runningLive = useMemo(() => events?.feed("mise.running.changed"), [events]);
  const repoWatch = useRepoWatch(useMemo(() => events?.feed("repos.changed"), [events]));
  const warmupLive = useMemo(() => events?.feed("cards.warmup.changed"), [events]);
  const tree = useSessionTree(sessions);
  const { rows } = tree;
  const supervisor = useMemo(() => supervisorSummary(sessions.data, rows), [sessions.data, rows]);
  // Whether the keyboard is in the supervisor panel: then its terminal is the one in front of the user, not the one
  // selected in a view (ADR-47). The panel reports focus coming and going; Alt+0 gives the keyboard to its terminal.
  const [supervisorFocused, setSupervisorFocused] = useState(false);
  const showSupervisor = () => {
    pinSupervisor(true);
    if (showingTakesKeyboard(supervisor)) setSupervisorFocused(true);
  };
  // The supervisor has no entry in Sessions: a jump or selection that points at it opens its panel instead. Any other
  // takes the keyboard out of the panel, so that the terminal it opens is the one in front.
  const openInSessions = (selection: SessionSelection) => {
    if (selectsSupervisor(sessions.data, selection)) return showSupervisor();
    setSupervisorFocused(false);
    setView("sessions");
    setSession(selection);
  };
  // Alt+J (ADR-48) and the global shortcut (ADR-50): what comes after the selected entry, like the "Next waiting" button.
  const openNextWaiting = () => {
    const inSessions = view === "sessions";
    const entries = rows.map((r) => r.entry);
    const selected = inSessions ? findEntry(entries, session) : undefined;
    const { open, taken } = nextWaitingShortcut(entries, selected, inSessions, supervisor.sessionWaits);
    if (open?.kind === "supervisor") showSupervisor();
    else if (open) openInSessions(entrySelection(open));
    return taken;
  };
  // Jump from the tray, a notification or the tray panel (ADR-26, ADR-39, ADR-50), from the global shortcut (ADR-50)
  // or from a `trackwall://` link (ADR-52): the shell shows the window first.
  useJumpRequest((jump) => {
    if (jump.kind === "next-waiting") return void openNextWaiting();
    if (jump.kind !== "repo") return openInSessions(jump);
    openRepos(jump.id);
  });
  // Alt+J and Alt+0 from every view.
  useWindowShortcuts(
    (event) => {
      const shortcut = sessionShortcut(event, IS_MAC);
      return shortcut?.kind === "next-waiting" || shortcut?.kind === "supervisor" ? shortcut : undefined;
    },
    (shortcut) => {
      if (shortcut.kind === "next-waiting") return openNextWaiting();
      showSupervisor();
      return true;
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
        {appUpdate && <UpdateBanner handle={appUpdate} />}
        {error && <ErrorBanner message={error} action={{ label: "Try again", onClick: retry }} />}
        {windowError && <ErrorBanner message={windowError} action={{ label: "Dismiss", onClick: () => setWindowError(undefined) }} />}
        {conn && dropped && (
          <FolderDrop
            key={dropped.seq}
            conn={conn}
            paths={dropped.paths}
            onOpenRepos={openReposFromDrop}
            onDismiss={() => setDropped(undefined)}
          />
        )}
        {dragging && conn && (
          // Over the page, not in its flow: a bar that pushes the page down would move the terminals under the pointer.
          <p className="bg-card text-muted-foreground pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border px-4 py-2 text-sm shadow-lg">
            {DROP_HINT}
          </p>
        )}
        <KeyboardElsewhere.Provider value={supervisorFocused}>
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
                repoWatch={repoWatch}
                sessions={sessions}
                onOpenInSessions={openInSessions}
                onOpenRepo={openRepos}
                onOpenDaemon={() => setView("daemon")}
                onOpenSettings={() => setView("settings")}
              />
            )}
            {conn && view === "repos" && (
              <ReposView
                key={`${epoch}:${visit}`}
                conn={conn}
                initialRepo={repo}
                repoWatch={repoWatch}
                onRetry={retry}
                onOpenSettings={() => setView("settings")}
              />
            )}
            {conn && view === "sessions" && (
              <SessionsView
                key={epoch}
                conn={conn}
                sessions={sessions}
                runningLive={runningLive}
                selected={session}
                onSelect={openInSessions}
                onShowSupervisor={showSupervisor}
                tree={tree}
                supervisor={supervisor}
                layout={sessionLayout}
                onLayout={setSessionLayout}
              />
            )}
            {conn && view === "graph" && <GraphView key={epoch} conn={conn} warmupLive={warmupLive} repoWatch={repoWatch} />}
            {conn && view === "daemon" && (
              <div className="flex justify-center p-6">
                <DaemonPanel key={epoch} conn={conn} warmupLive={warmupLive} onRetry={retry} />
              </div>
            )}
            {conn && view === "settings" && (
              <div className="flex justify-center p-6">
                <SettingsView key={epoch} conn={conn} update={appUpdate} onRetry={retry} onSaved={() => setView("repos")} />
              </div>
            )}
          </main>
        </KeyboardElsewhere.Provider>
      </div>
      {conn && (
        <KeyboardElsewhere.Provider value={false}>
          <SupervisorPanel
            key={epoch}
            conn={conn}
            supervisor={supervisor}
            pinned={supervisorPinned}
            onPinned={pinSupervisor}
            focused={supervisorFocused}
            onFocusedChange={setSupervisorFocused}
            onOpenInSessions={openInSessions}
            onChanged={sessions.reload}
          />
        </KeyboardElsewhere.Provider>
      )}
    </div>
  );
}
