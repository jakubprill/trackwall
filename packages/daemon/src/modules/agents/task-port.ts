import { TASK_PORT_FIRST, TASK_PORT_LAST } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";

/**
 * Task ports (§4.4, ADR-61): the lowest port of the range that no other task holds. Nothing is probed here: a port
 * a program outside Trackwall listens on shows when the task's service starts (`services` refuses a port that already
 * answers), and probing every port on each task creation would cost more than that rare case.
 */
export function freeTaskPort(taken: Iterable<number>): number {
  const used = new Set(taken);
  for (let port = TASK_PORT_FIRST; port <= TASK_PORT_LAST; port++) if (!used.has(port)) return port;
  throw new DomainError(
    "bad_request",
    `every task port from ${TASK_PORT_FIRST} to ${TASK_PORT_LAST} is taken; end tasks you no longer need`,
  );
}

/**
 * The tasks of `tasks.json`, each with a port of its own: a task saved before ADR-61 gets the lowest free one once and
 * keeps it from then on, and of tasks holding the same port (a hand-edited file) the first keeps it.
 */
export function withTaskPorts<T extends { port: number | null }>(tasks: readonly T[]): (T & { port: number })[] {
  const held = new Set<number>();
  const kept = tasks.map((task) => {
    if (task.port === null || held.has(task.port)) return null;
    held.add(task.port);
    return task.port;
  });
  return tasks.map((task, i) => {
    const port = kept[i] ?? freeTaskPort(held);
    held.add(port);
    return { ...task, port };
  });
}
