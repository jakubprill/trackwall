import { type ServiceSlice, servicesApi } from "@trackwall/protocol";
import { Play, Square } from "lucide-react";
import { useCallback, useState } from "react";
import { StatusLabel } from "@/components/StatusLabel";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { isServiceLive, memberLabel, serviceStateLabel } from "@/lib/service-state";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/** Often while a service runs or starts (the user waits for it to be ready), rarely otherwise; the list does not ask mise. */
const POLL_LIVE_MS = 1000;
const POLL_IDLE_MS = 5000;

/**
 * The repo's service (ADR-45): its mise task `dev` with readiness. "Start with dependencies" brings up the services
 * it calls from the graph first; the panel lists them with their live state.
 */
export function RepoService({ conn, repo }: { conn: Connection; repo: string }) {
  const load = useCallback(() => post(conn, servicesApi.list, {}), [conn]);
  const remote = useRemote(load, { pollMs: (list) => (list?.some(isServiceLive) ? POLL_LIVE_MS : POLL_IDLE_MS) });
  const [slice, setSlice] = useState<ServiceSlice>();
  // The services from the repo roots; a task's service (ADR-61) shows in its task's panel through its mise task `dev`.
  const byRepo = new Map((remote.data ?? []).filter((s) => s.task === null).map((s) => [s.repo, s]));
  const service = byRepo.get(repo) ?? null;
  const live = isServiceLive(service);
  const start = useAction(
    () => post(conn, servicesApi.start, { repo, task: null, dependencies: true, waitMs: 0 }),
    (started) => {
      setSlice(started);
      remote.reload();
    },
  );
  const stop = useAction(
    () => post(conn, servicesApi.stop, { repo, task: null, dependencies: true }),
    () => remote.reload(),
  );
  const state = serviceStateLabel(service);
  const dependencies = slice?.members.filter((m) => m.repo !== repo) ?? [];
  const error = start.error ?? stop.error;

  return (
    <Surface label="Service" meta="mise run dev">
      <div className="flex flex-col gap-2 px-3 py-2 text-sm">
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1 text-xs">
            <StatusLabel tone={state.tone} label={state.label} />
          </span>
          {live ? (
            <Button variant="outline" size="sm" onClick={stop.run} disabled={stop.pending}>
              <Square /> Stop with dependencies
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={start.run} disabled={start.pending}>
              <Play /> Start with dependencies
            </Button>
          )}
        </div>
        {service?.reason && <p className="text-muted-foreground text-xs">{service.reason}</p>}
        {dependencies.length > 0 && (
          <ul className="flex flex-col gap-1">
            {dependencies.map((member) => {
              const label = memberLabel(member, byRepo.get(member.repo) ?? null);
              return (
                <li key={member.repo} className="flex items-center gap-3 text-xs">
                  <code className="text-primary min-w-0 truncate">{member.repo}</code>
                  <StatusLabel tone={label.tone} label={label.label} />
                </li>
              );
            })}
          </ul>
        )}
        {error && <p className="text-destructive text-xs whitespace-pre-wrap">{error}</p>}
      </div>
    </Surface>
  );
}
