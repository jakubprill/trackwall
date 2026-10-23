import { DaemonInfo } from "@trackwall/protocol";
import { RefreshCw } from "lucide-react";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { call } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { type Remote, useRemote } from "@/lib/use-remote";

const POLL_MS = 5000;

export function DaemonPanel({ conn, onRetry }: { conn: Connection; onRetry: () => void }) {
  const load = useCallback(() => call(conn, "/api/daemon/info", DaemonInfo), [conn]);
  const info = useRemote(load, { pollMs: POLL_MS });

  return (
    <div className="w-full max-w-xl">
      <Surface
        label="Daemon"
        meta={
          <span className="flex items-center gap-2">
            <StatusBadge info={info} />
            <Button variant="ghost" size="icon" className="size-6" onClick={info.reload} aria-label="Odśwież">
              <RefreshCw />
            </Button>
          </span>
        }
      >
        <div className="flex flex-col gap-4 p-4">
          <p className="text-muted-foreground text-sm">Proces, który trzyma cały stan Trackwalla.</p>
          {!info.data && !info.error && <Loading text="Łączenie z daemonem…" />}
          {info.error && (
            <ErrorWithRetry
              message={info.error}
              onRetry={() => {
                onRetry();
                info.reload();
              }}
            />
          )}
          {info.data && !info.error && <InfoTable info={info.data} />}
        </div>
      </Surface>
    </div>
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
          <dt className="hud-label self-center">{k}</dt>
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
