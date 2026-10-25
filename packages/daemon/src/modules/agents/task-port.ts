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
