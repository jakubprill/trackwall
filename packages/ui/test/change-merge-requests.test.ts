import { describe, expect, test } from "bun:test";
import type { FollowedMergeRequest, MergeRequestState, Task, TaskBranchPush, TaskMergeRequest, TaskOutcome } from "@trackwall/protocol";
import {
  type ChangePart,
  changeBlock,
  changeLinks,
  changePartsOf,
  mergeOrderNote,
  pushAllParts,
  pushAllSummary,
} from "../src/lib/change-merge-requests.ts";

const CHANGE = "7c1d2e3f-0000-4000-8000-000000000000";
const BRANCH = "trackwall/rename-the-order-total-1a2b3c";

const part = (id: string, repo: string, position: number | null): Task => ({
  id,
  repo,
  prompt: "Rename the order total",
  branch: position === null ? `trackwall/other-${id}` : BRANCH,
  baseBranch: "main",
  base: "a".repeat(40),
  worktree: `/w/${repo}/rename-the-order-total-1a2b3c`,
  createdAt: "2026-11-02T09:00:00Z",
  title: null,
  proposedBy: null,
  model: null,
  approvals: "ask",
  javaNavigation: false,
  item: null,
  view: "terminal",
  summary: null,
  port: 41000,
  included: { files: [], problems: [] },
  change: position === null ? null : { id: CHANGE, position },
});

const mergeRequest = (path: string, number: number, state: MergeRequestState): FollowedMergeRequest => ({
  number,
  title: "Rename the order total",
  url: `https://gitlab.example.com/${path}/-/merge_requests/${number}`,
  state,
  pipeline: null,
  project: { kind: "gitlab", host: "gitlab.example.com", path },
  pipelineFailedAt: null,
});

const payments = part("t1", "payments", 0);
const ordersApi = part("t2", "orders-api", 1);
const shopWeb = part("t3", "shop-web", 2);
const unrelated = part("t4", "docs", null);

const parts = (states: { payments?: MergeRequestState; ordersApi?: MergeRequestState }): ChangePart[] => [
  { task: payments, number: 1, mergeRequest: states.payments ? mergeRequest("group/payments", 12, states.payments) : null },
  { task: ordersApi, number: 2, mergeRequest: states.ordersApi ? mergeRequest("group/orders-api", 7, states.ordersApi) : null },
  { task: shopWeb, number: 3, mergeRequest: null },
];

describe("the parts of a change", () => {
  test("are the listed tasks of the same change in their merge order, each with the merge request the daemon follows", () => {
    const outcome: TaskOutcome = {
      task: "t1",
      repo: "payments",
      verification: null,
      mergeRequest: mergeRequest("group/payments", 12, "open"),
    };

    expect(changePartsOf(ordersApi, [shopWeb, unrelated, ordersApi, payments], new Map([["t1", outcome]]))).toEqual([
      { task: payments, number: 1, mergeRequest: mergeRequest("group/payments", 12, "open") },
      { task: ordersApi, number: 2, mergeRequest: null },
      { task: shopWeb, number: 3, mergeRequest: null },
    ]);
  });

  test("a task that is no part of a change has none", () => {
    expect(changePartsOf(unrelated, [payments, unrelated], new Map())).toBeNull();
  });
});

describe("the change block of a merge request", () => {
  test("lists every repo in the merge order with its merge request, this one named as such", () => {
    expect(changeBlock(ordersApi, parts({ payments: "merged" }))).toBe(
      `This merge request is part 2 of a change across several repos, all on the branch \`${BRANCH}\`. Merge in this order:\n\n` +
        "- Part 1, `payments`: [group/payments!12](https://gitlab.example.com/group/payments/-/merge_requests/12) (merged)\n" +
        "- Part 2, `orders-api`: this merge request\n" +
        "- Part 3, `shop-web`: no merge request yet",
    );
  });

  test("keeps the numbers of the parts still listed, so a part that ended leaves a gap the repo host does not renumber", () => {
    const listed = changePartsOf(shopWeb, [shopWeb, payments], new Map());

    expect(changeBlock(shopWeb, listed)).toBe(
      `This merge request is part 3 of a change across several repos, all on the branch \`${BRANCH}\`. Merge in this order:\n\n` +
        "- Part 1, `payments`: no merge request yet\n" +
        "- Part 3, `shop-web`: this merge request",
    );
  });

  test("encodes what would end a link in the repo host's address", () => {
    const odd = { ...mergeRequest("group/payments", 12, "open"), url: "https://git.example.com/a (b)/-/merge_requests/12" };

    expect(
      changeBlock(ordersApi, [
        { task: payments, number: 1, mergeRequest: odd },
        { task: ordersApi, number: 2, mergeRequest: null },
      ]),
    ).toContain("[group/payments!12](https://git.example.com/a%20%28b%29/-/merge_requests/12) (open)");
  });

  test("is none for a task that is no part of a change, or not among the parts", () => {
    expect(changeBlock(unrelated, null)).toBeNull();
    expect(changeBlock(unrelated, parts({}))).toBeNull();
  });
});

