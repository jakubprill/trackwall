import { type DaemonInfo, DaemonInfoResult } from "@pitwall/protocol";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { call } from "@/lib/api";
import { type Connection, resolveConnection } from "@/lib/connection";

type State = { kind: "connecting" } | { kind: "connected"; info: DaemonInfo; at: Date } | { kind: "error"; message: string };

const POLL_MS = 5000;

export function DaemonPanel() {
  const [conn, setConn] = useState<Connection>();
  const [state, setState] = useState<State>({ kind: "connecting" });

  useEffect(() => {
    resolveConnection().then(setConn, (err: unknown) => setState({ kind: "error", message: String(err) }));
  }, []);

  const refresh = useCallback(async () => {
    if (!conn) return;
    try {
      const info = await call(conn, "/api/daemon/info", DaemonInfoResult);
      setState({ kind: "connected", info, at: new Date() });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [conn]);

  useEffect(() => {
    if (!conn) return;
    void refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [conn, refresh]);

  return (
    <Card className="w-full max-w-xl">
      <CardHeader>
        <CardTitle>Daemon</CardTitle>
        <CardDescription>Proces, który trzyma cały stan Pitwalla.</CardDescription>
        <CardAction className="flex items-center gap-2">
          <StatusBadge state={state} />
          <Button variant="ghost" size="icon" onClick={() => void refresh()} disabled={!conn} aria-label="Odśwież">
            <RefreshCw />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {state.kind === "connecting" && <p className="text-muted-foreground text-sm">Łączenie z daemonem…</p>}
        {state.kind === "error" && <p className="text-destructive text-sm whitespace-pre-wrap break-words">{state.message}</p>}
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
