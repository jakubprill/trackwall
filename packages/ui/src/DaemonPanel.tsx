import { DaemonInfo } from "@pitwall/protocol";
import { RefreshCw } from "lucide-react";
import { useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { call } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { type Remote, useRemote } from "@/lib/use-remote";

const POLL_MS = 5000;

export function DaemonPanel({ conn, onRetry }: { conn: Connection; onRetry: () => void }) {
  const load = useCallback(() => call(conn, "/api/daemon/info", DaemonInfo), [conn]);
  const info = useRemote(load, { pollMs: POLL_MS });

  return (
    <Card className="w-full max-w-xl">
      <CardHeader>
        <CardTitle>Daemon</CardTitle>
        <CardDescription>Proces, który trzyma cały stan Pitwalla.</CardDescription>
        <CardAction className="flex items-center gap-2">
          <StatusBadge info={info} />
          <Button variant="ghost" size="icon" onClick={info.reload} aria-label="Odśwież">
            <RefreshCw />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {!info.data && !info.error && <p className="text-muted-foreground text-sm">Łączenie z daemonem…</p>}
        {info.error && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-destructive text-sm whitespace-pre-wrap break-words">{info.error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onRetry();
                info.reload();
              }}
            >
              Spróbuj ponownie
            </Button>
          </div>
        )}
        {info.data && !info.error && <InfoTable info={info.data} />}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ info }: { info: Remote<DaemonInfo> }) {
  if (info.error) return <Badge variant="destructive">błąd</Badge>;
  if (info.data) return <Badge variant="success">połączony</Badge>;
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
