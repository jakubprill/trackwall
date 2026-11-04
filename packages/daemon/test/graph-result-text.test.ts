import { describe, expect, test } from "bun:test";
import type { FindEndpointResult, FoundEndpoint, Subgraph, WhoCallsResult } from "@trackwall/protocol";
import { findEndpointText } from "../src/mcp/endpoint-text.ts";
import { subgraphText, whoCallsText } from "../src/mcp/graph-text.ts";

describe("who_calls text", () => {
  test("puts one line per connection and its evidence under it, by the side of the connection it is in", () => {
    const result: WhoCallsResult = {
      repo: "orders",
      edges: [
        {
          from: "web",
          to: "orders",
          kind: "calls",
          source: "http",
          key: "orders",
          confidence: "exact",
          evidence: [
            { repo: "web", path: "src/OrdersClient.java", line: 9, detail: "Feign client OrdersClient: orders" },
            { repo: "orders", path: "src/main/resources/application.yml", line: 3, detail: "app orders on port 8081" },
          ],
        },
        {
          from: "reports",
          to: "orders",
          kind: "depends-on",
          source: "manual",
          key: "reads the orders schema",
          confidence: "exact",
          evidence: [{ repo: null, path: "/home/me/projects/workspace.yaml", line: 12, detail: "manual edge" }],
        },
      ],
    };
    expect(whoCallsText(result)).toBe(
      [
        "2 connections into orders:",
        "web -> orders: calls by http orders (exact)",
        "  from src/OrdersClient.java:9: Feign client OrdersClient: orders",
        "  to src/main/resources/application.yml:3: app orders on port 8081",
        "reports -> orders: depends-on by manual reads the orders schema (exact)",
        "  /home/me/projects/workspace.yaml:12: manual edge",
      ].join("\n"),
    );
  });

  test("says so when no repo uses the repo", () => {
    expect(whoCallsText({ repo: "orders", edges: [] })).toBe("No repo uses orders.");
  });
});

describe("subgraph_for text", () => {
  test("lists the repos with their facts, the connections and the problems, each under its heading", () => {
    const result: Subgraph = {
      repo: "web",
      depth: 1,
      nodes: [
        { repo: "web", remote: "git.example.com/shop/web", tags: ["frontend"], provides: 0, apps: [], endpoints: 0, problem: null },
        { repo: "orders", remote: null, tags: ["backend", "java"], provides: 1, apps: ["orders"], endpoints: 3, problem: null },
        { repo: "broken", remote: null, tags: [], provides: null, apps: [], endpoints: null, problem: "git cannot read HEAD" },
      ],
      edges: [
        {
          from: "web",
          to: "orders",
          kind: "calls",
          source: "http",
          key: "localhost:8081",
          confidence: "medium",
          evidence: [{ repo: "web", path: ".env", line: 2, detail: ".env variable API_URL: http://localhost:8081" }],
        },
      ],
      problems: [
        {
          code: "unresolved-call-target",
          repo: "web",
          via: "env",
          client: "PAYMENTS_URL",
          evidence: { path: ".env", line: 3 },
          message: "no repo in the list serves payments.example.com",
        },
      ],
    };
    expect(subgraphText(result)).toBe(
      [
        "Subgraph of web, depth 1: 3 repos, 1 connection.",
        "## Repos",
        "web: remote git.example.com/shop/web; tags frontend",
        "orders: tags backend, java; apps orders; 1 package; 3 endpoints",
        "broken: no card: git cannot read HEAD",
        "## Connections",
        "web -> orders: calls by http localhost:8081 (medium)",
        "  from .env:2: .env variable API_URL: http://localhost:8081",
        "## Problems",
        "unresolved-call-target in web .env:3 (env PAYMENTS_URL): no repo in the list serves payments.example.com",
      ].join("\n"),
    );
  });

  test("leaves out the headings of connections and problems when there are none", () => {
    const lonely: Subgraph = {
      repo: "tools",
      depth: 2,
      nodes: [{ repo: "tools", remote: null, tags: [], provides: 0, apps: [], endpoints: 0, problem: null }],
      edges: [],
      problems: [],
    };
    expect(subgraphText(lonely)).toBe(["Subgraph of tools, depth 2: 1 repo, 0 connections.", "## Repos", "tools"].join("\n"));
  });
});

