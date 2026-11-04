import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { cutText, USAGE_REPORT_LABEL_MAX_CHARS, type UsageWorkKind } from "@trackwall/protocol";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { isInside } from "../../infra/path-inside.ts";

/**
 * Which work a Copilot CLI conversation was for (ADR-195), from the folder and git branch Copilot CLI records in the
 * conversation's `workspace.yaml`: a task's worktree on a task branch, the projects folder of the supervisor, a repo's
 * folder, or another folder. The daemon keeps no list of its sessions' conversations after they end, and a task's
 * conversation id differs from the task's id over ACP, so the folder and branch are what ties a conversation to its task.
 */

/** Copilot CLI's file next to the event log; the format is its own, so only these two keys are read. */
const WORKSPACE_FILE = "workspace.yaml";
const RecordedPlace = z.object({ cwd: z.string().optional(), branch: z.string().optional() });
export type RecordedPlace = z.infer<typeof RecordedPlace>;

/** What a conversation's folder recorded; empty when the file is missing or not what Copilot CLI writes. */
export async function recordedPlace(conversationDir: string): Promise<RecordedPlace> {
  try {
    return RecordedPlace.safeParse(parseYaml(await readFile(join(conversationDir, WORKSPACE_FILE), "utf8"))).data ?? {};
  } catch {
    return {};
  }
}

/** A task Trackwall knows, running or in the task journal; only a running one has its worktree. */
export interface KnownTask {
  id: string;
  repo: string;
  branch: string;
  worktree: string | null;
  title: string | null;
  prompt: string;
}

export interface KnownPlaces {
  /** The running tasks first, so a task the journal also has is found with its worktree. */
  tasks: readonly KnownTask[];
  repos: readonly { id: string; path: string }[];
  projectsDir: string | null;
  /** What every task branch starts with. */
  taskBranchPrefix: string;
}

export interface WorkPlace {
  kind: UsageWorkKind;
  task: string | null;
  repo: string | null;
  label: string;
}

const OUTSIDE: WorkPlace = { kind: "outside", task: null, repo: null, label: "" };

/** `a` and `b` name the same folder, by resolved paths and the system's case rules for them. */
function sameFolder(a: string, b: string): boolean {
  return relative(a, b) === "";
}

/** The work of a conversation that ran in `recorded.cwd` on `recorded.branch`. */
export function workPlace(recorded: RecordedPlace, known: KnownPlaces): WorkPlace {
  const { cwd, branch } = recorded;
  if (cwd === undefined) return OUTSIDE;
  if (branch?.startsWith(known.taskBranchPrefix)) return taskPlace(cwd, branch, known.tasks);
  if (known.projectsDir !== null && sameFolder(known.projectsDir, cwd)) return { kind: "supervisor", task: null, repo: null, label: "" };
  const repo = known.repos.find((r) => isInside(r.path, cwd));
  if (repo !== undefined) return { kind: "repo", task: null, repo: repo.id, label: "" };
  return OUTSIDE;
}

/**
 * The task on `branch`. The parts of a change share one branch name in several repos (ADR-171), so a running task is
 * found by its worktree, and one from the journal by its repo, the folder that holds a task's worktree (ADR-84).
 */
function taskPlace(cwd: string, branch: string, tasks: readonly KnownTask[]): WorkPlace {
  const onBranch = tasks.filter((t) => t.branch === branch);
  const task =
    onBranch.find((t) => t.worktree !== null && sameFolder(t.worktree, cwd)) ??
    onBranch.find((t) => t.repo === basename(dirname(cwd))) ??
    onBranch[0];
  if (task === undefined) return { kind: "task", task: null, repo: null, label: branch };
  return { kind: "task", task: task.id, repo: task.repo, label: taskLabel(task) };
}

function taskLabel(task: KnownTask): string {
  return cutText(task.title ?? task.prompt.trim().split("\n")[0] ?? "", USAGE_REPORT_LABEL_MAX_CHARS);
}
