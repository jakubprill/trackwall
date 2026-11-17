import { describe, expect, test } from "bun:test";
import type { ProposedBy } from "@trackwall/protocol";
import { secondInTreeRefusal, treeOf, treeWork } from "../src/modules/agents/task-tree.ts";

const byTask = (task: string): ProposedBy => ({ session: `session of ${task}`, supervisor: false, task });
const bySession: ProposedBy = { session: "main", supervisor: false, task: null };

// The run that found it: the root task in employee-service proposed department-service and organization-service.
const tasks = [
  { id: "root", repo: "employee-service", title: "Add the employee email", proposedBy: bySession },
  { id: "department", repo: "department-service", title: "Pass the email on", proposedBy: byTask("root") },
  { id: "organization", repo: "organization-service", title: "Expose the email", proposedBy: byTask("root") },
  { id: "other", repo: "organization-service", title: "Unrelated work", proposedBy: bySession },
];

describe("task trees", () => {
  test("a task's tree is the topmost task along its proposers, also when a proposer in between has ended", () => {
    expect(treeOf("department", tasks)).toBe("root");
    expect(treeOf("root", tasks)).toBe("root");
    expect(treeOf("other", tasks)).toBe("other");
    const grandchild = { id: "grandchild", repo: "gateway", title: null, proposedBy: byTask("department") };
    const departmentEnded = [grandchild, ...tasks.filter((t) => t.id !== "department")];
    expect(treeOf("grandchild", departmentEnded)).toBe("department");
  });

  test("a tree's work is its open tasks and the proposals its tasks made, not the work of another tree", () => {
    const proposals = [
      { id: "p1", repo: "gateway", parts: null, title: "Show the email", proposedBy: byTask("organization"), fromImpact: false },
      { id: "p2", repo: "billing", parts: null, title: "Bill by email", proposedBy: byTask("other"), fromImpact: true },
    ];
    expect(treeWork("department", tasks, proposals).map((w) => [w.kind, w.id, w.repos])).toEqual([
      ["task", "root", ["employee-service"]],
      ["task", "department", ["department-service"]],
      ["task", "organization", ["organization-service"]],
      ["proposal", "p1", ["gateway"]],
    ]);
  });

  test("proposers that name each other end the walk instead of looping", () => {
    const loop = [
      { id: "a", proposedBy: byTask("b") },
      { id: "b", proposedBy: byTask("a") },
    ];
    expect(treeOf("a", loop)).toBe("b");
  });

  test("a task may not propose a repo another branch of its tree covers, but may split its own line's work", () => {
    expect(secondInTreeRefusal("department", "organization-service", tasks, [])).toStartWith(
      "task `organization` (Expose the email) of the same work already works in organization-service",
    );
    expect(secondInTreeRefusal("department", "department-service", tasks, [])).toBeNull();
    expect(secondInTreeRefusal("department", "employee-service", tasks, [])).toBeNull();
    const own = { id: "p3", repo: "gateway", parts: null, title: "Gateway", proposedBy: byTask("department"), fromImpact: false };
    expect(secondInTreeRefusal("department", "gateway", tasks, [own])).toBeNull();
    expect(secondInTreeRefusal("organization", "gateway", tasks, [own])).toStartWith(
      "task `p3` (Gateway) of the same work is already proposed in gateway",
    );
    expect(secondInTreeRefusal("organization", "gateway", tasks, [{ ...own, fromImpact: true }])).toBeNull();
  });
});
