import { type SandboxSettings, type SandboxState, sandboxesTask, type TaskApprovals } from "@trackwall/protocol";

/**
 * What the New session form says about Copilot CLI's sandbox for the task being started (ADR-181): `on` when its
 * commands will run in the sandbox, `unavailable` when they should and the sandbox cannot run on this computer, so the
 * daemon will refuse the start; `null` for a task outside the sandbox, or before the daemon answered.
 */
export type SandboxNote = { kind: "on" } | { kind: "unavailable"; problem: string } | null;

export function sandboxNote(state: SandboxState | undefined, approvals: TaskApprovals): SandboxNote {
  if (state === undefined || !sandboxesTask(state.tasks, approvals)) return null;
  return state.problem === null ? { kind: "on" } : { kind: "unavailable", problem: state.problem };
}

/** A choice in Settings › Agents › Sandbox (ADR-239): one of `sandbox.tasks`, or `default` for no key in `workspace.yaml`. */
export type SandboxChoice = SandboxSettings["tasks"] | "default";

export const SANDBOX_CHOICES = [
  { choice: "default", label: "Trackwall's default for this computer" },
  { choice: "auto", label: "Tasks without approvals" },
  { choice: "all", label: "Every task" },
  { choice: "off", label: "No task" },
] as const satisfies readonly { choice: SandboxChoice; label: string }[];

/** The choice `sandbox` in `workspace.yaml` stands for; `null` is no key. */
export function sandboxChoice(settings: SandboxSettings | null): SandboxChoice {
  return settings === null ? "default" : settings.tasks;
}

/** `sandbox` to save for `choice`; `null` removes the key. */
export function sandboxSettingsOf(choice: SandboxChoice): SandboxSettings | null {
  return choice === "default" ? null : { tasks: choice };
}

const WHICH_TASKS: Record<SandboxSettings["tasks"], string> = {
  auto: "Tasks you start without approvals run their commands in the sandbox",
  all: "Every task you start runs its commands in the sandbox",
  off: "No task you start runs its commands in the sandbox",
};

/**
 * What the sandbox means for the next task, under the choice in Settings: which tasks run in it (saying when that is the
 * default here), and, when the sandbox cannot run on this computer, why; `refused` when tasks that should run in it will
 * be refused rather than only left outside it.
 */
export function sandboxNow(state: SandboxState): { text: string; problem: { text: string; refused: boolean } | null } {
  const text = `${WHICH_TASKS[state.tasks]}${state.chosen ? "." : ", Trackwall's default here."}`;
  if (state.problem === null) return { text, problem: null };
  const cannotRun = `The sandbox cannot run on this computer: ${state.problem}.`;
  return state.tasks === "off"
    ? { text, problem: { text: cannotRun, refused: false } }
    : {
        text,
        problem: {
          text: `${cannotRun} Trackwall refuses to start these tasks until you install what it needs or choose "No task".`,
          refused: true,
        },
      };
}
