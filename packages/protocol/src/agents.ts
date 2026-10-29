import { z } from "zod";
import { Done, type Endpoint } from "./api.ts";
import { WorkingTreeChanges } from "./changes.ts";
import { SessionMessage, SessionView } from "./conversation.ts";
import { RunState } from "./procs.ts";
import { REVIEW_COMMENTS_MAX, ReviewComment } from "./review.ts";
import { TaskStateChange } from "./task-state.ts";
import { CommitHash, RepoId } from "./workspace.ts";

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
export const TaskTitle = z
  .string()
  .trim()
  .min(1)
  .max(TASK_TITLE_MAX)
  // `refine` instead of `regex` for the same reason as in `visibleText`.
  .refine((value) => !/\p{Cc}/u.test(value), { message: "the title must be a single line without control characters" });

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
  return text.refine((value) => !/[\p{Cf}\p{Co}\u2028\u2029]/u.test(value), {
    message: "the text must not contain invisible characters (format or private-use characters, line separators)",
  });
}

/**
 * The Copilot CLI model a task's session runs on (ADR-98), passed as `--model=<id>` when the task starts and whenever it
 * resumes; `null` for Copilot CLI's own default. The catalog of models depends on the Copilot CLI version and the user's
 * account, so Trackwall checks only the shape of an id (`claude-opus-5.5`, `gpt-5.5`, `auto`) and Copilot CLI the rest.
 */
export const TASK_MODEL_MAX = 64;
export const TaskModel = z
  .string()
  .trim()
  .min(1)
  .max(TASK_MODEL_MAX)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
    message: "a model id is letters, digits, dots, dashes and underscores, such as claude-opus-5.5",
  });

/**
 * How a task's sessions answer tool approvals (ADR-105): `ask`, Copilot CLI asks the user before each tool its rules do not
 * already allow; `auto`, it runs every tool without asking (`--allow-all-tools`) on every start and resume, shell commands
 * such as `git push` included. `deny` rules from `toolPermissions` still refuse, and Copilot CLI still asks before a path
 * it recognises outside the worktree and before a URL.
 */
export const TaskApprovals = z.enum(["ask", "auto"]);
export type TaskApprovals = z.infer<typeof TaskApprovals>;

/** A task summary from its session (`report_result`, ADR-39): what it did and what is left, for the session that delegated the task. */
export const TASK_SUMMARY_MAX = 4000;
export const TaskSummaryText = z.string().trim().min(1).max(TASK_SUMMARY_MAX);

/**
 * Who proposed the task (ADR-39): a Trackwall session by its session token, or `null` for an agent outside Trackwall
 * (a supervising agent with the daemon token).
 */
export const ProposedBy = z.object({
  session: SessionId.nullable(),
  /**
   * The proposing session was the supervisor (ADR-58). Kept with the task, so that the supervisor's work stays under
   * it in the Sessions view after the supervisor session that proposed it is gone (closed, or the daemon restarted).
   * Absent in task files from before ADR-58.
   */
  supervisor: z.boolean().default(false),
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
  /** Secrets the agent's tools would get now (added to `agentSecrets`). */
  shared: z.array(z.string()),
  /** Secrets the agent's tools would no longer get (taken out of `agentSecrets`). */
  unshared: z.array(z.string()),
});
export type EnvironmentChange = z.infer<typeof EnvironmentChange>;

/** The answer of `environment-change`: `null` while the session's environment is the one it would get now. */
export const EnvironmentCheck = z.object({ change: EnvironmentChange.nullable() });
export type EnvironmentCheck = z.infer<typeof EnvironmentCheck>;

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
  /** The task in whose worktree the session runs; `null` for a session in the repo root. */
  task: TaskId.nullable(),
  /** The agent dialog on the screen while the session is in `Approval` (an approval) or in `Input` (a question); otherwise `null`. */
  dialog: AgentDialog.nullable(),
  environment: SessionEnvironment,
  /** Copilot CLI's own screen in a terminal, or Trackwall's conversation view over ACP (ADR-107). */
  view: SessionView,
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
  /** The last summary from the task session (`report_result`); `null` until it has reported one. */
  summary: z.object({ text: z.string(), reportedAt: z.string() }).nullable(),
  /** The task port (ADR-61): `TASK_PORT_ENV` in every mise task run in the worktree, and the port of the task's service. */
  port: TaskPort,
  included: IncludedFiles,
});
export type Task = z.infer<typeof Task>;

