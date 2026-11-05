import { type ProviderModel, type SessionView, TASK_MODEL_MAX, type TaskApprovals } from "@trackwall/protocol";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ProviderModelOptions } from "@/components/ProviderModelOptions";
import { UnofferedModelNote } from "@/components/UnofferedModelNote";
import { Input } from "@/components/ui/input";
import type { SandboxNote } from "@/lib/sandbox";
import { typedModel } from "@/lib/task-model";
import { cn } from "@/lib/utils";

/**
 * The options of a new task or session as one row of pills under its prompt, on the New session form and on a task
 * proposal: each pill shows its state and a click changes it, its explanation is the pill's tooltip, and a pill is there
 * only where the option means something (an approvals mode only for a task in its own worktree, Java navigation only in
 * a repo tagged java; the model and the conversation view for every task and session, ADR-175). A pill the user cannot turn on yet stays visible with the reason
 * in its tooltip. An option
 * that gives up a safeguard (no worktree, no approvals) has a warning dot, and no approvals also its consequences under
 * the row, before the start.
 */
export function StartOptions({
  subject,
  worktree,
  approvals,
  model,
  javaNavigation,
  view,
  sandbox = null,
  disabled,
}: {
  /** What the options belong to, named in every accessible name so that several proposals on one screen keep their controls apart. */
  subject?: string;
  worktree?: { value: boolean; onChange: (value: boolean) => void };
  approvals?: { value: TaskApprovals; onChange: (value: TaskApprovals) => void };
  /** `suggestions`: the models of the session profile's provider (ADR-194), which the field offers as the user types. */
  model?: { value: string; onChange: (value: string) => void; suggestions?: readonly ProviderModel[] };
  /** `unavailable` is why it cannot be turned on now; `null` when it can. */
  javaNavigation?: { value: boolean; onChange: (value: boolean) => void; unavailable: string | null };
  /** Whether the task or session shows as a terminal or in the conversation view (ADR-137), still a preview. */
  view?: { value: SessionView; onChange: (value: SessionView) => void };
  /**
   * Whether the task's commands run in Copilot CLI's sandbox (ADR-181), which `workspace.yaml` decides, not a pill; shown
   * only with `approvals`, for a task, since sessions never run in it.
   */
  sandbox?: SandboxNote;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {worktree && (
          <Pill
            label={named("Own worktree", subject)}
            on={worktree.value}
            risky={!worktree.value}
            disabled={disabled}
            onClick={() => worktree.onChange(!worktree.value)}
            tooltip="A new branch from the default branch in a separate folder: the Changes tab, review, Verify and a merge request work only there. Off, the agent works in the repo's own working copy, where your editor and services are."
          >
            Own worktree
          </Pill>
        )}
        {approvals && (
          <Pill
            label={named("No approvals", subject)}
            on={approvals.value === "auto"}
            risky={approvals.value === "auto"}
            disabled={disabled}
            onClick={() => approvals.onChange(approvals.value === "auto" ? "ask" : "auto")}
            tooltip="The agent runs every tool without asking you, for the whole task and every resume of it."
          >
            No approvals
          </Pill>
        )}
        {model && (
          <ModelPill
            subject={subject}
            value={model.value}
            onChange={model.onChange}
            suggestions={model.suggestions ?? []}
            disabled={disabled}
          />
        )}
        {javaNavigation && (
          <Pill
            label={named("Java navigation", subject)}
            on={javaNavigation.value && javaNavigation.unavailable === null}
            risky={false}
            disabled={disabled}
            unavailable={javaNavigation.unavailable}
            onClick={() => javaNavigation.onChange(!javaNavigation.value)}
            tooltip="The agent gets a Java language server for the code it works on: it finds definitions, usages and implementations instead of searching the text. The first start indexes the project, which takes a minute or more and up to 2 GB of memory."
          >
            Java navigation
          </Pill>
        )}
        {view && (
          <Pill
            label={named("Chat (preview)", subject)}
            on={view.value === "conversation"}
            risky={false}
            disabled={disabled}
            onClick={() => view.onChange(view.value === "conversation" ? "terminal" : "conversation")}
            tooltip="The agent shows as a conversation in Trackwall instead of Copilot CLI's terminal: what you and the agent wrote, its tool calls and approvals, and a message box. Every resume and restart opens it the same way."
          >
            Chat (preview)
          </Pill>
        )}
      </div>
      {approvals?.value === "auto" && (
        <p className="text-warning max-w-prose text-xs">
          The agent runs commands, edits files and calls tools without asking you, also commands such as git push. Your deny rules still
          refuse what they name, and Copilot CLI still asks before paths it sees outside the worktree and before URLs.
        </p>
      )}
      {approvals && sandbox?.kind === "on" && (
        <p className="text-muted-foreground max-w-prose text-xs">
          Its commands run in Copilot CLI's sandbox: they can write only in the task's worktree and cannot see your other repos or
          credential folders.
        </p>
      )}
      {approvals && sandbox?.kind === "unavailable" && (
        <p className="text-destructive max-w-prose text-xs">
          This task should run in Copilot CLI's sandbox, which cannot run on this computer: {sandbox.problem}. Install it, or set
          sandbox.tasks to off in workspace.yaml.
        </p>
      )}
    </div>
  );
}

