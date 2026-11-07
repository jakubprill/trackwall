import { z } from "zod";
import { apiEndpoints, Done } from "./api.ts";
import { BoardItemId } from "./board.ts";
import { WorkingTreeChanges } from "./changes.ts";
import {
  ConversationModeId,
  MessageAttachments,
  SESSION_MESSAGE_BODY_MAX_BYTES,
  SessionMessage,
  SessionView,
  TOOL_FILE_PATH_MAX,
  ToolPatch,
} from "./conversation.ts";
import { CopilotUsage } from "./copilot-usage.ts";
import { RunState } from "./procs.ts";
import { REVIEW_COMMENTS_MAX, ReviewComment } from "./review.ts";
import { singleLine } from "./single-line.ts";
import { TaskModel } from "./task-model.ts";
import { TaskStateChange } from "./task-state.ts";
import { CommitHash, RepoId, SandboxSettings } from "./workspace.ts";

/**
 * Contract of the `agents` module (§4.4, ADR-26): Copilot CLI sessions in a PTY owned by the daemon, several at once. Every
 * action is `POST /api/agents/<action>`, and a session terminal is the WebSocket `/ws/pty/<session>` (§5.2). The client
 * names a repo by its identifier; the daemon builds the Copilot CLI command (§1.2).
 */

export const SessionId = z.uuid();
export type SessionId = z.infer<typeof SessionId>;

/** A task (ADR-31): a prompt for an agent in its own worktree on its own branch. The task's Copilot CLI session has the same UUID. */
export const TaskId = z.uuid();
export type TaskId = z.infer<typeof TaskId>;

/**
 * Task ports (ADR-61): every task gets its own port from this range for as long as it exists, the lowest one no other
 * task holds, so the services of several tasks and of the repo root can run at once. The range lies below the dynamic
 * ports Windows and macOS hand out to outgoing connections (49152 and up; 32768 and up on Linux).
 */
export const TASK_PORT_FIRST = 41000;
export const TASK_PORT_LAST = 41999;
export const TaskPort = z.number().int().min(TASK_PORT_FIRST).max(TASK_PORT_LAST);

/**
 * The variables a mise task in a task worktree gets set to the task port (ADR-61): `SERVER_PORT` for Spring Boot
 * (`server.port`), `PORT` for Node servers and dev servers that read it.
 */
export const TASK_PORT_ENV = ["SERVER_PORT", "PORT"] as const;

/**
 * The file in a repo root that names files git ignores to copy into every new task worktree (ADR-61): local config,
 * `.env`, `mise.local.toml`. `.gitignore` syntax, the same file Claude Code reads; it may itself be ignored or untracked.
 */
export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

/**
 * Files from `WORKTREE_INCLUDE_FILE` copied from the repo root into a task's worktree when the task was created, as
 * paths relative to the root with `/` (ADR-61), and in `problems` what was not copied and why, one sentence each.
 */
export const IncludedFiles = z.object({ files: z.array(z.string()), problems: z.array(z.string()) });
export type IncludedFiles = z.infer<typeof IncludedFiles>;

/** A root without `WORKTREE_INCLUDE_FILE`, and a task saved before ADR-61; a new object each time, as tasks own theirs. */
export function noIncludedFiles(): IncludedFiles {
  return { files: [], problems: [] };
}

/**
 * The task prompt. It goes to Copilot CLI as one argument (`--interactive=<prompt>`), and the Windows command line holds
 * 32,767 characters together with the rest of the command.
 */
export const TASK_PROMPT_MAX = 8000;
export const TaskPrompt = z.string().trim().min(1).max(TASK_PROMPT_MAX);
/** The longest reason for rejecting a task proposal (ADR-55): a few sentences for the session that proposed it. */
export const REJECTION_REASON_MAX = 1000;

/**
 * Task title (ADR-39): a short description in the session list, given by the session that proposes the task, like a
 * thread title. One line without control characters, because the UI shows it as text on a single line.
 */
export const TASK_TITLE_MAX = 80;
export const TaskTitle = singleLine(z.string().trim().min(1).max(TASK_TITLE_MAX), "the title");

/**
 * A change (ADR-171): one piece of work across several repos, one task per repo, which the user starts at once. Its
 * parts share one branch name, so their merge requests show together on the repo host, and each part's session knows
 * the others from Trackwall's list. A change is no record of its own: it is the tasks that carry its id, and it ends
 * when its last part does. `position` is the part's place in the order its merge requests are to be merged, which is
 * only information for the user: nothing waits for it and nothing merges (ADR-9).
 */
export const CHANGE_PARTS_MAX = 6;
export const ChangeId = z.uuid();
export const TaskChange = z.object({
  id: ChangeId,
  position: z
    .number()
    .int()
    .min(0)
    .max(CHANGE_PARTS_MAX - 1),
});
export type TaskChange = z.infer<typeof TaskChange>;

/** What one part of a change adds to the prompt of the whole: what its repo has to do, when the user said so. */
export const CHANGE_PART_NOTE_MAX = 1000;
export const ChangePartNote = z.string().trim().max(CHANGE_PART_NOTE_MAX);
export const ChangePart = z.object({ repo: RepoId, note: ChangePartNote.default("") }).strict();
export type ChangePart = z.infer<typeof ChangePart>;

/** A part's prompt: the change's, then the part's note with its repo, so its session reads both in its first message. */
export function changePartPrompt(prompt: string, { repo, note }: ChangePart): string {
  return note === "" ? prompt : `${prompt}\n\nIn ${repo}: ${note}`;
}

export const ONE_PART_PER_REPO = "a change has one part per repo";
export function onePartPerRepo(parts: readonly { repo: string }[]): boolean {
  return new Set(parts.map((p) => p.repo)).size === parts.length;
}

/** The parts of a change in their merge order, each part as `part` reads it: 2 to `CHANGE_PARTS_MAX`, one per repo. */
export function changeParts<Part extends z.ZodType<{ repo: string }>>(part: Part) {
  return z.array(part).min(2).max(CHANGE_PARTS_MAX).refine(onePartPerRepo, ONE_PART_PER_REPO);
}
export const ChangeParts = changeParts(ChangePart);

/** Whether every part's prompt, the change's with the part's note, fits a task's prompt. */
export function changePromptsFit(prompt: string, parts: readonly ChangePart[]): boolean {
  return parts.every((part) => changePartPrompt(prompt, part).length <= TASK_PROMPT_MAX);
}
export const CHANGE_PROMPTS_TOO_LONG = `a part's prompt with its note is at most ${TASK_PROMPT_MAX} characters`;

/** The characters the UI does not show but a model reads or a paste carries (`visibleText`). */
const INVISIBLE_CHARACTERS = /[\p{Cf}\p{Co}\u2028\u2029]/gu;

function hasInvisibleCharacter(text: string): boolean {
  return new RegExp(INVISIBLE_CHARACTERS.source, "u").test(text);
}

/** The text without the characters `visibleText` refuses: for model text the daemon keeps rather than refuses whole (ADR-182). */
export function withoutInvisibleCharacters(text: string): string {
  return text.replace(INVISIBLE_CHARACTERS, "");
}

