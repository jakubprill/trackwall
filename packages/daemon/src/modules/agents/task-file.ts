import { isAbsolute } from "node:path";
import { noIncludedFiles, Task } from "@trackwall/protocol";
import { z } from "zod";
import { writeFileAtomic } from "../../infra/atomic-write.ts";
import { readStateFile } from "./state-file.ts";
import { TaskBranch } from "./task-branch.ts";
import { MAX_MISE_PATH } from "./task-mise-config.ts";

/**
 * `tasks.json` in the state directory (ADR-31): tasks survive a daemon restart, because their worktrees and branches
 * stay on disk until the user ends them. A task session lives only in memory, and the worktree follows from the task
 * worktrees folder, the repo and the branch (`taskWorktree`), so neither of them is stored. The file can be edited by hand, and its fields go to git
 * (`branch -D`, `diff <base commit>`), so the schema allows only a task branch and a full commit hash (`CommitHash` in `Task`).
 * Fields added later (title, origin and summary, ADR-39; the trusted mise config, ADR-59; the port and the included
 * files, ADR-61; the task worktrees folder, ADR-84; the model, ADR-98; the approvals mode, ADR-105) have a default in the file, so tasks saved by an older version are not moved aside as an unreadable file.
 */

export const StoredTask = Task.omit({ worktree: true }).extend({
  branch: TaskBranch,
  title: Task.shape.title.default(null),
  proposedBy: Task.shape.proposedBy.default(null),
  model: Task.shape.model.default(null),
  approvals: Task.shape.approvals.default("ask"),
  summary: Task.shape.summary.default(null),
  /** `null` in a task saved by an older version: `AgentTasks` gives it a free port when it reads the file. */
  port: Task.shape.port.nullable().default(null),
  included: Task.shape.included.default(noIncludedFiles),
  /**
   * The worktree's mise config the user trusted (ADR-59): path to SHA-256, taken when the worktree was created and
   * replaced when the user trusts a changed one. `null` in a task saved by an older version, whose config then needs
   * the user's trust once.
   */
  trustedMiseConfig: z
    .record(z.string().max(MAX_MISE_PATH), z.string().regex(/^[0-9a-f]{64}$/))
    .nullable()
    .default(null),
  /**
   * The task worktrees folder the task's worktree went into (ADR-84), so that changing the setting does not lose the
   * worktrees of existing tasks. `null` in a task saved by an older version: its worktree is in `worktrees/` of the state directory.
   */
  worktreesDir: z.string().max(4096).refine(isAbsolute, "task worktrees folder must be a full path").nullable().default(null),
  /** The root of the repo in the projects folder the task came from: git keeps the worktree registry and the branch there. */
  repoDir: z.string().refine(isAbsolute, "repo root must be a full path"),
});
export type StoredTask = z.infer<typeof StoredTask>;

const TaskFileSchema = z.object({ tasks: z.array(StoredTask) });

export class TaskFile {
  readonly #path: string;
  readonly #log: (msg: string) => void;

  constructor(path: string, log: (msg: string) => void) {
    this.#path = path;
    this.#log = log;
  }

  /** A missing file means no tasks. An unreadable file is moved aside (`tasks.json.broken-<time>`), and its tasks go to the log. */
  read(): StoredTask[] {
    const file = readStateFile(this.#path, TaskFileSchema, (problem, aside) =>
      this.#log(`${this.#path}: ${problem}; file moved to ${aside}, task worktrees were left on disk`),
    );
    return file?.tasks ?? [];
  }

  write(tasks: readonly StoredTask[]): void {
    writeFileAtomic(this.#path, `${JSON.stringify({ tasks }, null, 2)}\n`);
  }
}
