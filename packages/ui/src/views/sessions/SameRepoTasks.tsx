import { countLabel, type Task } from "@trackwall/protocol";

/**
 * Before a proposal starts: the tasks that already work in its repo. Which files a proposal will change is not known
 * yet, so this is the early form of the shared-files warning of a running task (ADR-44, ADR-55): only a hint.
 */
export function SameRepoTasks({ repo, tasks }: { repo: string; tasks: readonly Task[] }) {
  const same = tasks.filter((t) => t.repo === repo);
  if (same.length === 0) return null;
  return (
    <p className="text-warning text-xs">
      {`${repo} already has ${countLabel(same.length, { one: "task", other: "tasks" })}; they may change the same files.`}
    </p>
  );
}
