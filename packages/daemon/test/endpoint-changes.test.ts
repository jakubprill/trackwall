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

const getPayment = { handler: "PaymentsController.get", request: null, response: "Payment" };

describe("endpoints that differ between a task's base and its head (ADR-145)", () => {
  test("an endpoint whose code only moved, with the same contract and DTOs, did not change", () => {
    const before = card([endpoint("/api/payments/{id}", "Payment", 10)], [payment, status("NEW")]);
    const after = card(
      [endpoint("/api/payments/{id}", "Payment", 42)],
      [{ ...payment, evidence: { ...evidence, line: 9 } }, status("NEW")],
    );
    expect(endpointChanges(before, after)).toEqual({ changes: [], contractsCompared: true });
  });

  test("a new constant of an enum reached through a DTO field changes the endpoint, which names that DTO", () => {
    const before = card([endpoint("/api/payments/{id}", "Payment")], [payment, status("NEW")]);
    const after = card([endpoint("/api/payments/{id}", "Payment")], [payment, status("NEW", "REFUNDED")]);
    expect(endpointChanges(before, after).changes).toEqual([
      {
        change: "changed",
        app: "payments-service",
        method: "GET",
        path: "/api/payments/{id}",
        before: getPayment,
        after: getPayment,
        dtos: ["PaymentStatus"],
      },
    ]);
  });

  test("a DTO field only the base reached, dropped from the head, changes the endpoint", () => {
    const before = card([endpoint("/api/payments/{id}", "Payment")], [payment, status("NEW")]);
    const after = card([endpoint("/api/payments/{id}", "Payment")], [{ ...payment, fields: [] }]);
    expect(endpointChanges(before, after).changes.map((c) => c.dtos)).toEqual([["Payment", "PaymentStatus"]]);
  });

  test("a new response type changes the endpoint, and a changed path is a removed and an added endpoint", () => {
    const before = card([endpoint("/api/payments/{id}", "Payment"), endpoint("/api/refunds", null)], []);
    const after = card([endpoint("/api/payments/{id}", "PaymentView"), endpoint("/api/v2/refunds", null)], []);
    const where = { app: "payments-service", method: "GET" } as const;
    const refunds = { handler: "PaymentsController.get", request: null, response: null };
    expect(endpointChanges(before, after).changes).toEqual([
      {
        change: "changed",
        ...where,
        path: "/api/payments/{id}",
        before: getPayment,
        after: { ...getPayment, response: "PaymentView" },
        dtos: [],
      },
      { change: "removed", ...where, path: "/api/refunds", before: refunds, after: null, dtos: [] },
      { change: "added", ...where, path: "/api/v2/refunds", before: null, after: refunds, dtos: [] },
    ]);
  });

  test("two endpoints on the same app, method and path pair by handler, so removing one is reported", () => {
    const csv = { ...endpoint("/api/payments", "String"), handler: "PaymentsController.csv" };
    const json = { ...endpoint("/api/payments", "Payment"), handler: "PaymentsController.json" };
    expect(endpointChanges(card([csv, json], [payment]), card([json], [payment])).changes).toEqual([
      {
        change: "removed",
        app: "payments-service",
        method: "GET",
        path: "/api/payments",
        before: { handler: "PaymentsController.csv", request: null, response: "String" },
        after: null,
        dtos: [],
      },
    ]);
  });

  test("a card that was not fully parsed compares no contracts, only which endpoints came and went", () => {
    const unparsed = { ...card([endpoint("/api/payments/{id}", null), endpoint("/api/v2/refunds", null)], []) };
    unparsed.problems = [
      {
        code: "parse-incomplete",
        path: "",
        message:
          "Java and Kotlin parsers could not be loaded (no grammar); endpoints have no request and response types and the card has no DTOs",
      },
    ];
    const result = endpointChanges(card([endpoint("/api/payments/{id}", "Payment")], [payment]), unparsed);
    expect(result.contractsCompared).toBe(false);
    expect(result.changes.map((c) => `${c.change} ${c.path}`)).toEqual(["added /api/v2/refunds"]);
  });

  test("a card whose endpoint reach was not traced still compares contracts, since its types and DTOs are all there", () => {
    const untraced = card([endpoint("/api/payments/{id}", "PaymentView")], []);
    untraced.problems = [{ code: "parse-incomplete", path: "", message: "parsing took too long; endpoints have no reach" }];
    const result = endpointChanges(card([endpoint("/api/payments/{id}", "Payment")], []), untraced);
    expect(result.contractsCompared).toBe(true);
    expect(result.changes.map((c) => `${c.change} ${c.path}`)).toEqual(["changed /api/payments/{id}"]);
  });

  test("a card whose DTO list was cut compares no contracts", () => {
    const cut = card([endpoint("/api/payments/{id}", "Payment")], []);
    cut.problems = [{ code: "truncated", path: "", message: "the repo has more than 500 DTOs; the card lists the first ones" }];
    expect(endpointChanges(card([endpoint("/api/payments/{id}", "Payment")], [payment]), cut)).toEqual({
      changes: [],
      contractsCompared: false,
    });
  });
});
