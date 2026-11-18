import { type ContainerHealth, containerHealthApi } from "@trackwall/protocol";
import { AlertTriangle } from "lucide-react";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Skeleton, Skeletons } from "@/components/Skeleton";
import { Steady } from "@/components/Steady";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { type HealthTile, healthEvents, healthTiles, healthUptime, memoryBars } from "@/lib/container-health";
import { formatBytes } from "@/lib/format";
import { useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";

/**
 * The container's health (ADR-279), in Settings › Diagnostics: memory, processors, processes and the disk against the
 * container's limits, the day's memory, kills for memory and restarts, and what needs the user. So "the build died for
 * no reason" gets one. Only where Trackwall runs in a container.
 */
export function ContainerHealthSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, containerHealthApi.state, {}), [conn]);
  const health = useRemote(load);
  const loading = !health.data && !health.error;
  return (
    <Surface
      label="Container health"
      meta={health.data && health.data.warnings.length > 0 ? String(health.data.warnings.length) : undefined}
    >
      <div className="flex flex-col gap-3 p-4">
        {health.error && <ErrorWithRetry message={health.error} onRetry={health.reload} />}
        <Steady name="container-health" loading={loading} className="flex flex-col gap-3">
          {loading && (
            <Skeletons>
              <Skeleton className="h-16 w-full" />
            </Skeletons>
          )}
          {health.data && <HealthReport health={health.data} onRefresh={health.reload} />}
        </Steady>
      </div>
    </Surface>
  );
}

function HealthReport({ health, onRefresh }: { health: ContainerHealth; onRefresh: () => void }) {
  if (!health.inContainer)
    return (
      <p className="text-muted-foreground text-sm">
        Only where Trackwall runs in a dev container: there builds share the container's memory and processors, and a build killed for
        memory leaves no trace in its own log. Here Trackwall runs on this computer.
      </p>
    );
  const now = new Date();
  const events = healthEvents(health, now);
  return (
    <>
      <p className="text-muted-foreground text-sm">{healthUptime(health, now)}</p>
      {health.warnings.length > 0 && (
        <ul className="flex flex-col gap-2">
          {health.warnings.map((warning) => (
            <li key={warning.id} className="flex items-start gap-2 text-sm">
              <AlertTriangle aria-label="Warning" className="text-warning mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-words">{warning.text}</span>
            </li>
          ))}
        </ul>
      )}
      {!health.controlGroup && (
        <p className="text-muted-foreground text-sm">
          The container's own counts cannot be read here (no cgroup v2), so memory, processors and processes are not shown.
        </p>
      )}
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-2">
        {healthTiles(health).map((tile) => (
          <Tile key={tile.label} tile={tile} />
        ))}
      </dl>
      {health.history.length > 1 && <MemoryChart health={health} />}
      <div className="flex flex-col gap-1">
        <p className="hud-label">Today</p>
        {events.length === 0 && <p className="text-sm">No process killed for memory and no crash of the daemon in the last day.</p>}
        {events.map((event) => (
          <p key={event.key} className="text-sm break-words">
            {event.text}
          </p>
        ))}
      </div>
      <div>
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
    </>
  );
}

function Tile({ tile }: { tile: HealthTile }) {
  return (
    <div className="surface flex min-w-0 flex-col gap-1 px-3 py-2">
      <dt className="hud-label">{tile.label}</dt>
      <dd className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-sm">{tile.value}</span>
        {tile.share !== null && (
          <span
            role="img"
            aria-label={`${Math.round(tile.share * 100)}% in use`}
            className="bg-secondary flex h-1.5 overflow-hidden rounded-full"
          >
            <span
              className={cn(tile.share >= 0.9 ? "bg-warning" : "bg-chart-1")}
              style={{ width: `${Math.min(100, tile.share * 100)}%` }}
            />
          </span>
        )}
        {tile.note && <span className="text-muted-foreground text-xs break-words">{tile.note}</span>}
      </dd>
    </div>
  );
}

function MemoryChart({ health }: { health: ContainerHealth }) {
  const { top, bars } = memoryBars(health.history, health.memory?.limit ?? null);
  return (
    <figure className="m-0 flex flex-col gap-2" aria-label="Memory over the last day">
      <figcaption className="text-muted-foreground flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="hud-label">Memory, last day</span>
        <span>
          {health.memory?.limit != null ? "up to the limit of " : "up to "}
          {formatBytes(top)}
        </span>
      </figcaption>
      <div className="flex h-24 items-end gap-px border-b">
        {bars.map((bar) => (
          <span
            key={bar.at}
            title={bar.label}
            className="bg-chart-1 min-w-px flex-1 rounded-t-sm"
            style={{ height: `${Math.max(1, bar.percent)}%` }}
          />
        ))}
      </div>
    </figure>
  );
}
