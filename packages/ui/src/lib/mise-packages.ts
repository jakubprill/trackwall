import { type MisePackage, type MiseTask, splitPackageTask } from "@trackwall/protocol";

/**
 * The mise tasks of a repo split into the repo root's and one group per package (ADR-305), for the "mise tasks" tab.
 * Pure functions, tested in `test/mise-packages.test.ts`.
 */

/** A mise task of a package with the name mise gives it in the package's folder, shown in the package's group. */
interface PackageMiseTask {
  task: MiseTask;
  shortName: string;
}

export interface MisePackageGroup {
  path: string;
  problem: MisePackage["problem"];
  tasks: PackageMiseTask[];
}

/**
 * The root's mise tasks in the daemon's order, then one group per package in the order of `packages`. A running mise task
 * of a package the daemon no longer finds (its config removed while it ran) gets a group of its own after them, so it can
 * still be stopped.
 */
export function groupByPackage(
  tasks: readonly MiseTask[],
  packages: readonly MisePackage[],
): { root: MiseTask[]; packages: MisePackageGroup[] } {
  const root: MiseTask[] = [];
  const groups = new Map<string, MisePackageGroup>(packages.map((p) => [p.path, { path: p.path, problem: p.problem, tasks: [] }]));
  for (const task of tasks) {
    const { package: pkg, task: shortName } = splitPackageTask(task.name);
    if (pkg === null) {
      root.push(task);
      continue;
    }
    const group = groups.get(pkg) ?? { path: pkg, problem: null, tasks: [] };
    group.tasks.push({ task, shortName });
    groups.set(pkg, group);
  }
  return { root, packages: [...groups.values()] };
}
