import type { SessionEnvironment as Environment } from "@trackwall/protocol";
import { KeyRound, TriangleAlert } from "lucide-react";
import { sessionEnvironmentLines } from "@/lib/session-environment";

/**
 * The line under a session's header about the environment it got from mise (ADR-93): how many variables, which
 * secrets the agent's tools do not get and which they do, and why the session has less than the user expects. Nothing
 * for a task without a session.
 */
export function SessionEnvironment({ environment }: { environment: Environment | undefined }) {
  const lines = environment && sessionEnvironmentLines(environment);
  if (!lines) return null;
  return (
    <section aria-label="Environment from mise" className="flex flex-col gap-1 border-b px-4 py-2 text-xs">
      <p className="flex min-w-0 flex-wrap items-center gap-x-2">
        <KeyRound className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0" title={lines.names}>
          {lines.summary}
        </span>
        {lines.hidden.length > 0 && (
          <span className="text-muted-foreground min-w-0 truncate">
            {"· hidden from the agent's tools: "}
            <span className="font-mono">{lines.hidden.join(", ")}</span>
          </span>
        )}
        {lines.shared.length > 0 && (
          <span className="text-muted-foreground min-w-0 truncate">
            {"· the agent's tools get: "}
            <span className="font-mono">{lines.shared.join(", ")}</span>
          </span>
        )}
      </p>
      {lines.problem && (
        <p className="flex min-w-0 items-start gap-2">
          <TriangleAlert className="text-warning mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="text-muted-foreground whitespace-pre-line">{lines.problem}</span>
        </p>
      )}
    </section>
  );
}
