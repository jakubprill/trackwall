import { describe, expect, test } from "bun:test";
import { httpPathSegments, type ProvidedEndpoint } from "@trackwall/protocol";
import { matchEndpoint, parseEndpointQuery } from "../src/modules/graph/endpoint-query.ts";

const ENDPOINT: ProvidedEndpoint = {
  kind: "endpoint",
  source: "openapi",
  method: "PUT",
  path: "/orders-service/api/orders/{id}/cancel",
  app: "orders-api",
  handler: "OrdersController.cancelOrder",
  request: null,
  response: null,
  reaches: null,
  operation: { id: "cancelOrder", summary: "Cancel an order before it ships", evidence: { path: "openapi.yaml", line: 9 } },
  evidence: { path: "openapi.yaml", line: 9 },
};

function match(query: string, endpoint: ProvidedEndpoint = ENDPOINT) {
  return matchEndpoint(parseEndpointQuery(query), endpoint, httpPathSegments(endpoint.path));
}

describe("find_endpoint query (ADR-87)", () => {
  test("a method in front of the path, a whole address with a query and a path without the leading / are paths", () => {
    expect(parseEndpointQuery("put https://gateway.example.com/orders-service/api/orders/42/cancel?force=true")).toMatchObject({
      method: "PUT",
      segments: ["orders-service", "api", "orders", "42", "cancel"],
    });
    expect(parseEndpointQuery("api/orders/42").segments).toEqual(["api", "orders", "42"]);
    expect(parseEndpointQuery("cancel order")).toEqual({ method: undefined, segments: undefined, words: ["cancel", "order"] });
  });

  test("a whole concrete path matches the endpoint path, and its end too: without the context path or with a gateway prefix", () => {
    expect(match("/orders-service/api/orders/42/cancel")).toBe("path");
    expect(match("/api/orders/42/cancel")).toBe("path-end");
    expect(match("https://gateway.example.com/shop/orders-service/api/orders/42/cancel")).toBe("path-end");
    expect(match("orders/42/cancel")).toBe("path-end");
  });

  test("the end of a path matches only with a fixed segment equal on both sides", () => {
    // `42` is a value in place of `{id}`, and `/cancel/42` has `cancel` elsewhere.
    expect(match("/42/cancel/x")).toBeUndefined();
    expect(match("/archive/{id}/cancel")).toBeUndefined();
    expect(match("/42")).toBeUndefined();
  });

  test("words match the path, handler, app, operation id and summary, every word somewhere, case-insensitive", () => {
    expect(match("cancel SHIPS")).toBe("text");
    expect(match("ordersController")).toBe("text");
    expect(match("orders-api cancel")).toBe("text");
    expect(match("cancel refund")).toBeUndefined();
    expect(match("/orders/{id}")).toBe("text");
  });
});
