import type { SessionEnvironment as Environment } from "@trackwall/protocol";
import { ChevronDown, ChevronUp, KeyRound, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { type SessionEnvironmentLines, sessionEnvironmentLines } from "@/lib/session-environment";
import { cn } from "@/lib/utils";

/**
 * The line under a session's header about the environment it got from mise (ADR-93): how many variables, which
 * secrets the agent's tools do not get and which they do, and why the session has less than the user expects. The
 * count opens every name, grouped as on a grid tile's card (`useSessionEnvironmentTile`). Nothing for a task without a session.
 */
export function SessionEnvironment({ environment }: { environment: Environment | undefined }) {
  const [open, setOpen] = useState(false);
  const lines = environment && sessionEnvironmentLines(environment);
  if (!lines) return null;
  return (
    <section aria-label="Environment from mise" className="flex flex-col gap-1 border-b px-4 py-2 text-xs">
      <p className="flex min-w-0 flex-wrap items-center gap-x-2">
        <KeyRound className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
        <button
          type="button"
          className="hover:text-foreground flex shrink-0 items-center gap-1 rounded-sm"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {lines.summary}
          {open ? <ChevronUp className="size-3" aria-hidden /> : <ChevronDown className="size-3" aria-hidden />}
        </button>
        {!open && lines.hidden.length > 0 && (
          <span className="text-muted-foreground min-w-0 truncate">
            {"· hidden from the agent's tools: "}
            <span className="font-mono">{lines.hidden.join(", ")}</span>
          </span>
        )}
        {!open && lines.shared.length > 0 && (
          <span className="text-muted-foreground min-w-0 truncate">
            {"· the agent's tools get: "}
            <span className="font-mono">{lines.shared.join(", ")}</span>
          </span>
        )}
      </p>
      {lines.problem && <EnvironmentProblem problem={lines.problem} />}
      {open && <EnvironmentNames lines={lines} />}
    </section>
  );
}

export function EnvironmentProblem({ problem }: { problem: string }) {
  return (
    <p className="flex min-w-0 items-start gap-2">
      <TriangleAlert className="text-warning mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="text-muted-foreground whitespace-pre-line">{problem}</span>
    </p>
  );
}

/** Every variable name in three groups: the secrets the agent's tools get, those hidden from them, the rest. */
export function EnvironmentNames({ lines }: { lines: SessionEnvironmentLines }) {
  return (
    <dl className="flex flex-col gap-1">
      <NameGroup title="The agent's tools get" names={lines.shared} />
      <NameGroup title="Hidden from the agent's tools" names={lines.hidden} className="text-muted-foreground" />
      <NameGroup title="Other variables" names={lines.other} />
    </dl>
  );
}

function NameGroup({ title, names, className }: { title: string; names: readonly string[]; className?: string }) {
  if (names.length === 0) return null;
  return (
    <div>
      <dt className="text-muted-foreground text-2xs tracking-wide uppercase">{title}</dt>
      <dd className={cn("flex flex-wrap gap-x-3 font-mono break-all", className)}>
        {names.map((name) => (
          <span key={name}>{name}</span>
        ))}
      </dd>
    </div>
  );
}
