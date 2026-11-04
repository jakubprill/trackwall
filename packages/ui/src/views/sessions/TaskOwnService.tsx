import type { Service } from "@trackwall/protocol";
import { useContext } from "react";
import { OpenServiceButton } from "@/components/OpenServiceButton";
import { StatusLabel } from "@/components/StatusLabel";
import type { Connection } from "@/lib/connection";
import { DaemonPlaceContext } from "@/lib/desktop";
import { serviceLink, serviceStateLabel } from "@/lib/service-state";

/**
 * The task's own service while it is ready, on the task port or the repo's: its state and Open, which shows it in the
 * browser (ADR-189). Nothing otherwise; a task's service runs from its `dev` mise task.
 */
export function TaskOwnService({ conn, service }: { conn: Connection; service: Service | null }) {
  const link = serviceLink(useContext(DaemonPlaceContext), service);
  if (!link) return null;
  const state = serviceStateLabel(service);
  return (
    <section aria-label="This task's service" className="flex flex-col gap-2 border-b px-4 py-3">
      <span className="hud-label">This task's service</span>
      <div className="flex items-center gap-3 text-sm">
        <span className="min-w-0 flex-1 text-xs">
          <StatusLabel tone={state.tone} label={state.label} />
        </span>
        <OpenServiceButton conn={conn} link={link} />
      </div>
    </section>
  );
}
