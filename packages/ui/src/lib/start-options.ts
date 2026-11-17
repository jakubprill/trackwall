import type { SessionView, TaskApprovals } from "@trackwall/protocol";

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

/** An option that differs from a plain start; `risky` when it gives up a safeguard. */
export interface ChosenOption {
  text: string;
  risky: boolean;
}

/** The options that differ from a plain start, in the order of their pills. */
export function chosenOptions(options: MoreOptions): ChosenOption[] {
  const chosen: ChosenOption[] = [];
  const add = (on: boolean | undefined, text: string, risky = false) => {
    if (on) chosen.push({ text, risky });
  };
  add(options.approvals === "auto", "No approvals", true);
  add(options.model.trim() !== "", `Model: ${options.model.trim()}`);
  add(options.javaNavigation, "Java navigation");
  add(options.view === "conversation", "Chat");
  add(options.planFirst, "Plan first");
  add(options.secondAttempt !== undefined && options.secondAttempt !== null, "Second attempt");
  return chosen;
}

/**
 * Whether the folded options show: as the user left them, and until they touch the button, open only when one of them
 * already differs from a plain start (a model remembered for the repo, a view), so that it can be seen and changed.
 */
export function moreOptionsOpen(toggled: boolean | undefined, chosen: readonly ChosenOption[]): boolean {
  return toggled ?? chosen.length > 0;
}