describe("find_endpoint text", () => {
  const getOrder: FoundEndpoint = {
    repo: "orders",
    match: "path",
    app: "orders",
    method: "GET",
    path: "/api/orders/{id}",
    handler: "OrdersController.get",
    source: "code",
    operation: null,
    request: null,
    response: "OrderDto",
    evidence: { path: "src/OrdersController.java", line: 19 },
    callers: [
      {
        repo: "bff",
        via: "feign",
        client: "OrdersClient",
        method: "GET",
        path: "/api/orders/{id}",
        confidence: "exact",
        evidence: { path: "src/OrdersClient.java", line: 11 },
        from: [{ method: "GET", path: "/bff/orders/{id}", handler: "BffController.order" }],
      },
      {
        repo: "reports",
        via: "rest-template",
        client: "OrdersReport",
        method: null,
        path: "/api/orders/{}",
        confidence: "medium",
        evidence: { path: "src/OrdersReport.java", line: 17 },
        from: [],
      },
      {
        repo: "admin",
        via: "webclient",
        client: "OrdersGateway",
        method: "GET",
        path: "/api/orders/{}",
        confidence: "high",
        evidence: { path: "src/OrdersGateway.kt", line: 5 },
        from: null,
      },
    ],
    calls: [
      {
        repo: "payments",
        method: "GET",
        path: "/api/payments/{orderId}",
        handler: "PaymentsController.status",
        via: "webclient",
        client: "PaymentsGateway",
        confidence: "exact",
        evidence: { path: "src/PaymentsGateway.java", line: 20 },
      },
    ],
  };

  test("shows each endpoint as a block with its handler, types, callers with the endpoints that make the call, and its calls", () => {
    expect(findEndpointText({ query: "/api/orders/42", endpoints: [getOrder], truncated: false })).toBe(
      [
        "GET /api/orders/{id} in orders (app orders), match path",
        "  handler OrdersController.get at src/OrdersController.java:19; response OrderDto",
        "  caller bff: OrdersClient (feign, exact) GET /api/orders/{id} at src/OrdersClient.java:11",
        "    from GET /bff/orders/{id} BffController.order",
        "  caller reports: OrdersReport (rest-template, medium) ? /api/orders/{} at src/OrdersReport.java:17",
        "    from: no endpoint (a scheduled job, a listener or startup code)",
        "  caller admin: OrdersGateway (webclient, high) GET /api/orders/{} at src/OrdersGateway.kt:5",
        "    from: not traced, any endpoint of the repo may make the call",
        "  calls payments GET /api/payments/{orderId} PaymentsController.status through PaymentsGateway (webclient, exact) at src/PaymentsGateway.java:20",
      ].join("\n"),
    );
  });

  test("marks an endpoint only in an OpenAPI spec, any method, a handler not traced, and a cut result", () => {
    const fromSpec: FoundEndpoint = {
      repo: "catalog",
      match: "text",
      app: null,
      method: null,
      path: "/api/items",
      handler: null,
      source: "openapi",
      operation: { id: "listItems", summary: "List the items", evidence: { path: "api/catalog.yaml", line: 7 } },
      request: "ItemQuery",
      response: null,
      evidence: { path: "api/catalog.yaml", line: 7 },
      callers: [],
      calls: null,
    };
    expect(findEndpointText({ query: "items", endpoints: [fromSpec], truncated: true })).toBe(
      [
        "ANY /api/items in catalog, match text",
        "  only in an OpenAPI spec, no handler, at api/catalog.yaml:7; request ItemQuery",
        "  operation listItems at api/catalog.yaml:7: List the items",
        "  no callers found",
        "  calls: not traced",
        "Truncated: more than 50 endpoints match; narrow the query.",
      ].join("\n"),
    );
  });

  test("says so when no endpoint matches", () => {
    expect(findEndpointText({ query: "/nothing", endpoints: [], truncated: false } satisfies FindEndpointResult)).toBe(
      "No endpoints match /nothing.",
    );
  });
});
