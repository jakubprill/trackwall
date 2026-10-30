import { describe, expect, test } from "bun:test";
import type { Dto, ProvidedEndpoint, RepoCard } from "@trackwall/protocol";
import { endpointChanges } from "../src/modules/cards/endpoint-changes.ts";

function endpoint(path: string, response: string | null, line = 10): ProvidedEndpoint {
  return {
    kind: "endpoint",
    source: "code",
    method: "GET",
    path,
    app: "payments-service",
    handler: "PaymentsController.get",
    request: null,
    response,
    reaches: null,
    operation: null,
    evidence: { path: "src/main/java/PaymentsController.java", line },
  };
}

function card(provides: ProvidedEndpoint[], dtos: Dto[]): RepoCard {
  return {
    commit: "a".repeat(40),
    buildFiles: [],
    provides,
    consumes: [],
    dtos,
    reachTraced: true,
    tools: [],
    mise: { configFiles: [], tasks: [], complete: true },
    mechanisms: [],
    problems: [],
  };
}

const evidence = { path: "src/main/java/Payment.java", line: 3 };
const payment: Dto = { name: "Payment", kind: "record", fields: [{ name: "status", type: "PaymentStatus" }], evidence };
const status = (...values: string[]): Dto => ({ name: "PaymentStatus", kind: "enum", values, evidence });

describe("endpoints that differ between a task's base and its head (ADR-145)", () => {
  test("an endpoint whose code only moved, with the same contract and DTOs, did not change", () => {
    const before = card([endpoint("/api/payments/{id}", "Payment", 10)], [payment, status("NEW")]);
    const after = card(
      [endpoint("/api/payments/{id}", "Payment", 42)],
      [{ ...payment, evidence: { ...evidence, line: 9 } }, status("NEW")],
    );
    expect(endpointChanges(before, after)).toEqual([]);
  });

  test("a new constant of an enum reached through a DTO field changes the endpoint, which names that DTO", () => {
    const before = card([endpoint("/api/payments/{id}", "Payment")], [payment, status("NEW")]);
    const after = card([endpoint("/api/payments/{id}", "Payment")], [payment, status("NEW", "REFUNDED")]);
    expect(endpointChanges(before, after)).toEqual([
      {
        change: "changed",
        app: "payments-service",
        method: "GET",
        path: "/api/payments/{id}",
        before: { handler: "PaymentsController.get", request: null, response: "Payment" },
        after: { handler: "PaymentsController.get", request: null, response: "Payment" },
        dtos: ["PaymentStatus"],
      },
    ]);
  });

  test("a new response type changes the endpoint, and a changed path is a removed and an added endpoint", () => {
    const before = card([endpoint("/api/payments/{id}", "Payment"), endpoint("/api/refunds", null)], []);
    const after = card([endpoint("/api/payments/{id}", "PaymentView"), endpoint("/api/v2/refunds", null)], []);
    expect(endpointChanges(before, after).map((c) => [c.change, c.path, c.before?.response, c.after?.response])).toEqual([
      ["changed", "/api/payments/{id}", "Payment", "PaymentView"],
      ["removed", "/api/refunds", null, undefined],
      ["added", "/api/v2/refunds", undefined, null],
    ]);
  });
});