/**
 * Text from an agent that a person reads before a decision or that reaches another agent (a task proposal, a summary,
 * ADR-39): without characters the UI does not show but a model reads (format characters, including the tags
 * U+E0000–E007F and text direction changes, private use and line separators; not unassigned ones, because what is
 * unassigned depends on the engine's Unicode tables, and Bun and Node have different ones). Otherwise a prompt that
 * looks innocent in the panel could carry hidden instructions for the task session (§8). Text typed in the UI does not
 * need this, because the person writes it themselves.
 */
export function visibleText(text: z.ZodString): z.ZodString {
  // `refine` instead of `regex`: the pattern would go into the MCP tool's JSON Schema, and a client that compiles it
  // without the `u` flag would read `\p{Cf}` as plain letters and reject ordinary text.
  return text.refine((value) => !hasInvisibleCharacter(value), {
    message: "the text must not contain invisible characters (format or private-use characters, line separators)",
  });
}

/**
 * How a task's sessions answer tool approvals (ADR-105): `ask`, Copilot CLI asks the user before each tool its rules do not
 * already allow; `auto`, it runs every tool without asking (`--allow-all-tools`) on every start and resume, shell commands
 * such as `git push` included. `deny` rules from `toolPermissions` still refuse, and Copilot CLI still asks before a path
 * it recognises outside the worktree and before a URL.
 */
export const TaskApprovals = z.enum(["ask", "auto"]);
export type TaskApprovals = z.infer<typeof TaskApprovals>;

/**
 * A task summary from its session (`report_result`, ADR-39): what it did and what is left, for the session that delegated
 * the task and as the merge request's description, which holds `MERGE_REQUEST_DESCRIPTION_MAX` characters together with
 * the check steps and the verification verdict.
 */
export const TASK_SUMMARY_MAX = 4000;
export const TaskSummaryText = z.string().trim().min(1).max(TASK_SUMMARY_MAX);
/**
 * The length a session is asked to aim for, in words, because a model keeps to a word count better than to characters;
 * well under the limit, so that the check steps and the verdict still fit the merge request's description after it.
 */
export const TASK_SUMMARY_WORDS = 300;

/**
 * How to check the change by hand (ADR-169): short steps with what the user should see, such as "Open /orders and press
 * Save: a toast says Saved". Only information next to the summary, never a gate: the user may follow them or not, and no
 * state of the task waits for them. Kept as separate steps, so that a later automated check can run them one by one.
 */
export const TASK_CHECK_STEP_MAX = 300;
export const TASK_CHECK_STEPS_MAX = 8;
export const TaskCheckStep = singleLine(z.string().trim().min(1).max(TASK_CHECK_STEP_MAX), "a check step");

/** The last summary from the task session (`report_result`, ADR-39) with its check steps (ADR-169), empty when it gave none. */
export const TaskSummary = z.object({ text: z.string(), checkSteps: z.array(z.string()), reportedAt: z.string() });
export type TaskSummary = z.infer<typeof TaskSummary>;

/**
 * Who proposed the task (ADR-39): a Trackwall session by its session token, or `null` for an agent outside Trackwall
 * (a supervising agent with the daemon token).
 */
export const ProposedBy = z.object({
  /**
   * The proposing session: `null` for an agent outside Trackwall, for a task the user handed on from another task's
   * impact (ADR-147), which names that `task`, and for a task the user handed to the supervisor (ADR-155), which has
   * `supervisor: true`. A supervisor's own proposal always names its session, so that pair means the handover.
   */
  session: SessionId.nullable(),
  /**
   * The proposing session was the supervisor (ADR-58). Kept with the task, so that the supervisor's work stays under
   * it in the Sessions view after the supervisor session that proposed it is gone (closed, or the daemon restarted).
   * Absent in task files from before ADR-58.
   */
  supervisor: z.boolean().default(false),
  /**
   * The task whose session proposed it (ADR-140): a task's later sessions, after a resume or a daemon restart, are its
   * proposer too, since they go on with the same conversation in the same worktree. Absent in files from before ADR-140,
   * whose work no task session reaches any more.
   */
  task: TaskId.nullable().default(null),
});
export type ProposedBy = z.infer<typeof ProposedBy>;

/** One choice of an agent dialog: the digit Copilot CLI shows before it, which selects it, and its label as on the screen. */
export const AgentDialogOption = z.object({ key: z.string().regex(/^[1-9]$/), label: z.string() });
export type AgentDialogOption = z.infer<typeof AgentDialogOption>;

/** A digest of the dialog and of the wait it belongs to: an answer names it, so it never goes into a later request. */
const AgentDialogId = z.string();

/**
 * An approval request (run a command, write a file), answered from outside the terminal with one of `options` or
 * stopped. The texts are cut screen text the agent produced, so the UI shows them as plain text.
 */
export const AgentApproval = z.object({
  id: AgentDialogId,
  kind: z.literal("approval"),
  /** The dialog's heading, e.g. the tool's description ("Create file"). */
  title: z.string(),
  /** What the dialog shows between the heading and the question: the command, the file and its lines. */
  detail: z.array(z.string()),
  /**
   * The change to a file the approval allows, as a unified diff: only over ACP (ADR-107), where Copilot CLI sends it
   * as data, while an approval read from the screen has the lines of the change in `detail`.
   */
  patch: ToolPatch.optional(),
  /** The change was longer than its `patch`, which is its beginning. */
  patchCut: z.boolean().optional(),
  /** "Do you want to run this command?" */
  question: z.string(),
  /** The choices that answer the dialog at once with their digit; without "No, and tell Copilot…", which needs text typed in the terminal. */
  options: z.array(AgentDialogOption),
});
export type AgentApproval = z.infer<typeof AgentApproval>;

/** A question from the agent (its form): only shown, the user answers it in the session terminal. */
export const AgentQuestion = z.object({ id: AgentDialogId, kind: z.literal("question"), question: z.string() });
export type AgentQuestion = z.infer<typeof AgentQuestion>;

/** An agent dialog (ADR-66): what Copilot CLI asks on the session's screen, as the daemon reads it from the screen image. */
export const AgentDialog = z.discriminatedUnion("kind", [AgentApproval, AgentQuestion]);
export type AgentDialog = z.infer<typeof AgentDialog>;

/** An answer to an agent dialog: an option's digit, or `stop`, which is Esc: the agent stops its turn and waits for you. */
export const DialogAnswer = z.union([AgentDialogOption.shape.key, z.literal("stop")]);
export type DialogAnswer = z.infer<typeof DialogAnswer>;

/**
 * What a session got from mise when it started (ADR-93): the variables of the mise `[env]` of its place (a task's
 * worktree, the repo root or the projects folder), by name only, never with values.
 */
