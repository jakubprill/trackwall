import { DaemonPanel } from "./DaemonPanel.tsx";

export function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b px-6 py-3 flex items-center gap-3">
        <span className="font-semibold tracking-tight">Pitwall</span>
        <span className="text-muted-foreground text-xs">etap 1: szkielet</span>
      </header>
      <main className="flex-1 p-6 flex justify-center items-start">
        <DaemonPanel />
      </main>
    </div>
  );
}
