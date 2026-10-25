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
import { formatUptime } from "@/lib/format";
import { type Remote, useRemote } from "@/lib/use-remote";
import { ConnectCopilot } from "./ConnectCopilot.tsx";

const POLL_MS = 5000;

export function DaemonPanel({ conn, onRetry }: { conn: Connection; onRetry: () => void }) {
  const load = useCallback(() => call(conn, "/api/daemon/info", DaemonInfo), [conn]);
  const info = useRemote(load, { pollMs: POLL_MS });
  /** Data only from the last successful response; after an error the panel shows the error instead of stale values. */
  const ready = info.error ? undefined : info.data;

  return (
    <div className="flex w-full max-w-xl flex-col gap-4">
      <Surface
        label="Daemon"
        meta={
          <span className="flex items-center gap-2">
            <StatusBadge info={info} />
            <Button variant="ghost" size="icon" className="size-6" onClick={info.reload} aria-label="Refresh">
              <RefreshCw />
            </Button>
          </span>
        }
      >
        <div className="flex flex-col gap-4 p-4">
          <p className="text-muted-foreground text-sm">The process that holds all of Trackwall's state.</p>
          {!info.data && !info.error && <Loading text="Connecting to the daemon…" />}
          {info.error && (
            <ErrorWithRetry
              message={info.error}
              onRetry={() => {
                onRetry();
                info.reload();
              }}
            />
          )}
          {ready && <InfoTable info={ready} />}
        </div>
      </Surface>
      {ready && <ConnectCopilot info={ready} />}
    </div>
  );
}

function StatusBadge({ info }: { info: Remote<DaemonInfo> }) {
  if (info.error) return <Badge variant="destructive">error</Badge>;
  if (info.data) return <Badge variant="success">connected</Badge>;
  return <Badge variant="secondary">connecting</Badge>;
}

function InfoTable({ info }: { info: DaemonInfo }) {
  const rows: [string, string][] = [
    ["Version", info.version],
    ["PID", String(info.pid)],
    ["Runtime", `${info.runtime.name} ${info.runtime.version}`],
    ["Platform", `${info.platform} / ${info.arch}`],
    ["Launched", info.launchedBy === "desktop" ? "by the desktop app" : "manually"],
    ["Uptime", formatUptime(info.uptimeMs)],
    ["State directory", info.home],
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
