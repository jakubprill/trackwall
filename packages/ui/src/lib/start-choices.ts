import { SessionView, TASK_MODEL_MAX } from "@trackwall/protocol";
import { z } from "zod";

/**
 * The options of a new task or session that the New session form remembers for each place (a repo id, or `""` for the
 * projects folder), a convenience of this browser profile kept in `localStorage` like the supervisor panel's layout:
 * whether it works in its own worktree, the model text, Java navigation (ADR-99) and the view a task shows in (ADR-137). The approvals mode is not remembered: a task runs without
 * approvals only when the user chooses it for that task (ADR-105). A storage failure or a stored value of another shape
 * reads as the defaults, and a write that fails is forgotten.
 */
const CHOICES_KEY = "trackwall.start-choices";

// Java navigation and the view came later: a choice saved before them keeps its worktree and model, without
// navigation, in a terminal.
const RememberedChoice = z.object({
  worktree: z.boolean(),
  model: z.string().max(TASK_MODEL_MAX),
  javaNavigation: z.boolean().default(false),
  view: SessionView.default("terminal"),
});
export type StartChoice = z.output<typeof RememberedChoice>;
const RememberedChoices = z.record(z.string(), RememberedChoice);

export const DEFAULT_START_CHOICE: StartChoice = { worktree: true, model: "", javaNavigation: false, view: "terminal" };

function readAll(storage: () => Pick<Storage, "getItem">): Record<string, StartChoice> {
  try {
    const text = storage().getItem(CHOICES_KEY);
    if (text === null) return {};
    const parsed = RememberedChoices.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function readStartChoice(storage: () => Pick<Storage, "getItem">, place: string): StartChoice {
  return readAll(storage)[place] ?? DEFAULT_START_CHOICE;
}

export function saveStartChoice(storage: () => Pick<Storage, "getItem" | "setItem">, place: string, choice: StartChoice): void {
  try {
    storage().setItem(CHOICES_KEY, JSON.stringify({ ...readAll(storage), [place]: choice }));
  } catch {
    // The choice holds in this window; only the next form does not remember it.
  }
}