export const SessionEnvironment = z.object({
  /** The names of the variables mise set for the session. */
  variables: z.array(z.string()),
  /** The names among `variables` that are secrets; the daemon masks their values in what it keeps of the session. */
  secrets: z.array(z.string()),
  /**
   * The secrets the session's tools get (its shell commands and the MCP servers Copilot CLI starts), because the user
   * named them in `agentSecrets`; Copilot CLI hides the other secrets from them.
   */
  agentSecrets: z.array(z.string()),
  /** The session profile it started with (`MISE_ENV`, ADR-136); `null` without one. */
  profile: z.string().nullable(),
  /**
   * Why the session got less than its place gives, e.g. a mise config that is not trusted or an age key that is missing;
   * `null` when nothing is missing (also without mise).
   */
  problem: z.string().nullable(),
});
export type SessionEnvironment = z.infer<typeof SessionEnvironment>;

/**
 * How the environment a running session would get from mise now differs from the one it started with (ADR-119), by
 * name only: Copilot CLI reads its environment once, so the session needs a restart to get the new one.
 */
export const EnvironmentChange = z.object({
  /** Variables mise sets now that the session does not have. */
  added: z.array(z.string()),
  /** Variables the session has that mise no longer sets. */
  removed: z.array(z.string()),
  /** Variables whose value changed, e.g. a new token. */
  changed: z.array(z.string()),
  /** Variables the agent's tools would get now and do not: a secret added to `agentSecrets`, or one mise no longer redacts. */
  shared: z.array(z.string()),
  /** Variables the agent's tools have and would no longer get: a secret taken out of `agentSecrets`, or one mise now redacts. */
  unshared: z.array(z.string()),
});
export type EnvironmentChange = z.infer<typeof EnvironmentChange>;

/** The answer of `environment-change`: `null` while the session's environment is the one it would get now. */
export const EnvironmentCheck = z.object({ change: EnvironmentChange.nullable() });
export type EnvironmentCheck = z.infer<typeof EnvironmentCheck>;

/**
 * The user handed a task they started to the supervisor (ADR-155, `hand-to-supervisor`): the task is the supervisor's
 * work from then on, like one it proposed, with no proposing session.
 */
export const HANDED_TO_SUPERVISOR: Readonly<ProposedBy> = Object.freeze({ session: null, supervisor: true, task: null });

/** A task the user handed to the supervisor (ADR-155): a supervisor's work that no supervisor session proposed. */
export function handedToSupervisor(proposedBy: ProposedBy): boolean {
  return proposedBy.supervisor && proposedBy.session === null;
}

/** Only a task the user started themselves can be handed to the supervisor (ADR-155): other work already has a proposer. */
export function mayHandToSupervisor(task: Pick<Task, "proposedBy">): boolean {
  return task.proposedBy === null;
}

/**
 * Why a read request (ADR-159) has not been taken yet: `sent` it was typed or given through a hook and the agent has
 * not read it; `pending` it goes in as soon as the agent can take it (with a tool's result, when its turn ends, once the
 * input box is back); `user_text` there is text in the input box, the user's or a prompt given up on; `dialog` the agent
 * asks something on the screen; `idle` nothing will send it until the next message or update, or the user's Deliver now.
 */
export const ReadRequestHold = z.enum(["sent", "pending", "user_text", "dialog", "idle"]);
export type ReadRequestHold = z.infer<typeof ReadRequestHold>;

/**
 * The read request (ADR-159): the daemon's prompt asking a session's agent to read what waits unread for it (a review,
 * task messages, task updates, a handoff, a trust notice), since when it has waited and what holds it back.
 */
export const ReadRequest = z.object({
  /** The daemon's prompt, which names the tools with something unread. */
  prompt: z.string(),
  /** ISO 8601: since when something has waited unread without a break. */
  since: z.string(),
  waitsFor: ReadRequestHold,
});
export type ReadRequest = z.infer<typeof ReadRequest>;

/**
 * The longest text an agent can ask to copy (ADR-180): more than a command or a snippet needs. The text travels in every
 * session list the UI gets, because Copy must write the clipboard inside the click, so it is kept small.
 */
export const COPY_TEXT_MAX = 10_000;

/**
 * Whether text may go to the user's clipboard from an agent (ADR-180), by `copy_to_clipboard` or by OSC 52 in a session
 * terminal: no control characters but line breaks and tabs, so that a paste into a terminal cannot carry an escape
 * sequence (one that ends a bracketed paste would run the rest as typed keys), and no invisible characters (format,
 * private use, line separators, as in `visibleText`), so the user pastes what they read.
 */
export function copyableText(text: string): boolean {
  return !/[^\P{Cc}\n\r\t]/u.test(text) && !hasInvisibleCharacter(text);
}

export const CopyText = z
  .string()
  .min(1)
  .max(COPY_TEXT_MAX)
  // `refine` instead of `regex`, as in `visibleText`: the pattern would go into the MCP tool's JSON Schema.
  .refine(copyableText, {
    message: "the text must not contain control characters other than line breaks and tabs, nor invisible characters",
  });
export const CopyRequestId = z.string().min(1).max(64);

/**
 * A copy request (ADR-180): text a session's agent asked to put on the user's clipboard with `copy_to_clipboard`. The
 * clipboard changes only when the user clicks Copy in the session's panel, so an agent never swaps what the user pastes
 * on its own, and a daemon in a container, which has no clipboard of the user's, needs no access to the host for it.
 */
export const CopyRequest = z.object({
  id: CopyRequestId,
  text: CopyText,
  /** ISO 8601: when the agent asked. */
  at: z.iso.datetime(),
});
export type CopyRequest = z.infer<typeof CopyRequest>;

/**
 * A session that may be stuck (ADR-151): it is in the middle of a turn (`Working`, or `Stale`) and no step of its agent
 * came for a long time: no hook in a terminal (a finished tool, a prompt, a notification), no update over ACP, no key
 * from the user. Copilot CLI keeps drawing its spinner while a command hangs, so the output alone does not tell; a
 * command that never ends, a server started in the foreground or a shell waiting for input look like this.
 */
export const SessionStuck = z.object({
  /** ISO 8601: the agent's last step. */
  lastStepAt: z.iso.datetime(),
});
export type SessionStuck = z.infer<typeof SessionStuck>;

