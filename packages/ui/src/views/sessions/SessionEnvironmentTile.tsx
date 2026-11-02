import type { SessionEnvironment } from "@trackwall/protocol";
import { KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ENVIRONMENT_CARD_CLOSED, EnvironmentCard, sessionEnvironmentLines } from "@/lib/session-environment";
import { browserTimers } from "@/lib/timers";
import { cn } from "@/lib/utils";
import { EnvironmentNames, EnvironmentProblem } from "./SessionEnvironment.tsx";
import { TileOverlay } from "./TileOverlay.tsx";

/**
 * The environment on a grid tile (ADR-93): a key badge with the count in the tile's header, yellow when the session
 * got less than its place gives, and a card with every name over the terminal (`TileOverlay`). Hovering shows the
 * card, a click pins it and gives it the keyboard, so that Escape closes it instead of reaching the terminal. The badge
 * is yellow too, and the card says so, when the running session started with another session profile than sessions get
 * now (`profileChange`, ADR-178); the panel offers the restart. Nothing when mise gave the session nothing, nothing went
 * wrong and the profile is the current one.
 */
export function useSessionEnvironmentTile(environment: SessionEnvironment | undefined, profileChange: string | null) {
  const [state, setState] = useState(ENVIRONMENT_CARD_CLOSED);
  const [card] = useState(() => new EnvironmentCard(setState, browserTimers));
  const overlay = useRef<HTMLElement>(null);
  const badge = useRef<HTMLButtonElement>(null);
  const lines = environment && sessionEnvironmentLines(environment);
  const empty = !lines && profileChange === null;
  useEffect(() => () => card.dispose(), [card]);
  useEffect(() => {
    if (empty) card.close();
  }, [card, empty]);
  useEffect(() => {
    if (state.pinned) overlay.current?.focus();
  }, [state.pinned]);
  if (empty) return { badge: null, card: null };
  const warn = (lines?.problem ?? null) !== null || profileChange !== null;
  const label = [lines?.badgeLabel ?? "nothing from mise", profileChange && "the session profile changed"].filter(Boolean).join(", ");
  const close = () => {
    card.close();
    badge.current?.focus();
  };
  const hover = { onMouseEnter: () => card.enter(), onMouseLeave: () => card.leave() };

  return {
    badge: (
      <button
        ref={badge}
        type="button"
        {...hover}
        onClick={() => card.click()}
        aria-expanded={state.open}
        aria-label={`Environment from mise: ${label}`}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-full border px-1.5 text-xs",
          warn ? "border-warning/40 bg-warning/10 text-warning" : "bg-secondary text-muted-foreground hover:text-foreground",
        )}
      >
        <KeyRound className="size-3" aria-hidden />
        {lines?.count ?? 0}
      </button>
    ),
    card: (
      <TileOverlay ref={overlay} open={state.open} label="Environment from mise" onEscape={close} className="text-xs" {...hover}>
        <p className="border-b px-2 py-1">{lines?.summary ?? "Nothing from mise"}</p>
        <div className="flex min-h-0 flex-col gap-1 overflow-y-auto px-2 py-1">
          {profileChange && <EnvironmentProblem problem={`${profileChange}. Open the session to restart it.`} />}
          {lines?.problem && <EnvironmentProblem problem={lines.problem} />}
          {lines && <EnvironmentNames lines={lines} />}
        </div>
        <p className="text-muted-foreground border-t px-2 py-1">Names only. Values are never shown.</p>
      </TileOverlay>
    ),
  };
}
