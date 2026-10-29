import {
  agentsApi,
  cardsApi,
  countLabel,
  pluralNoun,
  type Session,
  TASK_PROMPT_MAX,
  type TaskApprovals,
  workspaceApi,
} from "@trackwall/protocol";
import { GitBranch, Play } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { type JavaNavigationOffer, javaNavigationOffer } from "@/lib/java-navigation";
import { type FromItem, firstListedRepo, formStart, type NewSessionStart, newSessionForm, sessionsInSameFolder } from "@/lib/new-session";
import { tagsByRepo } from "@/lib/repo-tags";
import type { SessionSelection } from "@/lib/session-entries";
import { readStartChoice, type StartChoice, saveStartChoice } from "@/lib/start-choices";
import { typedModel } from "@/lib/task-model";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";
import { StartOptions } from "./StartOptions.tsx";

/** The place choice's value for the projects folder; a repo id is never empty. */
const PROJECTS_FOLDER = "";

/**
 * A new task or session (ADR-100): a repo from the projects folder, or the projects folder itself, and a prompt for the
 * agent. In a repo with its own worktree it becomes a task (ADR-31); without one a main session in the repo's working
 * copy (ADR-26), and in the projects folder a free session, both with the prompt as their first message when there is one.
 * Only a task, which works in its own worktree, can run on a chosen model (ADR-98) and without asking for approvals
 * (ADR-105), and, in a repo tagged java, with a Java language server (ADR-99). The options are a row of pills under the
 * prompt (`StartOptions`); the worktree, the model and Java navigation come back as the user last started from that
 * place, the approvals mode always starts at asking. Started from a board item (ADR-133), the form comes with the item's
 * repo and prompt, and the task works on the item.
 */