export const Session = z.object({
  id: SessionId,
  /**
   * The repo the session works in; `null` in the projects folder above all repos: the supervisor (ADR-58) or a free
   * session (ADR-100).
   */
  repo: RepoId.nullable(),
  /** The supervisor (ADR-58); a session in the projects folder without it is a free session (ADR-100). */
  supervisor: z.boolean(),
  /** ISO 8601. */
  startedAt: z.string(),
  /** The session's process group: `running`, `stopping`, and after the end the exit code and the last screen lines. */
  run: RunState,
  /** The last state change; `null` until the session has given any signal. */
  state: TaskStateChange.nullable(),
  /** Window title from OSC 0 / 2: what the agent is working on. */
  windowTitle: z.string().nullable(),
  /**
   * Waiting for you: the session runs and is in `Approval` or `Plan`, or in `Input` the user has not seen yet (ADR-47).
   * The daemon computes it so that the UI and the tray in the shell (Rust) read one rule instead of copies of it.
   */
  needsAttention: z.boolean(),
  /** The session may be stuck (ADR-151); `null` while its agent takes steps, waits or has ended. */
  stuck: SessionStuck.nullable(),
  /** The task in whose worktree the session runs; `null` for a session in the repo root. */
  task: TaskId.nullable(),
  /** The agent dialog on the screen while the session is in `Approval` (an approval) or in `Input` (a question); otherwise `null`. */
  dialog: AgentDialog.nullable(),
  environment: SessionEnvironment,
  /** Copilot CLI's own screen in a terminal, or Trackwall's conversation view over ACP (ADR-107). */
  view: SessionView,
  /** The read request while something waits unread for the agent of a running session (ADR-159); `null` otherwise. */
  readRequest: ReadRequest.nullable(),
  /** The agent's latest copy request in a running session (ADR-180), until the user copies or dismisses it; `null` otherwise. */
  copyRequest: CopyRequest.nullable(),
  /** What the session's conversation used (ADR-190); `null` before its first model call or when its event log cannot be read. */
  usage: CopilotUsage.nullable(),
  /**
   * The model Trackwall started the session on (ADR-206), as its `--model`: a task's, a repo or free session's or the
   * supervisor's; `null` when Trackwall passed none, and Copilot CLI took its default or a model from the configured
   * command or mise.
   */
  model: z.string().nullable(),
});
export type Session = z.infer<typeof Session>;

/** The supervisor (ADR-58): it runs in the projects folder, above all repos. */
export function isSupervisor(session: Pick<Session, "supervisor">): boolean {
  return session.supervisor;
}

/** A free session (ADR-100): Copilot CLI in the projects folder that is neither the supervisor nor in a repo. */
export function isFreeSession(session: Pick<Session, "repo" | "supervisor">): boolean {
  return session.repo === null && !session.supervisor;
}

/**
 * Which conversation a supervisor start goes on with (ADR-96): `last` resumes the newest supervisor's under its id, or
 * starts a new one when there is none; `new` always starts a new one.
 */
export const SupervisorConversation = z.enum(["last", "new"]);
export type SupervisorConversation = z.infer<typeof SupervisorConversation>;

export const Task = z.object({
  id: TaskId,
  repo: RepoId,
  prompt: z.string(),
  /** The task branch, `trackwall/<prompt slug>-<6 characters of the id>`. */
  branch: z.string(),
  /** The branch the task started from (the repo's default); `null` when the repo had neither a default nor a chosen branch. */
  baseBranch: z.string().nullable(),
  /** The base commit: the task's changes are the difference between it and the worktree's working directory. */
  base: CommitHash,
  /** Full path of the worktree: `<task worktrees folder>/<repo>/<branch without prefix>` (ADR-84). */
  worktree: z.string(),
  /** ISO 8601. */
  createdAt: z.string(),
  /** The title from the task proposal; `null` for a task typed in the UI, which the UI shows by its prompt. */
  title: z.string().nullable(),
  /** Where the task came from: an approved proposal (`ProposedBy`), or `null` when the user typed it. */
  proposedBy: ProposedBy.nullable(),
  /** The model its sessions run on (ADR-98); `null` for Copilot CLI's default. */
  model: TaskModel.nullable(),
  /** How its sessions answer tool approvals (ADR-105). */
  approvals: TaskApprovals,
  /** Whether its sessions get the Java language server for code navigation (ADR-99). */
  javaNavigation: z.boolean(),
  /** Whether its sessions run their commands in Copilot CLI's sandbox (ADR-181), as `sandbox` in `workspace.yaml` said at its start. */
  sandbox: z.boolean(),
  /** The board item the task works on (ADR-133); `null` for a task started from no item. */
  item: BoardItemId.nullable(),
  /** Whether its sessions show as a terminal or in the conversation view (ADR-137). */
  view: SessionView,
  /** The last summary from the task session (`report_result`); `null` until it has reported one. */
  summary: TaskSummary.nullable(),
  /**
   * Whether the agent has handed the work over for review (ADR-213): its `report_result` sets it, and the user's review
   * or "Fix" of a failed pipeline, which give the agent work again, clear it. The task's board item follows it.
   */
  inReview: z.boolean(),
  /** The task port (ADR-61): `TASK_PORT_ENV` in every mise task run in the worktree, and the port of the task's service. */
  port: TaskPort,
  included: IncludedFiles,
  /** The change the task is a part of (ADR-171); `null` for a task on its own. */
  change: TaskChange.nullable(),
});
export type Task = z.infer<typeof Task>;

/** Parts of a change were started one by one; the ones that could not start are named with why, the others run. */
export const CreatedChange = z.object({
  tasks: z.array(Task),
  failed: z.array(z.object({ repo: RepoId, message: z.string() })),
});
export type CreatedChange = z.infer<typeof CreatedChange>;

/**
 * What a proposal asks for (ADR-83): `task`, a task in the repo (`propose_task`), `change`, a change across several
 * repos (`propose_change`, ADR-171), or an action on the projects folder that a task cannot do, because a task is a
 * worktree of one repo (`propose_folder_action`): today `remove_repo`, which moves the repo out of the projects folder
 * into `.trackwall/removed`.
 */
export const ProposalKind = z.enum(["task", "change", "remove_repo"]);
export type ProposalKind = z.infer<typeof ProposalKind>;

/** The proposer's reason for a folder action, shown to the user in place of a task's prompt. */
export const FOLDER_ACTION_REASON_MAX = 2000;
export const FolderActionReason = z.string().trim().min(1).max(FOLDER_ACTION_REASON_MAX);

/**
 * A task proposal (ADR-39): a task that a session or an agent outside Trackwall submitted with the MCP tool `propose_task`.
 * Nothing starts until the user approves it in the Sessions view; an approved proposal becomes a task with the same id,
 * a rejected one disappears. It lives only in the daemon's memory, like the session that submitted it. Since ADR-83 a
 * proposal can also be an action on the projects folder (`kind`), approved and rejected in the same place.
 */
export const TaskProposal = z.object({
  /** The id the task gets once approved. */
  id: TaskId,
  kind: ProposalKind,
  repo: RepoId,
  title: z.string(),
  /** The task's prompt; for a folder action, the proposer's reason. */
  prompt: z.string(),
  /** The model the proposer chose for the task (ADR-98), which the user may change before the start; `null` for the default. */
  model: TaskModel.nullable(),
  /** The approvals mode the proposer suggested (ADR-105), which the user may change before the start; `ask` for a folder action. */
  approvals: TaskApprovals,
  /** The board item the proposed task works on (ADR-133), which the task keeps; `null` for none and for a folder action. */
  item: BoardItemId.nullable(),
  /**
   * The parts of a proposed change (ADR-171) in their merge order, each with its note; `repo` is the first one's. `null`
   * for a task and a folder action.
   */
  parts: ChangeParts.nullable(),
  /**
   * The daemon proposed it from the impact of the proposing task's commits (ADR-198): the repo calls an endpoint they
   * removed or changed. `proposedBy` is that task's session, so the proposal and its task sit under that task, but the
   * prompt came from the comparison, not from its agent.
   */
  fromImpact: z.boolean(),
  proposedBy: ProposedBy,
  /** ISO 8601. */
  createdAt: z.string(),
});
export type TaskProposal = z.infer<typeof TaskProposal>;

