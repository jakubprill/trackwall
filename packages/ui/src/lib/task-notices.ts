import { countLabel, type Task, type TaskMessage, type TaskMiseConfig, type Verification } from "@trackwall/protocol";

/**
 * The notices of a task: one short line for each section above its terminal (ADR-91), for the strip in the one-entry
 * layout and for the badge and overlay of a grid tile, so both layouts say the same thing. Warnings come first.
 */

/** The task panel's sections above its terminal; a notice names the one it opens. */
export type TaskSection =
  | "included"
  | "shared-files"
  | "mise-config"
  | "messages"
  | "summary"
  | "verification"
  | "merge-request"
  | "mise-runs";

/** `warning` asks the user to act; the others say how something went or that it is there. */
export type TaskNoticeTone = "warning" | "failed" | "passed" | "running" | "info";

export interface TaskNotice {
  section: TaskSection;
  /** Stable while the notice says the same thing; a new key for a warning is a new warning (`newWarnings`). */
  key: string;
  tone: TaskNoticeTone;
  label: string;
}

export interface TaskNoticeInput {
  task: Pick<Task, "included" | "summary">;
  messages: readonly Pick<TaskMessage, "readAt">[];
  /** The other tasks that change the same files, with their names. */
  sharedWith: readonly { task: string; name: string; files: number }[];
  /** The mise config as the panel shows it: `unavailable` when mise cannot run in the worktree at all. */
  miseConfig: TaskMiseConfig | "unavailable" | undefined;
  verification: Verification | null;
  /** Whether the merge request section shows (the task has a commit). */
  mergeRequest: boolean;
  /** The mise tasks running in the worktree that the panel lists. */
  miseRuns: readonly string[];
}

export function taskNotices(input: TaskNoticeInput): TaskNotice[] {
  const notices = [
    ...includedNotices(input.task.included),
    ...input.sharedWith.map(
      (shared): TaskNotice => ({
        section: "shared-files",
        key: `shared-files:${shared.task}`,
        tone: "warning",
        label: `${countLabel(shared.files, { one: "file", other: "files" })} also in “${shared.name}”`,
      }),
    ),
    ...miseConfigNotices(input.miseConfig),
    ...messageNotices(input.messages),
    ...(input.task.summary ? [{ section: "summary", key: "summary", tone: "info", label: "Summary" } as const] : []),
    ...verificationNotices(input.verification),
    ...(input.mergeRequest ? [{ section: "merge-request", key: "merge-request", tone: "info", label: "Merge request" } as const] : []),
    ...input.miseRuns.map(
      (name): TaskNotice => ({ section: "mise-runs", key: `mise-run:${name}`, tone: "running", label: `${name} running` }),
    ),
  ];
  return [...notices.filter((n) => n.tone === "warning"), ...notices.filter((n) => n.tone !== "warning")];
}

function includedNotices({ files, problems }: Task["included"]): TaskNotice[] {
  const notices: TaskNotice[] = [];
  if (problems.length > 0)
    notices.push({
      section: "included",
      key: "included:problems",
      tone: "warning",
      label: `${countLabel(problems.length, { one: "file", other: "files" })} not copied`,
    });
  if (files.length > 0)
    notices.push({
      section: "included",
      key: "included",
      tone: "info",
      label: countLabel(files.length, { one: "included file", other: "included files" }),
    });
  return notices;
}

function miseConfigNotices(config: TaskNoticeInput["miseConfig"]): TaskNotice[] {
  if (config === "unavailable")
    return [{ section: "mise-config", key: "mise-config:unavailable", tone: "warning", label: "mise tasks cannot run here" }];
  if (!config || config.changes.length === 0) return [];
  return [
    {
      section: "mise-config",
      key: `mise-config:${config.digest}`,
      tone: "warning",
      label: config.neverTrusted ? "mise config not trusted yet" : "The agent changed the mise config",
    },
  ];
}

function messageNotices(messages: TaskNoticeInput["messages"]): TaskNotice[] {
  if (messages.length === 0) return [];
  const unread = messages.filter((m) => m.readAt === null).length;
  const count = countLabel(messages.length, { one: "message", other: "messages" });
  return [{ section: "messages", key: "messages", tone: "info", label: unread > 0 ? `${count}, ${unread} not read` : count }];
}

const VERIFICATION_NOTICE: Record<Verification["state"], { tone: TaskNoticeTone; label: string }> = {
  running: { tone: "running", label: "Verifying" },
  passed: { tone: "passed", label: "Verification passed" },
  failed: { tone: "failed", label: "Verification failed" },
  cancelled: { tone: "info", label: "Verification cancelled" },
};

function verificationNotices(verification: Verification | null): TaskNotice[] {
  if (!verification) return [];
  return [{ section: "verification", key: "verification", ...VERIFICATION_NOTICE[verification.state] }];
}

/**
 * The warnings a grid tile shows on its banner: those the user has not seen yet. `seen` holds the keys of the warnings
 * the tile had when its data first came, and of those the user closed or read in the overlay since.
 */
export function newWarnings(notices: readonly TaskNotice[], seen: ReadonlySet<string>): TaskNotice[] {
  return notices.filter((n) => n.tone === "warning" && !seen.has(n.key));
}