/**
 * What a proposal asks for (ADR-83): `task`, a task in the repo (`propose_task`), or an action on the projects folder
 * that a task cannot do, because a task is a worktree of one repo (`propose_folder_action`): today `remove_repo`, which
 * moves the repo out of the projects folder into `REMOVED_REPOS_DIR`.
 */
export const ProposalKind = z.enum(["task", "remove_repo"]);
export type ProposalKind = z.infer<typeof ProposalKind>;

/** The proposer's reason for a folder action, shown to the user in place of a task's prompt. */
export const FOLDER_ACTION_REASON_MAX = 2000;
export const FolderActionReason = z.string().trim().min(1).max(FOLDER_ACTION_REASON_MAX);

/** The folder in the projects folder where a removed repo goes (ADR-83); hidden, so the repo list does not see it. */
export const REMOVED_REPOS_DIR = ".trackwall-removed";

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
  proposedBy: ProposedBy,
  /** ISO 8601. */
  createdAt: z.string(),
});
export type TaskProposal = z.infer<typeof TaskProposal>;

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

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/agents/${action}`, request, data };
}

const SessionRequest = z.object({ session: SessionId }).strict();
const TaskRequest = z.object({ task: TaskId }).strict();
const ProposalRequest = z.object({ proposal: TaskId }).strict();

export const agentsApi = {
  sessions: endpoint("sessions", z.object({}).strict(), SessionList),
  /**
   * Starts Copilot CLI with the session plugin (ADR-17) in the repo root, or with `repo: null` a free session in the
   * projects folder (ADR-100); with `prompt` as its first message, so it works from the start.
   */
  start: endpoint("start", z.object({ repo: RepoId.nullable(), prompt: TaskPrompt.optional() }).strict(), Session),
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
   * returned session is the new one. An ended session is `bad_request`.
   */
  restart: endpoint("restart", SessionRequest, Session),
  /**
   * A message from the user to a session in the conversation view (ADR-107): its next prompt, sent at once when the agent
   * waits, otherwise after its turn. A session in a terminal gets what the user types there instead (`bad_request`).
   */
  say: endpoint("say", SessionRequest.extend({ text: SessionMessage }), Session),
  /** Stops the agent's turn in a session in the conversation view (ADR-107), as Esc does in the terminal. */
  interrupt: endpoint("interrupt", SessionRequest, Session),
  /**
   * Answers the session's agent dialog named by its `dialog` id (ADR-66): the daemon types the option's digit or Esc
   * into the session, as a key from the session terminal. A dialog no longer on the screen is `dialog_changed`, and
   * nothing is typed. Only from the UI, never from MCP: an agent does not approve its own tools.
   */
  answerDialog: endpoint("answer-dialog", SessionRequest.extend({ dialog: z.string().min(1).max(64), answer: DialogAnswer }), Session),
  /** Removes an ended session from the list; a running one cannot be closed without stopping it. */
  dismiss: endpoint("dismiss", SessionRequest, SessionList),
  /** Creates a worktree on a new branch from the default branch and starts Copilot CLI in it with the prompt (ADR-31). */
  createTask: endpoint("create-task", z.object({ repo: RepoId, prompt: TaskPrompt, approvals: TaskApprovals }).strict(), Task),
  /** A new session for a task that has no running session: Copilot CLI resumes the task's conversation (`--resume`). */
  resumeTask: endpoint("resume-task", TaskRequest, Task),
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
  openTaskEditor: endpoint("open-task-editor", TaskRequest, Done),
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
   * `discardChanges`; otherwise `unsaved_changes`.
   */
  removeTask: endpoint("remove-task", z.object({ task: TaskId, keepBranch: z.boolean(), discardChanges: z.boolean() }).strict(), Done),
  /**
   * Approving a task proposal (ADR-39): a task with its id, like `create-task`, with the prompt the user may have edited
   * before the start. A failed start leaves the proposal for another try or a rejection.
   */
  approveProposal: endpoint(
    "approve-proposal",
    ProposalRequest.extend({ prompt: TaskPrompt, model: TaskModel.nullable(), approvals: TaskApprovals }),
    Task,
  ),
  /**
   * Approving a proposal to remove a repo (ADR-83): refused while a session, a task or a process runs in the repo; then
   * the repo moves into `REMOVED_REPOS_DIR` in the projects folder. A refusal leaves the proposal waiting.
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
