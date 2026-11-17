import type { SessionView, TaskApprovals } from "@trackwall/protocol";
import { typedModel } from "./task-model.ts";

/**
 * The New session form shows what every start needs (where, the prompt, whether it gets its own worktree) and keeps
 * the rest of its options folded under "More options" (ADR-266). Folded, the button names the options that differ from a
 * plain start, so nothing that changes how the agent runs is out of sight.
 */

/** The folded options as the form holds them; an option the form does not offer at this start is left out. */
export interface MoreOptions {
  approvals?: TaskApprovals;
  /** The model text as typed; empty is Copilot CLI's default. */
  model: string;
  javaNavigation?: boolean;
  view: SessionView;
  planFirst?: boolean;
  /** `null` when off, else the second attempt's model text, empty for the task's own model. */
  secondAttempt?: string | null;
}

/** An option that differs from a plain start; `risky` when it gives up a safeguard, `invalid` when it holds the start. */
export interface ChosenOption {
  text: string;
  risky: boolean;
  invalid: boolean;
}

/** The options that differ from a plain start, in the order of their pills. */
export function chosenOptions(options: MoreOptions): ChosenOption[] {
  const chosen: ChosenOption[] = [];
  const add = (on: boolean | undefined, text: string, { risky = false, invalid = false } = {}) => {
    if (on) chosen.push({ text, risky, invalid });
  };
  const second = options.secondAttempt ?? null;
  add(options.approvals === "auto", "No approvals", { risky: true });
  add(options.model.trim() !== "", `Model: ${options.model.trim()}`, { invalid: typedModel(options.model) === undefined });
  add(options.javaNavigation, "Java navigation");
  add(options.view === "conversation", "Chat");
  add(options.planFirst, "Plan first");
  add(second !== null, "Second attempt", { invalid: second !== null && second.trim() !== "" && typedModel(second) === undefined });
  return chosen;
}

/**
 * Whether the folded options show: as the user left them, and until they touch the button, open only when one of them
 * already differs from a plain start (a model remembered for the repo, a view), so that it can be seen and changed.
 * A model that is no model id holds the start, so the options cannot be folded over it.
 */
export function moreOptionsOpen(toggled: boolean | undefined, chosen: readonly ChosenOption[]): boolean {
  return chosen.some((option) => option.invalid) || (toggled ?? chosen.length > 0);
}