describe("the links to copy", () => {
  test("list every part with its merge request, for a comment on the ones opened earlier", () => {
    expect(changeLinks(payments, parts({ payments: "open", ordersApi: "open" }))).toBe(
      `Part of a change across several repos, all on the branch \`${BRANCH}\`. Merge in this order:\n\n` +
        "- Part 1, `payments`: [group/payments!12](https://gitlab.example.com/group/payments/-/merge_requests/12) (open)\n" +
        "- Part 2, `orders-api`: [group/orders-api!7](https://gitlab.example.com/group/orders-api/-/merge_requests/7) (open)\n" +
        "- Part 3, `shop-web`: no merge request yet",
    );
  });
});

describe("the merge order note", () => {
  test("reminds a waiting part of the earlier parts that are not merged", () => {
    const all = parts({ payments: "open", ordersApi: "open" });
    expect(mergeOrderNote({ task: ordersApi, number: 2, mergeRequest: mergeRequest("group/orders-api", 7, "open") }, all)).toEqual({
      text: "Merge after payments, which comes earlier in the change.",
    });
  });

  test("warns once a part was merged before an earlier part", () => {
    const all = parts({ ordersApi: "merged" });
    expect(mergeOrderNote({ task: ordersApi, number: 2, mergeRequest: mergeRequest("group/orders-api", 7, "merged") }, all)).toEqual({
      tone: "warning",
      text: "Merged before payments, which comes earlier in the change and is not merged yet.",
    });
  });

  test("says nothing for the first part, or once every earlier part is merged", () => {
    expect(mergeOrderNote({ task: payments, number: 1, mergeRequest: null }, parts({}))).toBeNull();
    expect(mergeOrderNote({ task: ordersApi, number: 2, mergeRequest: null }, parts({ payments: "merged" }))).toBeNull();
  });
});

describe("pushing all parts", () => {
  const branch = (fields: Partial<TaskBranchPush>): TaskBranchPush => ({
    remote: "origin",
    commits: 2,
    published: false,
    unpushed: 2,
    behind: 0,
    uncommitted: 0,
    ...fields,
  });
  const state = (task: string, push: TaskBranchPush | null): TaskMergeRequest => ({
    task,
    push,
    project: { kind: "gitlab", host: "gitlab.example.com", path: "group/x" },
    lookup: null,
    targetBranch: "main",
  });

  test("pushes one part after another, skips a part with nothing to push and goes on after a failure", async () => {
    const pushed: string[] = [];
    const states: Record<string, TaskMergeRequest> = {
      t1: state("t1", branch({})),
      t2: state("t2", branch({ published: true, unpushed: 0 })),
      t3: state("t3", branch({})),
    };
    const pushes = await pushAllParts(parts({}), {
      get: async (task) => states[task] ?? state(task, null),
      push: async (task) => {
        if (task === "t3") throw new Error("the remote refused the push");
        pushed.push(task);
      },
    });

    expect(pushed).toEqual(["t1"]);
    expect(pushes).toEqual([
      { repo: "payments", kind: "pushed" },
      { repo: "orders-api", kind: "nothing" },
      { repo: "shop-web", kind: "failed", message: "the remote refused the push" },
    ]);
    expect(pushAllSummary(pushes)).toEqual({
      tone: "error",
      text: "Pushed payments · nothing to push in orders-api · shop-web: the remote refused the push",
    });
  });

  test("sums up a push of every part without a failure in the ok tone", () => {
    expect(
      pushAllSummary([
        { repo: "payments", kind: "pushed" },
        { repo: "orders-api", kind: "pushed" },
      ]),
    ).toEqual({
      tone: "ok",
      text: "Pushed payments, orders-api",
    });
  });
});
