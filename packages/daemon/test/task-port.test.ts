import { describe, expect, test } from "bun:test";
import { freeTaskPort, withTaskPorts } from "../src/modules/agents/task-port.ts";

describe("task ports (ADR-61)", () => {
  test("a new task gets the lowest port no other task holds", () => {
    expect(freeTaskPort([41000, 41002])).toBe(41001);
  });

  test("tasks read from tasks.json keep their ports; one without a port, or with a port another task holds, gets a free one", () => {
    const tasks = [
      { id: "a", port: 41001 },
      { id: "b", port: null },
      { id: "c", port: 41001 },
      { id: "d", port: 41000 },
    ];

    expect(withTaskPorts(tasks).map((t) => [t.id, t.port])).toEqual([
      ["a", 41001],
      ["b", 41002],
      ["c", 41003],
      ["d", 41000],
    ]);
  });
});