/** The repos a proposal is about: a change's repos in their merge order (ADR-171), otherwise its one repo. */
export function proposalRepos(proposal: Pick<TaskProposal, "repo" | "parts">): string[] {
  return proposal.parts?.map((part) => part.repo) ?? [proposal.repo];
}

/**
 * A task message (ADR-68): text the session that delegated a task (its proposer: a main session, the supervisor or an
 * agent outside Trackwall) sends to the task's session with the MCP tool `send_message`, which the task's agent reads
 * with `get_messages`. Like a review (ADR-62), the daemon only types a fixed prompt into the session and the text comes
 * from the tool. Kept only in daemon memory, the last `TASK_MESSAGES_KEPT` of a task, so the task panel shows them.
 */
export const TASK_MESSAGE_MAX = 4000;
/** Messages kept per task, read ones included; while this many are unread, a new one is refused. */
export const TASK_MESSAGES_KEPT = 20;
/**
 * Messages to one task since the user last took part (typed into the sender's or the task's session, or sent the task
 * a review): two agents cannot keep each other busy for longer without the user.
 */
export const TASK_MESSAGES_WITHOUT_USER = 5;
export const TaskMessageText = z.string().trim().min(1).max(TASK_MESSAGE_MAX);

export const TaskMessage = z.object({
  id: z.uuid(),
  task: TaskId,
  /** Who sent it, as on a proposal: the session by its session token, `supervisor` for the supervisor (ADR-58). */
  from: ProposedBy,
  text: z.string(),
  /** ISO 8601. */
  sentAt: z.string(),
  /** ISO 8601, when the task's agent read it with `get_messages`; `null` while unread. */
  readAt: z.string().nullable(),
});
export type TaskMessage = z.infer<typeof TaskMessage>;

/**
 * When a task's session gets the daemon's prompt to read a review (ADR-62) or a message (ADR-68): `typed`, the prompt
 * went into the session's input box (now, or a moment ago for something earlier the session has not taken yet);
 * `queued`, the session is not in its input box (working, asking for approval or a question, interrupted with Esc, the
 * user typing), and the prompt goes in when it next ends a turn; `on_resume`, the task has no running session, and the
 * prompt goes to the session that resumes it (the user, or `resume_task`, ADR-90).
 */
export const PromptDelivery = z.enum(["typed", "queued", "on_resume"]);
export type PromptDelivery = z.infer<typeof PromptDelivery>;

export const SendReviewResult = z.object({
  delivery: PromptDelivery,
  /** Comments the agent has not read yet, this review's included. */
  unread: z.number().int().positive(),
});
export type SendReviewResult = z.infer<typeof SendReviewResult>;

/**
 * Newest sessions first; ended sessions stay on the list until the user closes them (`dismiss`).
 * Tasks (newest first) stay until the user ends them, also after a daemon restart; a task's session is the newest
 * session with its `Session.task` (after a daemon restart, none).
 */
export const SessionList = z.object({
  sessions: z.array(Session),
  tasks: z.array(Task),
  /** Task proposals waiting for the user's decision, newest first. */
  proposals: z.array(TaskProposal),
  /** The messages kept for the tasks on the list (ADR-68), oldest first. */
  messages: z.array(TaskMessage),
  /**
   * The newest supervisor while it had a prompt, so Copilot CLI keeps its conversation, which a start with `last` goes
   * on with (ADR-96); also after the daemon restarts and after the user closed it. `null` when there is none.
   */
  lastSupervisor: SessionId.nullable(),
  /**
   * The session profile a session starts with now (`sessionProfile`, ADR-136), so the UI can tell a running session that
   * started with another one (ADR-178); `name: null` for no profile. `null` while `workspace.yaml` has a key that is not a
   * plain name, when no session starts at all.
   */
  sessionProfile: z.object({ name: z.string().nullable() }).nullable(),
});
export type SessionList = z.infer<typeof SessionList>;

/**
 * A task's changes: the worktree's working directory (with new files, without ignored ones) against the base commit, that
 * is the task's commits and what the agent has not committed yet, together.
 */
export const TaskChanges = WorkingTreeChanges.extend({
  /** Commits on the task branch since the base commit. */
  commits: z.number().int().nonnegative(),
  /** `git status` entries: changed, new and deleted files that are in no commit. */
  uncommitted: z.number().int().nonnegative(),
});
export type TaskChanges = z.infer<typeof TaskChanges>;

/** This many files fit in an agent's context with the rest of the result; more is usually build output without `.gitignore`. */
export const TASK_SUMMARY_MAX_FILES = 200;

/**
 * A task's changes without a diff, for an agent's context: files with line counts (at most `TASK_SUMMARY_MAX_FILES`;
 * `filesTruncated` when there were more) and commit counts, without the content of the changes.
 */
export const TaskChangesSummary = TaskChanges.omit({ patch: true, truncated: true }).extend({ filesTruncated: z.boolean() });
export type TaskChangesSummary = z.infer<typeof TaskChangesSummary>;

/** The smallest diff limit an agent may ask for in `get_task_changes`: less does not hold a file header and a hunk. */
export const AGENT_PATCH_MIN_BYTES = 1000;
/**
 * The default and the largest diff limit in one `get_task_changes` result: small next to the 1 MB of the "Changes"
 * tab, because the result reaches the agent twice (text and `structuredContent`).
 */
export const AGENT_PATCH_DEFAULT_BYTES = 32_000;
/** See `AGENT_PATCH_DEFAULT_BYTES`. */
export const AGENT_PATCH_MAX_BYTES = 200_000;

/**
 * A task's changes for an agent with their diff (`get_task_changes`): `TaskChanges` narrowed to the requested paths,
 * with the diff cut within the agent's byte limit and at most `TASK_SUMMARY_MAX_FILES` files (`filesTruncated`).
 */
export const AgentTaskChanges = TaskChanges.extend({ filesTruncated: TaskChangesSummary.shape.filesTruncated });
export type AgentTaskChanges = z.infer<typeof AgentTaskChanges>;

/** The most changed files `get_handoff` lists between the commit a task last read and the handing task's branch now. */
export const HANDOFF_FILES_MAX = 100;

/**
 * The task that handed the calling task its work (ADR-143) and how its branch moved since the caller last read it
 * (ADR-144), all from Trackwall's task list and git, never from an agent's text.
 */
export const TaskHandoffState = z.object({
  /** The handing task, whose changes `get_task_changes` reads while it lasts. */
  task: TaskId,
  repo: RepoId,
  branch: z.string(),
  /** The user has ended the handing task: its worktree is gone, and only its branch may be left in the repo. */
  ended: z.boolean(),
  /** The commit of that branch the caller read last: when the user approved its task, then at each `get_handoff`. */
  read: CommitHash,
  /** The branch's commit now; `null` when the task ended or git could not read it. */
  head: CommitHash.nullable(),
  /** Commits `head` has that `read` does not; `null` when unknown (no `head`, or `read` is gone after a rewritten history). */
  commits: z.number().int().nonnegative().nullable(),
  /** Files that differ between `read` and `head`, at most `HANDOFF_FILES_MAX`; empty when `commits` is `null` or 0. */
  files: z.array(z.string()).max(HANDOFF_FILES_MAX),
  filesTruncated: z.boolean(),
});
export type TaskHandoffState = z.infer<typeof TaskHandoffState>;