function Pill({
  label,
  on,
  risky,
  disabled,
  unavailable = null,
  onClick,
  tooltip,
  children,
}: {
  label: string;
  on: boolean;
  risky: boolean;
  disabled: boolean;
  /** Why the option cannot be turned on now: the pill stays focusable, so its tooltip still tells the user, and a click does nothing. */
  unavailable?: string | null;
  onClick: () => void;
  tooltip: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      aria-disabled={unavailable !== null}
      title={unavailable ?? tooltip}
      disabled={disabled}
      onClick={unavailable === null ? onClick : undefined}
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-sm transition-colors disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
        "focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]",
        on ? "border-primary/45 bg-accent text-foreground" : "border-input text-muted-foreground border-dashed",
        risky && "border-warning/55",
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", risky ? "bg-warning" : on ? "bg-primary" : "bg-input")} />
      {children}
    </button>
  );
}

/** An accessible name, followed by what it belongs to when there is more than one such control on the screen. */
function named(label: string, subject: string | undefined): string {
  return subject === undefined ? label : `${label}: ${subject}`;
}

/**
 * A task's model (ADR-98): a pill naming Copilot CLI's default until the user opens it to type a model id; a model the
 * proposer chose, or one remembered for the repo, shows its field at once. The field stays while the user edits it, also
 * when they clear it, and folds back into the pill when left empty. Empty is Copilot CLI's default model. With a session
 * profile's provider, the field suggests its models (ADR-194) and warns about an id it does not offer (ADR-206).
 */
function ModelPill({
  subject,
  value,
  onChange,
  suggestions,
  disabled,
}: {
  subject: string | undefined;
  value: string;
  onChange: (value: string) => void;
  suggestions: readonly ProviderModel[];
  disabled: boolean;
}) {
  const listId = useId();
  const [shown, setShown] = useState(value !== "");
  const opened = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Opened by a click, the field takes the focus once.
    if (shown && opened.current) field.current?.focus();
    opened.current = false;
  }, [shown]);
  if (!shown && value === "")
    return (
      <Pill
        label={`${named("Model for the agent", subject)}: Copilot CLI default`}
        on={false}
        risky={false}
        disabled={disabled}
        onClick={() => {
          opened.current = true;
          setShown(true);
        }}
        tooltip="Copilot CLI's default model. Click to choose another one for this task: it runs on it at every start and resume."
      >
        Model: default
      </Pill>
    );
  const invalid = typedModel(value) === undefined;
  return (
    <span className="border-primary/45 bg-accent inline-flex h-8 items-center gap-2 rounded-full border pr-1 pl-3 text-sm">
      <span className="text-muted-foreground" aria-hidden>
        Model
      </span>
      <Input
        ref={field}
        aria-label={named("Model for the agent", subject)}
        aria-invalid={invalid}
        className="h-6 w-44 rounded-full font-mono text-xs"
        placeholder="Copilot CLI default"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setShown(value !== "")}
        maxLength={TASK_MODEL_MAX}
        spellCheck={false}
        disabled={disabled}
        list={suggestions.length > 0 ? listId : undefined}
      />
      {suggestions.length > 0 && <ProviderModelOptions id={listId} models={suggestions} />}
      {invalid && <span className="text-destructive pr-2 text-xs">A model id, such as claude-opus-5.5</span>}
      <UnofferedModelNote typed={value} models={suggestions} onPick={onChange} className="max-w-xs pr-2" />
    </span>
  );
}
