import { DaemonInfo } from "@pitwall/protocol";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { call, errorMessage } from "@/lib/api";
import type { Connection } from "@/lib/connection";

type State = { kind: "connecting" } | { kind: "connected"; info: DaemonInfo; at: Date } | { kind: "error"; message: string };

const POLL_MS = 5000;

/** `onRetry` zwraca `true`, gdy podmienił połączenie; wtedy rodzic montuje panel od nowa (`key`). */
export function DaemonPanel({ conn, onRetry }: { conn: Connection; onRetry: () => Promise<boolean> }) {
  const [state, setState] = useState<State>({ kind: "connecting" });

  const refresh = useCallback(async () => {
    try {
      const info = await call(conn, "/api/daemon/info", DaemonInfo);
      setState({ kind: "connected", info, at: new Date() });
    } catch (err) {
      setState({ kind: "error", message: errorMessage(err) });
    }
  }, [conn]);

  /** Gdy daemon nie wstał, okno Tauri może go uruchomić ponownie; w przeglądarce zostaje zwykłe odświeżenie. */
  const retry = useCallback(async () => {
    setState({ kind: "connecting" });
    try {
      if (!(await onRetry())) await refresh();
    } catch (err) {
      setState({ kind: "error", message: errorMessage(err) });
    }
  }, [onRetry, refresh]);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <Card className="w-full max-w-xl">
      <CardHeader>
        <CardTitle>Daemon</CardTitle>
        <CardDescription>Proces, który trzyma cały stan Pitwalla.</CardDescription>
        <CardAction className="flex items-center gap-2">
          <StatusBadge state={state} />
          <Button variant="ghost" size="icon" onClick={() => void refresh()} aria-label="Odśwież">
            <RefreshCw />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {state.kind === "connecting" && <p className="text-muted-foreground text-sm">Łączenie z daemonem…</p>}
        {state.kind === "error" && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-destructive text-sm whitespace-pre-wrap break-words">{state.message}</p>
            <Button variant="outline" size="sm" onClick={() => void retry()}>
              Spróbuj ponownie
            </Button>
          </div>
        )}
        {state.kind === "connected" && <InfoTable info={state.info} />}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ state }: { state: State }) {
  if (state.kind === "connected") return <Badge variant="success">połączony</Badge>;
  if (state.kind === "error") return <Badge variant="destructive">błąd</Badge>;
  return <Badge variant="secondary">łączenie</Badge>;
}

function InfoTable({ info }: { info: DaemonInfo }) {
  const rows: [string, string][] = [
    ["Wersja", info.version],
    ["PID", String(info.pid)],
    ["Runtime", `${info.runtime.name} ${info.runtime.version}`],
    ["Platforma", `${info.platform} / ${info.arch}`],
    ["Uruchomiony przez", info.launchedBy === "desktop" ? "aplikację desktopową" : "ręcznie"],
    ["Działa od", formatUptime(info.uptimeMs)],
    ["Katalog stanu", info.home],
  ];
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="font-mono break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : m > 0 ? `${m} min ${s % 60} s` : `${s} s`;
}