/**
 * Shared files of a task (ADR-44): files that both this task and another task of the same repo change, each compared
 * with its own base commit. The task merged second will likely get a conflict in them.
 */
export const TaskSharedFiles = z.object({
  /** The other task. */
  task: TaskId,
  /** Paths relative to the repo root, as in `ChangedFile.path`. */
  files: z.array(z.string()),
});
export type TaskSharedFiles = z.infer<typeof TaskSharedFiles>;

export const SharedFilesList = z.object({ shared: z.array(TaskSharedFiles) });
export type SharedFilesList = z.infer<typeof SharedFilesList>;

/** How one file of the mise config in a task's worktree differs from the trusted one (ADR-59). */
export const MiseConfigChange = z.object({
  /** Relative to the worktree root, with `/`. */
  path: z.string(),
  change: z.enum(["added", "modified", "removed"]),
  /** The file's text, to be read before trusting it; `null` for a removed file or one too long to show. */
  content: z.string().nullable(),
});
export type MiseConfigChange = z.infer<typeof MiseConfigChange>;

/**
 * The mise config of a task's worktree against the one the user trusted (ADR-59): the mise files as the worktree was
 * created, or as the user trusted them later. mise tasks run in the worktree only without changes.
 */
export const TaskMiseConfig = z.object({
  /**
   * No config of this worktree was ever trusted (a task from an older Trackwall, or one whose config could not be read
   * when it was created): every mise file is a change.
   */
  neverTrusted: z.boolean(),
  /** Sorted by path; empty when the worktree has the trusted mise config. */
  changes: z.array(MiseConfigChange),
  /** A hash of the current mise files: trusting passes it back, so the user trusts the config they saw, not a newer one. */
  digest: z.string(),
});
export type TaskMiseConfig = z.infer<typeof TaskMiseConfig>;

const endpoint = apiEndpoints("agents");

/**
 * Java navigation as a task could get it now (ADR-99): `null` without `javaNavigation` in `workspace.yaml`, otherwise
 * `problem`, why the language server cannot start (a path that is not there, a folder without jdtls), `null` when it can.
 */
export const JavaNavigationState = z.object({ problem: z.string().nullable() }).nullable();
export type JavaNavigationState = z.infer<typeof JavaNavigationState>;

/**
 * How a task's Java language server is doing (ADR-124), read from jdtls's own log in the task's data folder, since jdtls
 * reports ready also after an import that failed: `starting` before jdtls wrote anything, `importing` since `since` (ISO
 * 8601), `stalled` when importing has gone on past the limit, `ready` once the workspace is initialized without an
 * error, `failed` with the first error jdtls logged (a Gradle or Maven import that failed, a missing JDK).
 */
/** How long jdtls may import before a task's Java navigation counts as stalled: cold imports took 51 to 82 s (ADR-99). */
export const JAVA_NAVIGATION_STALL_MS = 5 * 60 * 1000;

export const JavaNavigationStatus = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("starting") }),
  z.object({ kind: z.literal("importing"), since: z.string() }),
  z.object({ kind: z.literal("stalled"), since: z.string() }),
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("failed"), message: z.string() }),
]);
export type JavaNavigationStatus = z.infer<typeof JavaNavigationStatus>;

/**
 * Copilot CLI's sandbox as a new task would get it (ADR-181): `tasks`, which tasks `sandbox` in `workspace.yaml` puts in
 * it, and `problem`, why it cannot run on this computer (no `bwrap` on Linux), which refuses to start those tasks; `null` when it can.
 */
export const SandboxState = z.object({ tasks: SandboxSettings.shape.tasks, problem: z.string().nullable() });
export type SandboxState = z.infer<typeof SandboxState>;

/** Whether a task with approvals mode `approvals` runs in the sandbox under `tasks` (ADR-181); the daemon's and the form's one rule. */
export function sandboxesTask(tasks: SandboxSettings["tasks"], approvals: TaskApprovals): boolean {
  return tasks === "all" || (tasks === "auto" && approvals === "auto");
}

export const StartOptions = z.object({ javaNavigation: JavaNavigationState, sandbox: SandboxState });
export type StartOptions = z.infer<typeof StartOptions>;

const SessionRequest = z.object({ session: SessionId }).strict();
const TaskRequest = z.object({ task: TaskId }).strict();

/** A worktree fingerprint (ADR-209): a sha256 in hex. */
const WorktreeFingerprint = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * What ending a task with its branch kept would delete, as `removeTask` counts it (ADR-210): nothing; uncommitted
 * changes or commits outside the branch, with the worktree's fingerprint that `removeTask` checks before it deletes
 * them; or `unknown` when git cannot read it (a folder git does not know as a worktree, a repo gone), which the cleanup
 * leaves to the task's own "End task".
 */
export const TaskWorktreeLoss = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("work"),
    uncommitted: z.number().int().nonnegative(),
    strayCommits: z.number().int().nonnegative(),
    fingerprint: WorktreeFingerprint,
  }),
  z.object({ kind: z.literal("unknown"), reason: z.string() }),
]);
export type TaskWorktreeLoss = z.infer<typeof TaskWorktreeLoss>;

/**
 * The worktree of a task without a running session as the cleanup of old worktrees lists it (ADR-210): how long the
 * task has been idle and what ending it with its branch kept would delete.
 */
export const TaskWorktree = z.object({
  task: TaskId,
  repo: RepoId,
  branch: z.string(),
  /**
   * ISO 8601: the newest of the task's start, its worktree's newest commit (a round commit after each turn, ADR-168),
   * its last report and its listed sessions' starts and ends.
   */
  lastActivityAt: z.string(),
  loss: TaskWorktreeLoss,
});
export type TaskWorktree = z.infer<typeof TaskWorktree>;

/** How much disk a task's worktree takes, files git ignores (dependencies, build output) included. */
export const TaskWorktreeSize = z.object({
  task: TaskId,
  bytes: z.number().int().nonnegative(),
  /** `false` when the count stopped at its limit of files or time, so `bytes` is a lower bound. */
  complete: z.boolean(),
});
export type TaskWorktreeSize = z.infer<typeof TaskWorktreeSize>;
const ProposalRequest = z.object({ proposal: TaskId }).strict();