export function NewSession({
  conn,
  sessions,
  fromItem,
  onStarted,
  onCancel,
}: {
  conn: Connection;
  /** The listed sessions, for the warning about another agent in the same working copy. */
  sessions: readonly Session[];
  /** The board item the task is for; then the form starts only a task, in a repo. */
  fromItem?: FromItem;
  onStarted: (selection: SessionSelection) => void;
  onCancel?: () => void;
}) {
  const form = newSessionForm(fromItem);
  const load = useCallback(() => post(conn, workspaceApi.list, {}), [conn]);
  const repos = useRemote(load);
  const [place, setPlace] = useState<string>();
  const [edited, setEdited] = useState<ReadonlyMap<string, StartChoice>>(new Map());
  const [prompt, setPrompt] = useState(form.prompt);
  const [approvals, setApprovals] = useState<TaskApprovals>("ask");
  const chosen = place ?? firstListedRepo(form.repos, repos.data?.repos) ?? repos.data?.repos[0]?.id ?? PROJECTS_FOLDER;
  const repo = chosen === PROJECTS_FOLDER ? null : chosen;
  const remembered = useMemo(() => readStartChoice(() => window.localStorage, chosen), [chosen]);
  const choice = edited.get(chosen) ?? remembered;
  const choose = (next: Partial<StartChoice>) => setEdited(new Map(edited).set(chosen, { ...choice, ...next }));
  const model = typedModel(choice.model);
  const start = formStart(form, repo, choice.worktree, prompt);
  const java = useJavaNavigationOffer(conn, repo);
  const javaNavigation = java.kind === "ready" && choice.javaNavigation;
  const { item } = form;
  const createTask = useAction(
    (repo: string, prompt: string) =>
      post(conn, agentsApi.createTask, { repo, prompt, approvals, model: model ?? null, javaNavigation, item }),
    (task) => onStarted({ kind: "task", id: task.id }),
  );
  const startSession = useAction(
    (repo: string | null, prompt: string | undefined) => post(conn, agentsApi.start, { repo, prompt }),
    (session) => onStarted({ kind: "session", id: session.id }),
  );
  const pending = createTask.pending || startSession.pending;
  const error = createTask.error ?? startSession.error;
  const run = () => {
    // A model that is not an id is not remembered: a task waits for it to be fixed, a session does not use it.
    if (model !== undefined) saveStartChoice(() => window.localStorage, chosen, choice);
    if (start.kind === "task") createTask.run(start.repo, start.prompt);
    if (start.kind === "session") startSession.run(start.repo, start.prompt);
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4 p-6">
      <h3 className="hud-label">{form.heading}</h3>
      {repos.error && <ErrorWithRetry message={repos.error} onRetry={repos.reload} />}
      {repos.data && (
        <>
          <PlaceSelect repos={repos.data.repos} value={chosen} projectsFolder={form.sessions} onChange={setPlace} />
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
          <StartOptions
            worktree={
              repo === null || !form.sessions ? undefined : { value: choice.worktree, onChange: (worktree) => choose({ worktree }) }
            }
            {...(start.kind === "session"
              ? {}
              : {
                  approvals: { value: approvals, onChange: setApprovals },
                  model: { value: choice.model, onChange: (text: string) => choose({ model: text }) },
                  javaNavigation: javaNavigationPill(java, choice.javaNavigation, (on) => choose({ javaNavigation: on })),
                })}
            disabled={pending}
          />
          {start.kind === "session" && <WithoutWorktree repo={repo} sessions={sessions} />}
          <div className="flex flex-wrap items-center gap-2">
            <StartButton start={start} disabled={pending} invalidModel={model === undefined} onClick={run} />
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

/** Where the agent works: a repo, or the projects folder for a session. */
function PlaceSelect({
  repos,
  value,
  projectsFolder,
  onChange,
}: {
  repos: readonly { id: string }[];
  value: string;
  projectsFolder: boolean;
  onChange: (place: string) => void;
}) {
  return (
    <select
      aria-label="Where the agent works"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="border-input bg-card h-9 w-fit min-w-48 rounded-md border px-3 text-sm"
    >
      {repos.map((r) => (
        <option key={r.id} value={r.id}>
          {r.id}
        </option>
      ))}
      {projectsFolder && <option value={PROJECTS_FOLDER}>No repo: the projects folder</option>}
    </select>
  );
}

/** Java navigation for a task in `repo` (ADR-99), from the repo's tags and the daemon's settings. */
function useJavaNavigationOffer(conn: Connection, repo: string | null): JavaNavigationOffer {
  const loadTags = useCallback(() => post(conn, cardsApi.tags, {}), [conn]);
  const tags = useRemote(loadTags);
  // Asked again for each repo chosen, so that a fix in workspace.yaml shows without reopening the form.
  const loadOptions = useCallback(() => post(conn, agentsApi.startOptions, {}), [conn, repo]);
  const options = useRemote(loadOptions);
  return javaNavigationOffer(repo === null ? undefined : tagsByRepo(tags.data).get(repo), options.data?.javaNavigation);
}

/** The Java navigation pill of a task, or none where the offer is hidden. */
function javaNavigationPill(offer: JavaNavigationOffer, value: boolean, onChange: (value: boolean) => void) {
  if (offer.kind === "hidden") return undefined;
  return { value, onChange, unavailable: offer.kind === "unavailable" ? offer.reason : null };
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

/** "Start session" for a session, "Create task" for a task, which needs a prompt and, when a model is typed, a model id. */
function StartButton({
  start,
  disabled,
  invalidModel,
  onClick,
}: {
  start: NewSessionStart;
  disabled: boolean;
  invalidModel: boolean;
  onClick: () => void;
}) {
  return start.kind === "session" ? (
    <Button onClick={onClick} disabled={disabled}>
      <Play /> Start session
    </Button>
  ) : (
    <Button onClick={onClick} disabled={disabled || invalidModel || start.kind === "needs-prompt" || start.kind === "needs-repo"}>
      <GitBranch /> Create task
    </Button>
  );
}
