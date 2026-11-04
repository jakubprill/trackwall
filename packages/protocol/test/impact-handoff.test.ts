import { describe, expect, test } from "bun:test";
import {
  type ChangedEndpoint,
  contractChange,
  endpointsCalledBy,
  handingTaskName,
  handoffPrompt,
  type ImpactedRepo,
  reachText,
  TASK_PROMPT_MAX,
} from "../src/index.ts";

const caller = (repo: string, client: string, line: number) => ({
  repo,
  via: "feign" as const,
  client,
  method: "GET" as const,
  path: "/api/orders/{id}",
  confidence: "exact" as const,
  evidence: { path: `src/${client}.java`, line },
  from: [],
});

const getOrder: ChangedEndpoint = {
  change: "changed",
  app: "orders",
  method: "GET",
  path: "/api/orders/{id}",
  before: { handler: "OrdersController.get", request: null, response: "OrderDto" },
  after: { handler: "OrdersController.get", request: null, response: "OrderDto" },
  dtos: ["OrderLine"],
  callers: [caller("orders-bff", "OrdersClient", 11), caller("legacy-reports", "OrdersReport", 17)],
};

const bff: ImpactedRepo = {
  repo: "orders-bff",
  ring: 1,
  uses: ["orders-api"],
  calls: [{ repo: "orders-api", method: "GET", path: "/api/orders/{id}", handler: "OrdersController.get" }],
  through: null,
  sure: true,
};
const web: ImpactedRepo = { repo: "shop-web", ring: 2, uses: ["orders-bff"], calls: [], through: null, sure: false };

describe("the prompt of a task handed a change (ADR-147, ADR-198)", () => {
  test("a repo of ring 1 is shown only its own calls of the changed endpoints", () => {
    expect(endpointsCalledBy([getOrder], "legacy-reports").map((e) => e.callers.map((c) => c.client))).toEqual([["OrdersReport"]]);
    expect(endpointsCalledBy([getOrder], "shop-web")).toEqual([]);
  });

  test("a hand-off to ring 1 lists what changed and where the repo calls it; one further out asks to check", () => {
    const changed = { repo: "orders-api", endpoints: [getOrder] };
    expect(handoffPrompt(changed, "Add a note to order lines", bff)).toBe(
      [
        "The task “Add a note to order lines” in orders-api changes endpoints that orders-bff calls:",
        "- changed GET /api/orders/{id} (response OrderDto); DTOs changed: OrderLine, called by OrdersClient at src/OrdersClient.java:11",
        "",
        "Update orders-bff to the new contract. Read that task's change with get_changed_endpoints and get_task_changes before you change code.",
      ].join("\n"),
    );
    expect(handoffPrompt(changed, "Add a note to order lines", web)).toBe(
      [
        "shop-web uses orders-bff, which the task “Add a note to order lines” in orders-api may reach through its changed endpoints.",
        "",
        "Check whether the change reaches shop-web, and update it if it does. Read that task's change with get_changed_endpoints and get_task_changes before you change code.",
      ].join("\n"),
    );
  });

  test("a repo of ring 1 that reaches the task's repo only by its address is asked to check, not told of calls it has none of", () => {
    const proxy: ImpactedRepo = { repo: "orders-admin", ring: 1, uses: ["orders-api"], calls: [], through: null, sure: false };
    expect(reachText({ endpoints: [getOrder] }, proxy)).toBe("uses orders-api");
    expect(handoffPrompt({ repo: "orders-api", endpoints: [getOrder] }, "Add a note", proxy).split("\n")[0]).toBe(
      "orders-admin uses orders-api, which the task “Add a note” in orders-api may reach through its changed endpoints.",
    );
  });

  test("a reached repo says what it calls: in ring 1 the changed endpoints, further out the endpoints of the ring inside", () => {
    expect(reachText({ endpoints: [getOrder] }, bff)).toBe("calls GET /api/orders/{id}");
    const gateway = {
      ...bff,
      repo: "api-gateway",
      ring: 2,
      calls: [{ repo: "orders-bff", method: "GET" as const, path: "/shop/{id}", handler: null }],
    };
    expect(reachText({ endpoints: [getOrder] }, gateway)).toBe("calls GET /shop/{id} of orders-bff");
  });

  test("a contract shows its types once when they stay, before ⇒ after when they change, and nothing without a body", () => {
    expect(contractChange(getOrder)).toBe("response OrderDto");
    expect(contractChange({ before: getOrder.before, after: { handler: null, request: "OrderLine", response: "OrderDto" } })).toBe(
      "response OrderDto ⇒ request OrderLine, response OrderDto",
    );
    expect(contractChange({ before: null, after: { handler: null, request: null, response: null } })).toBe("");
  });

  test("a hand-off to a repo calling more endpoints than a prompt holds lists those that fit and counts the rest", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ...getOrder, path: `/api/orders/{id}/part-${i}-${"x".repeat(20)}` }));
    const prompt = handoffPrompt({ repo: "orders-api", endpoints: many }, "Rename everything", bff);

    expect(prompt.length).toBeLessThanOrEqual(TASK_PROMPT_MAX);
    const lines = prompt.split("\n");
    expect(lines[0]).toBe("The task “Rename everything” in orders-api changes endpoints that orders-bff calls:");
    expect(lines.at(-3)).toMatch(/^- and \d+ more endpoints$/);
    expect(lines.at(-1)).toStartWith("Update orders-bff to the new contract.");
  });

  test("a hand-off names the handing task by its title, or by the first line of its prompt cut like a title", () => {
    expect(handingTaskName({ title: "Add a note", prompt: "add a note\nto order lines" })).toBe("Add a note");
    expect(handingTaskName({ title: null, prompt: "  add a note\nto order lines" })).toBe("add a note");
    expect(handingTaskName({ title: null, prompt: "x".repeat(200) })).toHaveLength(80);
  });
});
