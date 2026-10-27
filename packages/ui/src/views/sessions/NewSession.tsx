import { agentsApi, countLabel, pluralNoun, type Session, TASK_PROMPT_MAX, workspaceApi } from "@trackwall/protocol";
import { GitBranch, Play } from "lucide-react";
import { useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { newSessionStart, sessionsInSameFolder } from "@/lib/new-session";
import type { SessionSelection } from "@/lib/session-entries";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/** The place choice's value for the projects folder; a repo id is never empty. */
const PROJECTS_FOLDER = "";

/**
 * A new task or session (ADR-100): a repo from the projects folder, or the projects folder itself, and a prompt for the
 * agent. In a repo with its own worktree it becomes a task (ADR-31); without one a main session in the repo's working
 * copy (ADR-26), and in the projects folder a free session, both with the prompt as their first message when there is one.
 */
export function NewSession({
  conn,
  sessions,
  onStarted,
  onCancel,
}: {
  conn: Connection;
  /** The listed sessions, for the warning about another agent in the same working copy. */
  sessions: readonly Session[];
  onStarted: (selection: SessionSelection) => void;
  onCancel?: () => void;
}) {
  const load = useCallback(() => post(conn, workspaceApi.list, {}), [conn]);
  const repos = useRemote(load);
  const [place, setPlace] = useState<string>();
  const [worktree, setWorktree] = useState(true);
  const [prompt, setPrompt] = useState("");
  const chosen = place ?? repos.data?.repos[0]?.id ?? PROJECTS_FOLDER;
  const repo = chosen === PROJECTS_FOLDER ? null : chosen;
  const start = newSessionStart(repo, worktree, prompt);
  const createTask = useAction(
    (repo: string, prompt: string) => post(conn, agentsApi.createTask, { repo, prompt }),
    (task) => onStarted({ kind: "task", id: task.id }),
  );
  const startSession = useAction(
    (repo: string | null, prompt: string | undefined) => post(conn, agentsApi.start, { repo, prompt }),
    (session) => onStarted({ kind: "session", id: session.id }),
  );
  const pending = createTask.pending || startSession.pending;
  const error = createTask.error ?? startSession.error;
  const run = () => {
    if (start.kind === "task") createTask.run(start.repo, start.prompt);
    if (start.kind === "session") startSession.run(start.repo, start.prompt);
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4 p-6">
      <h3 className="hud-label">New task or session for the agent</h3>
      <p className="text-muted-foreground max-w-prose text-sm">
        In its own worktree, Trackwall creates a new branch from the default branch of the chosen repo in a separate folder and starts
        Copilot CLI there with your prompt, so several tasks in one repo stay out of each other's way, and the Changes tab shows what the
        agent changes. The session runs in a terminal owned by the daemon, also after you close the window.
      </p>
      {repos.error && <ErrorWithRetry message={repos.error} onRetry={repos.reload} />}
      {repos.data && (
        <>
          <div className="flex flex-wrap items-center gap-4">
            <select
              aria-label="Where the agent works"
              value={chosen}
              onChange={(e) => setPlace(e.target.value)}
              className="border-input bg-card h-9 w-fit min-w-48 rounded-md border px-3 text-sm"
            >
              {repos.data.repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id}
                </option>
              ))}
              <option value={PROJECTS_FOLDER}>No repo: the projects folder</option>
            </select>
            {repo !== null && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-primary size-4 shrink-0"
                  checked={worktree}
                  onChange={(e) => setWorktree(e.target.checked)}
                />
                In its own worktree
              </label>
            )}
          </div>
          <Textarea
            aria-label="Prompt for the agent"
            placeholder={
              start.kind === "session"
                ? "Optional: the first message for the agent, or leave it empty and type in its terminal"
                : "What the agent should do, e.g. “Add email validation to the sign-up form, with a test”"
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={TASK_PROMPT_MAX}
            rows={5}
          />
          {start.kind === "session" && <WithoutWorktree repo={repo} sessions={sessions} />}
          <div className="flex flex-wrap items-center gap-2">
            {start.kind === "session" ? (
              <Button onClick={run} disabled={pending}>
                <Play /> Start session
              </Button>
            ) : (
              <Button onClick={run} disabled={pending || start.kind === "needs-prompt"}>
                <GitBranch /> Create task
              </Button>
            )}
            {onCancel && (
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            )}
          </div>
          <p className="text-muted-foreground max-w-prose text-xs">
            Copilot CLI asks you to trust a folder before it works there. To skip that prompt for every repo and task, add{" "}
            <span className="text-foreground font-mono">{repos.data.projectsDir}</span> to <span className="font-mono">trustedFolders</span>{" "}
            in <span className="font-mono">~/.copilot/config.json</span>; trust covers its repos and their task worktrees.
          </p>
        </>
      )}
      {error && <p className="text-destructive text-sm whitespace-pre-wrap">{error}</p>}
    </div>
  );
}

/** What a session without its own worktree gives up, and the agents it would share the working copy with. */
function WithoutWorktree({ repo, sessions }: { repo: string | null; sessions: readonly Session[] }) {
  const sharing = sessionsInSameFolder(sessions, repo).length;
  return (
    <div className="text-muted-foreground flex max-w-prose flex-col gap-1 text-xs">
      <p>
        {repo === null
          ? "A free session works in the projects folder and can change any repo in it."
          : "The agent works in the repo's own working copy, where your editor and services are."}{" "}
        Its changes go straight into your working copies: no Changes tab, review, Verify or merge request, which only a task in its own
        worktree has.
      </p>
      {sharing > 0 && (
        <p className="text-destructive">
          {countLabel(sharing, { one: "session", other: "sessions" })} already {pluralNoun(sharing, { one: "works", other: "work" })} here:
          two agents in one working copy change each other's files and branch.
        </p>
      )}
    </div>
  );
}
