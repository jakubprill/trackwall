import { useState } from "react";
import { cn } from "@/lib/utils";
import { DaemonPanel } from "./DaemonPanel.tsx";
import { ReposView } from "./ReposView.tsx";

type View = "repos" | "daemon";
const VIEWS: { id: View; label: string }[] = [
  { id: "repos", label: "Repo" },
  { id: "daemon", label: "Daemon" },
];

export function App() {
  const [view, setView] = useState<View>("repos");
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-6 border-b px-6 py-3">
        <span className="font-semibold tracking-tight">Pitwall</span>
        <nav className="flex gap-1">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => setView(v.id)}
              aria-current={view === v.id ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-1 text-sm",
                view === v.id ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="min-h-0 flex-1">
        {view === "repos" ? (
          <ReposView />
        ) : (
          <div className="flex justify-center p-6">
            <DaemonPanel />
          </div>
        )}
      </main>
    </div>
  );
}
