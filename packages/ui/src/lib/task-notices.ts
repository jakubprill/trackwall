import {
  countLabel,
  type HostedProject,
  type MergeRequest,
  type Task,
  type TaskMessage,
  type TaskMiseConfig,
  type Verification,
} from "@trackwall/protocol";
import { mergeRequestNumber, mergeRequestStateLabel, pipelineLabel } from "./merge-request.ts";

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
  | "service"
  | "mise-runs";

/** `warning` asks the user to act; the others say how something went or that it is there. */
export type TaskNoticeTone = "warning" | "failed" | "passed" | "running" | "info";

export interface TaskNotice {
  section: TaskSection;
  /** Stable while the notice says the same thing; a new key for a warning is a new warning (`newWarnings`). */
  key: string;
  tone: TaskNoticeTone;
  label: string;
  /**
   * The text of a chip of its own in a grid tile's header, for what matters at a glance there: the mise config, whose
   * tasks stop until the user trusts it, a running, passed or failed verification, and the merge request with its
   * pipeline (ADR-154). The rest counts on the badge.
   */
  chip?: string;
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
  /** The merge request from the task branch, once the repo host named one. */
  foundMergeRequest: { project: HostedProject; mergeRequest: MergeRequest } | null;
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
    ...mergeRequestNotices(input.mergeRequest, input.foundMergeRequest),
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
    return [{ section: "mise-config", key: "mise-config:unavailable", tone: "warning", label: "mise tasks cannot run here", chip: "mise" }];
  if (!config || config.changes.length === 0) return [];
  return [
    {
      section: "mise-config",
      key: `mise-config:${config.digest}`,
      tone: "warning",
      label: config.neverTrusted ? "mise config not trusted yet" : "The agent changed the mise config",
      chip: "Trust mise",
    },
  ];
}

function messageNotices(messages: TaskNoticeInput["messages"]): TaskNotice[] {
  if (messages.length === 0) return [];
  const unread = messages.filter((m) => m.readAt === null).length;
  const count = countLabel(messages.length, { one: "message", other: "messages" });
  return [{ section: "messages", key: "messages", tone: "info", label: unread > 0 ? `${count}, ${unread} not read` : count }];
}

const VERIFICATION_NOTICE: Record<Verification["state"], { tone: TaskNoticeTone; label: string; chip?: string }> = {
  running: { tone: "running", label: "Verifying", chip: "Verifying" },
  passed: { tone: "passed", label: "Verification passed", chip: "Passed" },
  failed: { tone: "failed", label: "Verification failed", chip: "Failed" },
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

/** `!12 · pipeline failed` with the pipeline's tone while it is open, the merge request's state once merged or closed. */
function mergeRequestNotices(shown: boolean, found: TaskNoticeInput["foundMergeRequest"]): TaskNotice[] {
  if (!shown) return [];
  if (!found) return [{ section: "merge-request", key: "merge-request", tone: "info", label: "Merge request" }];
  const { project, mergeRequest } = found;
  const number = mergeRequestNumber(project, mergeRequest.number);
  const pipeline = mergeRequest.state === "open" ? mergeRequest.pipeline : null;
  const tone: TaskNoticeTone = pipeline ? PIPELINE_TONE[pipeline.state] : mergeRequest.state === "merged" ? "passed" : "info";
  const state = pipeline ? pipelineLabel(pipeline.state).label : mergeRequestStateLabel(mergeRequest.state).label;
  return [
    {
      section: "merge-request",
      key: "merge-request",
      tone,
      label: `${number} · ${state}`,
      chip: `${number} ${pipeline?.state ?? mergeRequest.state}`,
    },
  ];
}

const PIPELINE_TONE: Record<NonNullable<MergeRequest["pipeline"]>["state"], TaskNoticeTone> = {
  failed: "failed",
  passed: "passed",
  running: "running",
  pending: "running",
  manual: "info",
  cancelled: "info",
  skipped: "info",
};

/** A grid tile's header: the notices with a chip of their own, and the rest for the badge. */
export function tileNotices(notices: readonly TaskNotice[]): { chips: TaskNotice[]; others: TaskNotice[] } {
  return { chips: notices.filter((n) => n.chip !== undefined), others: notices.filter((n) => n.chip === undefined) };
}
