import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useConnection } from "@/lib/use-connection";
import { DaemonPanel } from "./DaemonPanel.tsx";
import { ReposView } from "./ReposView.tsx";
import { TabBar } from "./TabBar.tsx";

const VIEWS = [
  { id: "repos", label: "Repo" },
  { id: "daemon", label: "Daemon" },
] as const;
type View = (typeof VIEWS)[number]["id"];

export function App() {
  const [view, setView] = useState<View>("repos");
  const { conn, epoch, error, retry } = useConnection();
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-6 border-b px-6 py-3">
        <span className="font-semibold tracking-tight">Pitwall</span>
        <TabBar tabs={VIEWS} active={view} onSelect={setView} variant="pills" />
      </header>
      {error && (
        <div className="flex items-center gap-3 border-b px-6 py-2">
          <p className="text-destructive min-w-0 flex-1 text-sm whitespace-pre-wrap">{error}</p>
          <Button variant="outline" size="sm" onClick={retry}>
            Spróbuj ponownie
          </Button>
        </div>
      )}
      <main className="min-h-0 flex-1">
        {!conn && !error && <p className="text-muted-foreground p-6 text-sm">Łączenie z daemonem…</p>}
        {conn && view === "repos" && <ReposView key={epoch} conn={conn} onRetry={retry} />}
        {conn && view === "daemon" && (
          <div className="flex justify-center p-6">
            <DaemonPanel key={epoch} conn={conn} onRetry={retry} />
          </div>
        )}
      </main>
    </div>
  );
}
