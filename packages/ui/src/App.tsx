import { useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { useConnection } from "@/lib/use-connection";
import { TabBar } from "./components/TabBar.tsx";
import { DaemonPanel } from "./DaemonPanel.tsx";
import { ReposView } from "./ReposView.tsx";

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
      <main className="min-h-0 flex-1">
        {!conn && <ConnectionStatus error={error} onRetry={retry} />}
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

function ConnectionStatus({ error, onRetry }: { error?: string; onRetry: () => Promise<boolean> }) {
  const [retryError, setRetryError] = useState<string>();
  if (!error) return <p className="text-muted-foreground p-6 text-sm">Łączenie z daemonem…</p>;
  return (
    <div className="flex flex-col items-start gap-3 p-6">
      <p className="text-destructive text-sm whitespace-pre-wrap">{retryError ?? error}</p>
      <Button variant="outline" size="sm" onClick={() => onRetry().catch((err: unknown) => setRetryError(errorMessage(err)))}>
        Spróbuj ponownie
      </Button>
    </div>
  );
}
