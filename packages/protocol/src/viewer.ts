import { z } from "zod";
import { SessionId, type SessionList, TaskId } from "./agents.ts";
import { apiEndpoints } from "./api.ts";
import { cutText } from "./cut-text.ts";
import { StatusTone, sessionPlace, sessionStateLabel } from "./session-label.ts";

/**
 * Viewer access (ADR-221): a read-only client on this computer, today the VS Code extension, sees the sessions and what
 * waits for the user, and nothing else. It never gets the daemon token: the daemon issues it a viewer token of its own,
 * which opens only `viewerApi.sessions`, and only while the user has turned viewer access on in Settings. The list is
 * cut down to what a glance needs: no agent dialog, screen, prompt or message text, so a viewer token that leaks shows
 * what the sessions are doing and can change nothing.
 */

/** The file in the state directory that hands a viewer the daemon's port and the viewer token; it is there only while viewer access is on. */
export const VIEWER_FILE = "viewer.json";

/** `viewer.json`: written by the daemon, user-only, when viewer access is on, and again at each daemon start with a new token. */
export const ViewerFile = z.object({
  port: z.number().int().min(1).max(65535),
  /** 32 random bytes in base64url, as the daemon makes it; nothing else, since the extension writes it into a header by hand. */
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /**
   * The daemon start that issued the token (`Health.instance`, which is public): a viewer sends the token only after
   * `/api/health` on the port answers with the same instance, so a file left by a daemon that has ended does not send it
   * to another program that took the port by chance. The token of an ended start is dead anyway: the daemon kept its hash in memory.
   */
  instance: z.string().min(1),
});
export type ViewerFile = z.infer<typeof ViewerFile>;

/** The longest window title and task name a viewer gets; a list row has room for less. */
export const VIEWER_TEXT_MAX = 200;

export const ViewerStatus = z.object({
  tone: StatusTone.nullable(),
  /** The state in the words of the UI (`sessionStateLabel`): "asking for approval", "working", "idle"… */
  label: z.string(),
});

export const ViewerSession = z.object({
  id: SessionId,
  /** Where it works: the repo, "Supervisor" or "Free session" (`sessionPlace`). */
  place: z.string(),
  supervisor: z.boolean(),
  /** The window title the agent set: what it is working on; `null` before it set one. */
  windowTitle: z.string().max(VIEWER_TEXT_MAX).nullable(),
  task: TaskId.nullable(),
  /**
   * The task's title from its proposal; `null` for a task the user typed, whose prompt stays in Trackwall, and for a session
   * in a repo root or the projects folder.
   */
  taskName: z.string().max(VIEWER_TEXT_MAX).nullable(),
  status: ViewerStatus,
  /** Waiting for you (`Session.needsAttention`, ADR-47). */
  needsAttention: z.boolean(),
  /** The session's process still runs (also while it stops). */
  live: z.boolean(),
  /** ISO 8601: the last state change, or the start when there was none. */
  since: z.string(),
});
export type ViewerSession = z.infer<typeof ViewerSession>;

export const ViewerSessionList = z.object({
  /** Newest first, like `SessionList.sessions`. */
  sessions: z.array(ViewerSession),
  /** How many task proposals wait for the user's decision; their text stays in Trackwall. */
  proposals: z.number().int().nonnegative(),
});
export type ViewerSessionList = z.infer<typeof ViewerSessionList>;

/** Viewer access as Settings shows it: whether it is on, and the file a viewer reads. */
export const ViewerAccessState = z.object({
  enabled: z.boolean(),
  /** The full path of `viewer.json`. */
  file: z.string(),
});
export type ViewerAccessState = z.infer<typeof ViewerAccessState>;

const endpoint = apiEndpoints("viewer");
/** The viewer's request is `{}`; the one action a token other than the daemon's opens reads no more than that. */
const VIEWER_BODY_MAX_BYTES = 1024;

export const viewerApi = {
  /** The sessions as a viewer sees them; the only action a viewer token opens (the daemon token opens it too). */
  sessions: endpoint("sessions", z.object({}).strict(), ViewerSessionList, { maxBodyBytes: VIEWER_BODY_MAX_BYTES }),
  state: endpoint("state", z.object({}).strict(), ViewerAccessState),
  /** Turns viewer access on (a new token in `viewer.json`) or off (the file removed, the token refused at once). */
  setEnabled: endpoint("set-enabled", z.object({ enabled: z.boolean() }).strict(), ViewerAccessState),
} as const;

/** The session list cut down for a viewer: each session's state in the UI's words, and of what a session or the user wrote only the titles. */
export function viewerSessionList(list: Pick<SessionList, "sessions" | "tasks" | "proposals">): ViewerSessionList {
  const tasks = new Map(list.tasks.map((t) => [t.id, t]));
  return {
    sessions: list.sessions.map((s) => {
      const task = s.task === null ? undefined : tasks.get(s.task);
      const status = sessionStateLabel(s);
      return {
        id: s.id,
        place: sessionPlace(s),
        supervisor: s.supervisor,
        windowTitle: s.windowTitle === null ? null : cutText(s.windowTitle, VIEWER_TEXT_MAX),
        task: s.task,
        taskName: task?.title == null ? null : cutText(task.title, VIEWER_TEXT_MAX),
        status: { tone: status.tone ?? null, label: status.label },
        needsAttention: s.needsAttention,
        live: s.run.kind !== "exited",
        since: s.state?.at ?? s.startedAt,
      };
    }),
    proposals: list.proposals.length,
  };
}
