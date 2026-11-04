import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { cutText, USAGE_REPORT_LABEL_MAX_CHARS, type UsageWorkKind } from "@trackwall/protocol";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { isInside, isSamePath } from "../../infra/path-inside.ts";
import { readRegularFile } from "../../infra/regular-file.ts";

/**
 * Which work a Copilot CLI conversation was for (ADR-195), from the folder and git branch Copilot CLI records in the
 * conversation's `workspace.yaml`: a task's worktree on a task branch, the projects folder of the supervisor, a repo's
 * folder, or another folder. The daemon keeps no list of its sessions' conversations after they end, and a task's
 * conversation id differs from the task's id over ACP, so the folder and branch are what ties a conversation to its task.
 */

/** Copilot CLI's file next to the event log; the format is its own, so only these two keys are read. */
const WORKSPACE_FILE = "workspace.yaml";
/** Far more than the few keys Copilot CLI writes. */
const WORKSPACE_FILE_MAX_BYTES = 64 * 1024;
const RecordedPlace = z.object({ cwd: z.string().optional(), branch: z.string().optional() });
export type RecordedPlace = z.infer<typeof RecordedPlace>;

/**
 * What a conversation's folder recorded; empty when the file is missing, not a regular file (an agent can write into
 * Copilot CLI's home) or not what Copilot CLI writes.
 */
export async function recordedPlace(conversationDir: string): Promise<RecordedPlace> {
  try {
    const content = await readRegularFile(join(conversationDir, WORKSPACE_FILE), WORKSPACE_FILE_MAX_BYTES);
    if (content === undefined) return {};
    const recorded = RecordedPlace.safeParse(parseYaml(content.toString("utf8"))).data ?? {};
    // By its real path like the known places (`withRealPaths`): on Windows Copilot CLI keeps the path it started in, a
    // `subst` drive or a junction as typed.
    return recorded.cwd === undefined ? recorded : { ...recorded, cwd: await realPathOf(recorded.cwd) };
  } catch {
    return {};
  }
}

/**
 * A task Trackwall knows, running or in the task journal, with the worktree it has or had; `null` for an ended one
 * when the worktrees folder cannot be read now.
 */
export interface KnownTask {
  id: string;
  repo: string;
  branch: string;
  worktree: string | null;
  title: string | null;
  prompt: string;
}

export interface KnownPlaces {
  tasks: readonly KnownTask[];
  repos: readonly { id: string; path: string }[];
  projectsDir: string | null;
  /** Whether a branch is a task branch, for one whose task Trackwall no longer knows. */
  isTaskBranch: (branch: string) => boolean;
}

export interface WorkPlace {
  kind: UsageWorkKind;
  task: string | null;
  repo: string | null;
  label: string;
}

const OUTSIDE: WorkPlace = { kind: "outside", task: null, repo: null, label: "" };

/** The work of a conversation that ran in `recorded.cwd` on `recorded.branch`. */
export function workPlace(recorded: RecordedPlace, known: KnownPlaces): WorkPlace {
  const { cwd, branch } = recorded;
  if (cwd === undefined) return OUTSIDE;
  if (branch !== undefined && known.isTaskBranch(branch)) return taskPlace(cwd, branch, known.tasks);
  if (known.projectsDir !== null && isSamePath(known.projectsDir, cwd)) return { kind: "supervisor", task: null, repo: null, label: "" };
  const repo = known.repos.find((r) => isInside(r.path, cwd));
  if (repo !== undefined) return { kind: "repo", task: null, repo: repo.id, label: "" };
  return OUTSIDE;
}

/**
 * The task on `branch`, found by its worktree, since the parts of a change share one branch name in several repos
 * (ADR-171). When the worktrees folder changed since, by the repo, the folder above a task's worktree wherever the
 * worktrees folder is (ADR-84), and then by the branch alone, but only when one task has it.
 */
function taskPlace(cwd: string, branch: string, tasks: readonly KnownTask[]): WorkPlace {
  const onBranch = tasks.filter((t) => t.branch === branch);
  const task =
    onBranch.find((t) => t.worktree !== null && isSamePath(t.worktree, cwd)) ??
    onBranch.find((t) => t.repo === basename(dirname(cwd))) ??
    (onBranch.length === 1 ? onBranch[0] : undefined);
  if (task === undefined) return { kind: "task", task: null, repo: null, label: branch };
  return { kind: "task", task: task.id, repo: task.repo, label: taskLabel(task) };
}

function taskLabel(task: KnownTask): string {
  return cutText(task.title ?? task.prompt.trim().split("\n")[0] ?? "", USAGE_REPORT_LABEL_MAX_CHARS);
}

/**
 * The places by their real paths: Copilot CLI records a conversation's folder by its real path (on macOS
 * `/private/var/…` for a temporary `/var/…`), while Trackwall keeps the paths as configured. An ended task's worktree
 * is gone, so a path that does not exist takes the real path of the nearest folder above it that does.
 */
export async function withRealPaths(known: KnownPlaces): Promise<KnownPlaces> {
  return {
    ...known,
    tasks: await Promise.all(known.tasks.map(async (t) => ({ ...t, worktree: t.worktree === null ? null : await realPathOf(t.worktree) }))),
    repos: await Promise.all(known.repos.map(async (r) => ({ ...r, path: await realPathOf(r.path) }))),
    projectsDir: known.projectsDir === null ? null : await realPathOf(known.projectsDir),
  };
}

async function realPathOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(await realPathOf(parent), basename(path));
  }
}
