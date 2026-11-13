import { availableParallelism, totalmem } from "node:os";
import type { RunningTasksWarningState } from "@trackwall/protocol";
import { configOrProblem } from "../../infra/errors.ts";

/**
 * When starting a task warns that too many run at once (ADR-244, §4.4). Each running task holds a Copilot CLI process
 * and, while it works, the builds, tests and services it runs (a Maven or Gradle build, a Java language server, a Spring
 * Boot service) on the same computer, and on a Windows machine with an antivirus every file those write is scanned
 * too, so a few tasks at once can slow all of them and the user's own editor. The warning never refuses a start: the
 * user decides, and the number is theirs to change in Settings › Agents.
 */

/** The processors and memory the daemon's computer gives it: in a container, the container's (its cgroup limit). */
export interface Computer {
  processors: number;
  memoryBytes: number;
}

const GIB = 1024 ** 3;
/** A task's share of memory: Copilot CLI with a build or a Java language server and a service. */
const MEMORY_PER_TASK_GIB = 4;
/** A task's share of processors: a build in a task takes several, an agent waiting for its model takes none. */
const PROCESSORS_PER_TASK = 2;
/** Two tasks at once are never warned about: a task and its review or a retry are the everyday case. */
const MIN_DEFAULT = 2;

/** How many tasks may run at once on `computer` before a start warns, when `workspace.yaml` does not say. */
export function computerDefault(computer: Computer): number {
  const byProcessors = Math.floor(computer.processors / PROCESSORS_PER_TASK);
  // Rounded to whole GiB first: a "16 GB" laptop reports 15.6 GiB, and should get the share of 16.
  const byMemory = Math.floor(Math.round(computer.memoryBytes / GIB) / MEMORY_PER_TASK_GIB);
  return Math.max(MIN_DEFAULT, Math.min(byProcessors, byMemory));
}

/**
 * The warning's state for the New session form and Settings: the user's `runningTasksWarning`, or the computer's default
 * without it or with a key written wrong, since a warning must not stop a start and Settings shows the key's problem.
 */
export function runningTasksWarningState(setting: () => number | null, computer: Computer): RunningTasksWarningState {
  const fallback = computerDefault(computer);
  return {
    above: configOrProblem(setting, null).value ?? fallback,
    computerDefault: fallback,
    processors: computer.processors,
    memoryGiB: Math.round((computer.memoryBytes / GIB) * 10) / 10,
  };
}

/**
 * The computer the daemon runs on, as the process sees it: the processors it may use and the smaller of the machine's
 * memory and the limit of the container or control group it runs in (`constrainedMemory`, 0 or above the memory when
 * there is none).
 */
export function daemonComputer(): Computer {
  const memory = totalmem();
  const constrained = process.constrainedMemory();
  return {
    processors: availableParallelism(),
    memoryBytes: constrained > 0 && constrained < memory ? constrained : memory,
  };
}