export const agentsApi = {
  sessions: endpoint("sessions", z.object({}).strict(), SessionList),
  /**
   * Starts Copilot CLI with the session plugin (ADR-17) in the repo root, or with `repo: null` a free session in the
   * projects folder (ADR-100); with `prompt` as its first message, so it works from the start. Like a task's, it runs
   * on `model` (Copilot CLI's default when `null`, ADR-98) and shows in `view` (ADR-137), and in a repo with
   * `javaNavigation` it gets the Java language server (ADR-99), which needs a repo and a terminal (`bad_request`),
   * on every start and restart (ADR-175). It always asks for approvals: only a task in its own worktree runs without.
   */
  start: endpoint(
    "start",
    z
      .object({
        repo: RepoId.nullable(),
        prompt: TaskPrompt.optional(),
        model: TaskModel.nullable().default(null),
        javaNavigation: z.boolean().default(false),
        view: SessionView.default("terminal"),
      })
      .strict(),
    Session,
  ),
  /**
   * Starts the supervisor (ADR-58): Copilot CLI in the projects folder, above the sessions of all repos. There is at
   * most one running at a time, so while one runs this returns it instead of starting another. Otherwise `conversation`
   * says whether it goes on with the last supervisor's conversation or starts a new one (ADR-96).
   */
  startSupervisor: endpoint(
    "start-supervisor",
    z.object({ conversation: SupervisorConversation, view: SessionView.default("terminal") }).strict(),
    Session,
  ),
  /** Returns after confirming that no process of the session is alive; an ended session returns its state. */
  stop: endpoint("stop", SessionRequest, Session),
  /**
   * Whether the environment the running session would get from mise now differs from the one it started with (ADR-119):
   * the daemon asks mise again in the session's place. Only names, never values.
   */
  environmentChange: endpoint("environment-change", SessionRequest, EnvironmentCheck),
  /**
   * Stops a running session and starts it again with the same conversation (ADR-119), in the same place and view, so it
   * gets the environment, `agentSecrets` and tool permissions of now. A task's session resumes as Resume does; the
   * returned session is the new one. An ended session is `bad_request`. With `model` it starts again on that model
   * (ADR-206; `null` for Copilot CLI's default), which a task keeps for its later resumes, a repo or free session for
   * its later restarts and the supervisor as `supervisorModel` in `workspace.yaml`, saved before the restart.
   */
  restart: endpoint("restart", SessionRequest.extend({ model: TaskModel.nullable().optional() }), Session),
  /**
   * A message from the user to a session in the conversation view (ADR-107): its next prompt, sent at once when the agent
   * waits, otherwise after its turn, with the images and text files the user attached. A session in a terminal gets what
   * the user types there instead, and an agent that takes no images refuses them (`bad_request`). Only from the UI.
   */
  say: endpoint("say", SessionRequest.extend({ text: SessionMessage, attachments: MessageAttachments.default([]) }), Session, {
    maxBodyBytes: SESSION_MESSAGE_BODY_MAX_BYTES,
  }),
  /**
   * The user's Deliver now (ADR-159) for a read request nothing would send (`idle`): it goes to the agent as soon as the
   * agent can take it, at once into an empty input box, also after an Esc. It never goes into text in the input box,
   * into the middle of a turn or twice. An ended session is `bad_request`.
   */
  deliverReadRequest: endpoint("deliver-read-request", SessionRequest, Session),
  /**
   * The user copied or dismissed the session's copy request `request` (ADR-180), so it leaves the panel; the UI writes
   * the clipboard itself, in the click. A newer request of the agent stays, and a request already gone is no error.
   */
  clearCopyRequest: endpoint("clear-copy-request", SessionRequest.extend({ request: CopyRequestId }), Session),
  /** Stops the agent's turn in a session in the conversation view (ADR-107), as Esc does in the terminal. */
  interrupt: endpoint("interrupt", SessionRequest, Session),
  /**
   * Switches the agent of a session in the conversation view to one of the modes its conversation frames offer (ADR-107),
   * as Shift+Tab does in the terminal. A mode it does not offer, or a session in a terminal, is `bad_request`. Only from
   * the UI, never from MCP.
   */
  setMode: endpoint("set-mode", SessionRequest.extend({ mode: ConversationModeId }), Session),
  /**
   * Answers the session's agent dialog named by its `dialog` id (ADR-66): the daemon types the option's digit or Esc
   * into the session, as a key from the session terminal. A dialog no longer on the screen is `dialog_changed`, and
   * nothing is typed. Only from the UI, never from MCP: an agent does not approve its own tools.
   */
  answerDialog: endpoint("answer-dialog", SessionRequest.extend({ dialog: z.string().min(1).max(64), answer: DialogAnswer }), Session),
  /** Removes an ended session from the list; a running one cannot be closed without stopping it. */
  dismiss: endpoint("dismiss", SessionRequest, SessionList),
  /** What the New session form can offer before a start: whether Java navigation (ADR-99) is set up. */
  startOptions: endpoint("start-options", z.object({}).strict(), StartOptions),
  /**
   * Creates a worktree on a new branch from the default branch and starts Copilot CLI in it with the prompt (ADR-31);
   * with `item`, the task works on that board item (ADR-133), `not_found` when there is none. `view` is a terminal or
   * the conversation view for every session of the task (ADR-137); Java navigation needs a terminal (`bad_request`).
   * With `handoffFrom`, another task hands it its work (ADR-147).
   */
  createTask: endpoint(
    "create-task",
    z
      .object({
        repo: RepoId,
        prompt: TaskPrompt,
        approvals: TaskApprovals,
        model: TaskModel.nullable().default(null),
        javaNavigation: z.boolean().default(false),
        item: BoardItemId.nullable().default(null),
        view: SessionView.default("terminal"),
        /**
         * The task whose change the new task builds on, when the user hands it on from that task's impact (ADR-147):
         * the new task is its subtask, as if its session had proposed it (ADR-140, ADR-143); `not_found` when there is none.
         */
        handoffFrom: TaskId.nullable().default(null),
      })
      .strict(),
    Task,
  ),
  /**
   * Starts a change (ADR-171): one task per repo, in the order of `parts`, which is the order their merge requests are to
   * be merged; each with the change's prompt and its part's note, on one branch name from `title`. The options are the
   * ones of `createTask` for every part; Java navigation is left to tasks on their own. A part that cannot start is in
   * `failed` while the others run; when none can, the first one's error.
   */
  createChange: endpoint(
    "create-change",
    z
      .object({
        title: TaskTitle,
        prompt: TaskPrompt,
        parts: ChangeParts,
        approvals: TaskApprovals,
        model: TaskModel.nullable().default(null),
        item: BoardItemId.nullable().default(null),
        view: SessionView.default("terminal"),
      })
      .strict()
      .refine(({ prompt, parts }) => changePromptsFit(prompt, parts), CHANGE_PROMPTS_TOO_LONG),
    CreatedChange,
  ),
  /**
   * A new session for a task that has no running session, in the task's view: it goes on with the task's conversation.
   * With `model` the task runs on that model from now on (ADR-206; `null` for Copilot CLI's default).
   */
  resumeTask: endpoint("resume-task", TaskRequest.extend({ model: TaskModel.nullable().optional() }), Task),
  taskChanges: endpoint("task-changes", TaskRequest, TaskChanges),
  /**
   * Sends review comments on the task's changes to its session (ADR-62): the agent reads them with
   * `get_review_comments`. Only from the UI; the result says when the agent gets them.
   */
  sendReview: endpoint(
    "send-review",
    TaskRequest.extend({ comments: z.array(ReviewComment).min(1).max(REVIEW_COMMENTS_MAX) }),
    SendReviewResult,
  ),
  /** Other tasks of the same repo that change the same files (ADR-44); tasks whose changes cannot be read are left out. */
  taskSharedFiles: endpoint("task-shared-files", TaskRequest, SharedFilesList),
  /** How the task's Java language server is doing (ADR-124); `null` for a task without Java navigation. */
  taskJavaNavigation: endpoint("task-java-navigation", TaskRequest, JavaNavigationStatus.nullable()),
  /**
   * How the Java language server of a session is doing (ADR-124): its task's, or a repo session's own (ADR-175);
   * `null` for a session without Java navigation.
   */
  sessionJavaNavigation: endpoint("session-java-navigation", SessionRequest, JavaNavigationStatus.nullable()),
  openTaskEditor: endpoint("open-task-editor", TaskRequest, Done),
  /**
   * A file of a session's conversation in VS Code at a line (ADR-107): `path` as a tool call names it, inside the
   * session's working directory.
   */
  openConversationFile: endpoint(
    "open-conversation-file",
    SessionRequest.extend({ path: z.string().min(1).max(TOOL_FILE_PATH_MAX), line: z.number().int().positive() }),
    Done,
  ),
  /**
   * Copies the files the repo root's `.worktreeinclude` names into the task's existing worktree again (ADR-61), with the
   * same rules as at its start; a file the worktree already has stays as it is. Only from the UI, never from MCP.
   */
  copyIncludedFilesAgain: endpoint("copy-included-files-again", TaskRequest, Task),
  /**
   * Hands a task the user started to the supervisor (ADR-155): from then on it is the supervisor's work, which hears of
   * it through `get_updates` and may send it messages; `bad_request` for a task that already has a proposer. Only from
   * the UI, never from MCP.
   */
  handToSupervisor: endpoint("hand-to-supervisor", TaskRequest, Task),
  /** The worktree's mise config against the trusted one (ADR-59). */
  taskMiseConfig: endpoint("task-mise-config", TaskRequest, TaskMiseConfig),
  /**
   * The user trusts the worktree's current mise config (ADR-59), named by its `digest` from `task-mise-config`; a config
   * that changed again since then is `bad_request`. Only from the UI, never from MCP.
   */
  trustTaskMiseConfig: endpoint("trust-task-mise-config", TaskRequest.extend({ digest: z.string().min(1).max(128) }), TaskMiseConfig),
  /**
   * Ending a task: removes the worktree, and without `keepBranch` also the branch. Changes that would be lost (uncommitted
   * files and commits outside the branch, and without `keepBranch` also the task's commits) the daemon deletes only with
   * `discardChanges`; otherwise `unsaved_changes`. With `discardFingerprint` (ADR-210) it deletes them only while the
   * worktree still has that fingerprint, the one of what the user confirmed; otherwise `unsaved_changes` too.
   */
  removeTask: endpoint(
    "remove-task",
    z
      .object({ task: TaskId, keepBranch: z.boolean(), discardChanges: z.boolean(), discardFingerprint: WorktreeFingerprint.optional() })
      .strict(),
    Done,
  ),
  /** The worktree of every task without a running session, for the cleanup of old worktrees (ADR-210); reads only. */
  taskWorktrees: endpoint("task-worktrees", z.object({}).strict(), z.array(TaskWorktree)),
  /** How much disk the task's worktree takes; counts its files, so it may take seconds. */
  taskWorktreeSize: endpoint("task-worktree-size", TaskRequest, TaskWorktreeSize),
  /**
   * Approving a task proposal (ADR-39): a task with its id, like `create-task`, with the prompt the user may have edited
   * before the start. A failed start leaves the proposal for another try or a rejection.
   */
  approveProposal: endpoint(
    "approve-proposal",
    ProposalRequest.extend({
      prompt: TaskPrompt,
      model: TaskModel.nullable(),
      approvals: TaskApprovals,
      view: SessionView.default("terminal"),
    }),
    Task,
  ),
  /**
   * Approving a proposed change (ADR-171): `create-change` with the proposal's title, the parts the user kept with the
   * notes as the user left them (`parts`, at least two of the proposal's repos, in the proposal's order whatever their
   * order here) and the options. The first part made takes the proposal's id, and every part counts as proposed by the
   * proposal's proposer, who hears which parts started (`change_started`). When no part starts, the proposal waits again.
   */
  approveChangeProposal: endpoint(
    "approve-change-proposal",
    ProposalRequest.extend({
      prompt: TaskPrompt,
      parts: ChangeParts,
      model: TaskModel.nullable(),
      approvals: TaskApprovals,
      view: SessionView.default("terminal"),
    }),
    CreatedChange,
  ),
  /**
   * Approving a proposal to remove a repo (ADR-83): refused while a session, a task or a process runs in the repo; then
   * the repo moves into `.trackwall/removed` in the projects folder. A refusal leaves the proposal waiting.
   */
  approveRepoRemoval: endpoint("approve-repo-removal", ProposalRequest, Done),
  /**
   * Rejects a proposal: it leaves the list, and a session waiting on it gets `proposal_rejected` with the user's reason
   * when they gave one (ADR-55); an empty reason is no reason.
   */
  rejectProposal: endpoint(
    "reject-proposal",
    ProposalRequest.extend({
      reason: z
        .string()
        .trim()
        .max(REJECTION_REASON_MAX)
        .optional()
        .transform((reason) => (reason === "" ? undefined : reason)),
    }),
    Done,
  ),
};

