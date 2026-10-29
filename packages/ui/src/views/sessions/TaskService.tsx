import { servicesApi, type Task } from "@trackwall/protocol";
import { ArrowLeftRight, Square } from "lucide-react";
import { useCallback } from "react";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { isServiceLive, leaseHolder, serviceStateLabel } from "@/lib/service-state";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/** As the repo's Service panel: often while the task's service runs or starts, rarely otherwise; the list does not ask mise. */
const POLL_LIVE_MS = 1000;
const POLL_IDLE_MS = 5000;

/**
 * The task's service on the repo's port (ADR-132): while the repo root's service runs, "Run on the repo's port" stops
 * it and runs the task's service there, so whatever calls the repo reaches the task's changes; "Give the port back"
 * stops the task's service and the root's starts again. Hidden while neither runs, and while another task holds the port.
 */
export function TaskService({ conn, task }: { conn: Connection; task: Task }) {
  const load = useCallback(() => post(conn, servicesApi.list, {}), [conn]);
  const remote = useRemote(load, { pollMs: (list) => (list?.some(isServiceLive) ? POLL_LIVE_MS : POLL_IDLE_MS) });
  const { repo, id } = task;
  const services = remote.data ?? [];
  const root = services.find((s) => s.repo === repo && s.task === null) ?? null;
  const holder = leaseHolder(services, repo);
  const lease = useAction(
    () => post(conn, servicesApi.start, { repo, task: id, lease: true, dependencies: true, waitMs: 0 }),
    () => remote.reload(),
  );
  const giveBack = useAction(
    () => post(conn, servicesApi.stop, { repo, task: id, dependencies: false }),
    () => remote.reload(),
  );
  const holds = holder?.task === id;
  if (!holds && (holder || !isServiceLive(root))) return null;
  const state = serviceStateLabel(holds ? holder : null);
  const error = lease.error ?? giveBack.error;

  return (
    <section aria-label="Service on the repo's port" className="flex flex-col gap-2 border-b px-4 py-3">
      <span className="hud-label">Service on the repo's port</span>
      <div className="flex items-center gap-3 text-sm">
        <span className="text-muted-foreground min-w-0 flex-1 text-xs">
          {holds ? (
            <StatusLabel tone={state.tone} label={`${state.label}: what calls ${repo} reaches this task`} />
          ) : (
            `${repo} runs from the repo root on port ${root?.port ?? "?"}; run this task's service there instead`
          )}
        </span>
        {holds ? (
          <Button variant="outline" size="sm" onClick={giveBack.run} disabled={giveBack.pending}>
            <Square /> Give the port back
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={lease.run} disabled={lease.pending}>
            <ArrowLeftRight /> Run on the repo's port
          </Button>
        )}
      </div>
      {error && <p className="text-destructive text-xs whitespace-pre-wrap">{error}</p>}
    </section>
  );
}
