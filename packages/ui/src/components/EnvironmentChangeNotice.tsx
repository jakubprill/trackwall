import { agentsApi, type Session } from "@trackwall/protocol";
import { RotateCw } from "lucide-react";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { environmentChangeParts, RESTART_WAITS_FOR_TURN } from "@/lib/environment-change";
import { closeCutsOffTurn } from "@/lib/session-state";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/** Each check asks mise again in the session's place, which takes a moment on a slow Windows machine. */
const CHECK_MS = 15_000;

/**
 * The strip under a running session's header when mise would give it another environment than it started with
 * (ADR-119), e.g. a new token in `mise.toml` or a name added to `agentSecrets`, with the restart that applies it. The
 * strip stays while the restart runs and when it fails, since the stop already ended the session it checked.
 */
export function EnvironmentChangeNotice({
  conn,
  session,
  onRestarted,
}: {
  conn: Connection;
  session: Session | undefined;
  onRestarted: () => void;
}) {
  const running = session?.run.kind === "running" ? session : undefined;
  const id = running?.id ?? "";
  const load = useCallback(() => post(conn, agentsApi.environmentChange, { session: id }), [conn, id]);
  const check = useRemote(running ? load : undefined, { pollMs: CHECK_MS });
  const restart = useAction(
    () => post(conn, agentsApi.restart, { session: id }),
    () => {
      check.reload();
      onRestarted();
    },
  );
  const change = running ? check.data?.change : null;
  if (!change && !restart.pending && !restart.error) return null;
  const inTurn = running !== undefined && closeCutsOffTurn(running);
  return (
    <section aria-label="Environment changed" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-1.5 text-xs">
      <RotateCw className="text-warning size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0">The environment from mise changed since the session started</span>
      {change && <span className="text-muted-foreground min-w-0 truncate font-mono">{environmentChangeParts(change).join(" · ")}</span>}
      {restart.error && <span className="text-destructive min-w-0 truncate">{restart.error}</span>}
      <Button
        variant="outline"
        size="sm"
        className="ml-auto"
        onClick={restart.run}
        disabled={restart.pending || inTurn || running === undefined}
        title={inTurn ? RESTART_WAITS_FOR_TURN : "Stop the session and start it again with the same conversation and the new environment"}
      >
        <RotateCw /> Restart to apply
      </Button>
    </section>
  );
}
