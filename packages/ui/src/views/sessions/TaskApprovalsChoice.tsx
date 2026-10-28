import type { TaskApprovals } from "@trackwall/protocol";

/**
 * How a new task's agent answers tool approvals (ADR-105), on the New task form and on a task proposal: unticked it asks
 * the user, as every session does; ticked it runs every tool without asking for the whole task, resumes included.
 */
export function TaskApprovalsChoice({
  label,
  value,
  onChange,
  disabled,
}: {
  /** The accessible name, which names the proposal when there are several. */
  label: string;
  value: TaskApprovals;
  onChange: (value: TaskApprovals) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex w-fit items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="accent-primary size-4 shrink-0"
          aria-label={label}
          checked={value === "auto"}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked ? "auto" : "ask")}
        />
        Run without asking for approvals
      </label>
      {value === "auto" && (
        <p className="text-muted-foreground max-w-prose text-xs">
          The agent runs commands, edits files and calls tools without asking you. Your deny rules still refuse what they name, and Copilot
          CLI still asks before it reaches files outside the worktree or a URL.
        </p>
      )}
    </div>
  );
}
