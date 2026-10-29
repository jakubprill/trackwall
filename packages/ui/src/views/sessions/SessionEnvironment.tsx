import type { SessionEnvironment as Environment } from "@trackwall/protocol";
import { ChevronDown, ChevronUp, KeyRound, TriangleAlert } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";
import {
  ENVIRONMENT_CARD_CLOSED,
  type EnvironmentCardEvent,
  nextEnvironmentCard,
  type SessionEnvironmentLines,
  sessionEnvironmentLines,
} from "@/lib/session-environment";
import { cn } from "@/lib/utils";

/** The card waits a moment before it shows on hover and before it hides, so that passing the mouse over does nothing. */
const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 200;

/**
 * The line under a session's header about the environment it got from mise (ADR-93): how many variables, which
 * secrets the agent's tools do not get and which they do, and why the session has less than the user expects. The
 * count opens every name, grouped as on a grid tile's card. Nothing for a task without a session.
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

/**
 * The environment on a grid tile (ADR-93): a key badge with the count in the tile's header, yellow when the session
 * got less than its place gives, and a card with every name over the terminal, so that the terminal keeps its size.
 * Hovering shows the card, a click pins it. Nothing when mise gave the session nothing and nothing went wrong.
 */
export function useSessionEnvironmentTile(environment: Environment | undefined) {
  const [card, dispatch] = useReducer(nextEnvironmentCard, ENVIRONMENT_CARD_CLOSED);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const lines = environment && sessionEnvironmentLines(environment);
  if (!lines) return { badge: null, card: null };
  const later = (event: EnvironmentCardEvent, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => dispatch(event), ms);
  };
  const now = (event: EnvironmentCardEvent) => {
    clearTimeout(timer.current);
    dispatch(event);
  };
  const hover = {
    onMouseEnter: () => (card.open ? clearTimeout(timer.current) : later("hover", HOVER_OPEN_MS)),
    onMouseLeave: () => later("leave", HOVER_CLOSE_MS),
  };
  const warning = lines.problem !== null;

  return {
    badge: (
      <button
        type="button"
        {...hover}
        onClick={() => now("click")}
        onKeyDown={(event) => {
          if (event.key === "Escape") now("escape");
        }}
        aria-expanded={card.open}
        aria-label={`Environment from mise: ${lines.badgeLabel}`}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-full border px-1.5 text-xs",
          warning ? "border-warning/40 bg-warning/10 text-warning" : "bg-secondary text-muted-foreground hover:text-foreground",
        )}
      >
        <KeyRound className="size-3" aria-hidden />
        {lines.count}
      </button>
    ),
    card: (
      <section
        {...hover}
        hidden={!card.open}
        aria-label="Environment from mise"
        onKeyDown={(event) => {
          if (event.key === "Escape") now("escape");
        }}
        className="bg-card absolute inset-x-1 top-1 z-10 flex max-h-2/3 flex-col overflow-hidden rounded-md border text-xs shadow-lg"
      >
        <p className="border-b px-2 py-1">{lines.summary}</p>
        <div className="flex min-h-0 flex-col gap-1 overflow-y-auto px-2 py-1">
          {lines.problem && <EnvironmentProblem problem={lines.problem} />}
          <EnvironmentNames lines={lines} />
        </div>
        <p className="text-muted-foreground border-t px-2 py-1">Names only. Values are never shown.</p>
      </section>
    ),
  };
}

function EnvironmentProblem({ problem }: { problem: string }) {
  return (
    <p className="flex min-w-0 items-start gap-2">
      <TriangleAlert className="text-warning mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="text-muted-foreground whitespace-pre-line">{problem}</span>
    </p>
  );
}

/** Every variable name in three groups: the secrets the agent's tools get, those hidden from them, the rest. */
function EnvironmentNames({ lines }: { lines: SessionEnvironmentLines }) {
  return (
    <dl className="flex flex-col gap-1">
      <NameGroup title="The agent's tools get" names={lines.shared} />
      <NameGroup title="Hidden from the agent's tools" names={lines.hidden} className="text-muted-foreground line-through" />
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
