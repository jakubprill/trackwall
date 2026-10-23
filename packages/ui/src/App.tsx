import { Activity, FolderGit2, Network, Settings } from "lucide-react";
import { useState } from "react";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { useConnection } from "@/lib/use-connection";
import { ActivityBar, type ActivityView } from "./ActivityBar.tsx";
import { DaemonPanel } from "./DaemonPanel.tsx";
import { OverviewView } from "./OverviewView.tsx";
import { ReposView } from "./ReposView.tsx";
import { SettingsView } from "./SettingsView.tsx";

/** Kolejność i skróty paska widoków; następne widoki pracy (np. graf, sesje) dostają kolejne cyfry. */
const VIEWS = [
  { id: "repos", label: "Repo", icon: FolderGit2, shortcut: "1", placement: "top" },
  { id: "overview", label: "Przegląd", icon: Network, shortcut: "3", placement: "top" },
  { id: "daemon", label: "Daemon", icon: Activity, shortcut: "9", placement: "bottom" },
  { id: "settings", label: "Ustawienia", icon: Settings, shortcut: ",", placement: "bottom" },
] as const satisfies readonly ActivityView<string>[];
type View = (typeof VIEWS)[number]["id"];

export function App() {
  const [view, setView] = useState<View>("repos");
  const { conn, epoch, error, retry } = useConnection();
  return (
    <div className="flex h-screen">
      <ActivityBar views={VIEWS} active={view} onSelect={setView} />
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
          {conn && view === "overview" && <OverviewView key={epoch} conn={conn} />}
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