/** What the user asks for when they start a change (ADR-171), with the defaults filled in. */
export type ChangeRequest = z.infer<typeof agentsApi.createChange.request>;
export type ApproveChangeRequest = Omit<z.infer<typeof agentsApi.approveChangeProposal.request>, "proposal">;

/**
 * Close codes of the terminal WebSocket from the application range (4000–4999), so that the terminal window can tell the
 * end of a session from a dropped connection. The session does not exist (unknown or closed by `dismiss`): the window
 * does not reconnect. */
export const PTY_CLOSE_NOT_FOUND = 4404;
/** The window does not keep up with the output (over 8 MB in the daemon's buffer); it reconnects from the screen image. */
export const PTY_CLOSE_SLOW = 4429;

/**
 * Frames from the client (JSON text). The daemon sends terminal output in binary frames, and after connecting it first
 * sends the screen image (a text frame) the client starts from.
 */
export const PtyClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(64 * 1024) }),
  z.object({ type: z.literal("resize"), cols: z.number().int().min(10).max(1000), rows: z.number().int().min(4).max(500) }),
  /** The window is (or stops being) in front of the user: focused and visible. A focused window marks the session seen (ADR-47). */
  z.object({ type: z.literal("focus"), focused: z.boolean() }),
]);
export type PtyClientMessage = z.infer<typeof PtyClientMessage>;
