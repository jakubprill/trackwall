import { useState } from "react";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { useConnection } from "@/lib/use-connection";
import { DaemonPanel } from "./DaemonPanel.tsx";
import { ReposView } from "./ReposView.tsx";
import { SettingsView } from "./SettingsView.tsx";
import { TabBar } from "./TabBar.tsx";

const VIEWS = [
  { id: "repos", label: "Repo" },
  { id: "daemon", label: "Daemon" },
  { id: "settings", label: "Ustawienia" },
] as const;
type View = (typeof VIEWS)[number]["id"];

export function App() {
  const [view, setView] = useState<View>("repos");
  const { conn, epoch, error, retry } = useConnection();
  return (
    <div className="flex h-screen flex-col">
      <header className="h-header flex shrink-0 items-center gap-6 border-b px-4">
        <span className="flex items-center gap-2">
          <img src="/favicon.png" alt="" className="size-5" />
          <span className="font-mono text-sm font-semibold tracking-brand uppercase">Trackwall</span>
        </span>
        <TabBar tabs={VIEWS} active={view} onSelect={setView} variant="nav" />
      </header>
      {error && (
        <div className="bg-destructive/10 flex items-center gap-3 border-b px-4 py-2">
          <p className="text-destructive min-w-0 flex-1 text-sm whitespace-pre-wrap">{error}</p>
          <Button variant="outline" size="sm" onClick={retry}>
            Spróbuj ponownie
          </Button>
        </div>
      )}
      <main className="hud-grid min-h-0 flex-1">
        {!conn && !error && (
          <div className="p-6">
            <Loading text="Łączenie z daemonem…" />
          </div>
        )}
        {conn && view === "repos" && <ReposView key={epoch} conn={conn} onRetry={retry} onOpenSettings={() => setView("settings")} />}
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
  );
}
