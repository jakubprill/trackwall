import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConsumedHttp,
  type GraphConfig,
  MAX_CHANGED_ENDPOINTS,
  type ProvidedApp,
  type ProvidedEndpoint,
  type RepoCard,
} from "@trackwall/protocol";
import { CardCache } from "../src/modules/cards/card-cache.ts";
import { Cards } from "../src/modules/cards/cards.ts";
import { extractCard } from "../src/modules/cards/extract-card.ts";
import { loadSyntaxParsers } from "../src/modules/cards/syntax-tree.ts";
import { buildGraph, buildGraphWithIndex } from "../src/modules/graph/build-graph.ts";
import { withCallers } from "../src/modules/graph/changed-endpoints.ts";
import { findEndpoints } from "../src/modules/graph/find-endpoint.ts";
import { Graph } from "../src/modules/graph/graph.ts";
import type { GraphCardInput } from "../src/modules/graph/graph-input.ts";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";
import { fakeHosting } from "./support/hosting.ts";
import { NO_REACH, snapshotOf } from "./support/snapshot.ts";
import { fixtureFiles } from "./support/spring-fixtures.ts";

const parsers = await loadSyntaxParsers();

const CONFIG_FILE = "/home/me/.trackwall/workspace.yaml";
const NO_CONFIG: GraphConfig = { packages: {}, apps: {}, edges: [] };
const SHOP = ["orders-api", "orders-bff", "payments", "legacy-reports", "shop-web"];

/** The cards of the shop repos from the fixtures (`test/fixtures/spring`), computed without git. */
function shopCards(): GraphCardInput[] {
  return SHOP.map((repo) => ({
    kind: "ok",
    repo,
    remote: null,
    card: extractCard(snapshotOf(fixtureFiles(repo)), parsers, NO_REACH),
    tags: [],
  }));
}

function card(provides: RepoCard["provides"], consumes: RepoCard["consumes"]): RepoCard {
  return {
    commit: "a".repeat(40),
    buildFiles: [],
    provides,
    consumes,
    dtos: [],
    tools: [],
    mise: { configFiles: [], tasks: [], complete: true },
    mechanisms: [],
    reachTraced: false,
    problems: [],
  };
}

function app(name: string, port: number | null = null): ProvidedApp {
  return { kind: "app", name, port, module: "", evidence: { path: "src/main/resources/application.yml", line: 3 } };
}

function endpoint(path: string, method: ProvidedEndpoint["method"] = "GET"): ProvidedEndpoint {
  return {
    kind: "endpoint",
    source: "code",
    method,
    path,
    app: null,
    handler: "Api.handle",
    request: null,
    response: null,
    reaches: null,
    operation: null,
    evidence: { path: "src/main/java/Api.java", line: 10 },
  };
}

function client(fields: Partial<ConsumedHttp>): ConsumedHttp {
  return {
    kind: "http",
    via: "config",
    name: "orders.url",
    app: null,
    url: null,
    profiles: [],
    urlSource: null,
    calls: [],
    evidence: { path: "src/main/resources/application.yml", line: 7 },
    ...fields,
  };
}

function repo(id: string, repoCard: RepoCard, remote: string | null = null): GraphCardInput {
  return { kind: "ok", repo: id, remote, card: repoCard, tags: [] };
}

describe("http edges on the shop repos", () => {
  test("Feign, WebClient, RestTemplate and frontend addresses give edges with a confidence from what joins them", () => {
    const graph = buildGraph(shopCards(), { config: NO_CONFIG, file: CONFIG_FILE, problems: [] });

    expect(graph.edges.map((e) => [e.from, e.to, e.source, e.key, e.confidence])).toEqual([
      // Only paths matching the endpoints of one repo: the base address is outside the configuration.
      ["legacy-reports", "orders-api", "http", "OrdersReport", "medium"],
      // The app name from @FeignClient and the paths of both calls agree with orders-api.
      ["orders-bff", "orders-api", "http", "orders-api", "exact"],
      // The host from the WebClient address is spring.application.name, and /api from the address plus /payments/{orderId} is an endpoint.
      ["orders-bff", "payments", "http", "payments-service", "exact"],
      // localhost:8090 from .env and the Vite proxy is the port of the orders-bff app.
      ["shop-web", "orders-bff", "http", "localhost:8090", "medium"],
    ]);
    // Every client of the shop points to a repo of the shop.
    expect(graph.problems).toEqual([]);
    expect(graph.nodes.map((n) => [n.repo, n.apps, n.endpoints])).toEqual([
      ["orders-api", ["orders-api"], 3],
      ["orders-bff", ["orders-bff"], 0],
      ["payments", ["payments-service"], 1],
      ["legacy-reports", ["legacy-reports"], 1],
      ["shop-web", [], 0],
    ]);
  });

  test("a Feign client's edge has evidence: the annotation, the address from each profile, the target app and call–endpoint pairs", () => {
    const graph = buildGraph(shopCards(), { config: NO_CONFIG, file: CONFIG_FILE, problems: [] });
    const feign = graph.edges.find((e) => e.from === "orders-bff" && e.to === "orders-api");

    expect(feign?.evidence).toEqual([
      {
        repo: "orders-bff",
        path: "src/main/kotlin/com/example/bff/OrdersClient.kt",
        line: 9,
        detail: "Feign client OrdersClient: orders-api, http://localhost:8081 (profile: default)",
      },
      {
        repo: "orders-bff",
        path: "src/main/resources/application.yml",
        line: 8,
        detail: "address http://localhost:8081 (profile: default)",
      },
      { repo: "orders-api", path: "src/main/resources/application.yml", line: 3, detail: "app orders-api on port 8081" },
      { repo: "orders-bff", path: "src/main/kotlin/com/example/bff/OrdersClient.kt", line: 11, detail: "calls GET /api/orders/{id}" },
      {
        repo: "orders-api",
        path: "src/main/java/com/example/orders/api/OrdersController.java",
        line: 19,
        detail: "handles GET /api/orders/{id} (OrdersController.get)",
      },
      { repo: "orders-bff", path: "src/main/kotlin/com/example/bff/OrdersClient.kt", line: 14, detail: "calls POST /api/orders" },
      {
        repo: "orders-api",
        path: "src/main/java/com/example/orders/api/OrdersController.java",
        line: 27,
        detail: "handles POST /api/orders (OrdersController.create)",
      },
      {
        repo: "orders-bff",
        path: "src/main/kotlin/com/example/bff/OrdersClient.kt",
        line: 9,
        detail: "Feign client OrdersClient: orders-api, http://orders-api.shop.svc.cluster.local (profile: prod)",
      },
      {
        repo: "orders-bff",
        path: "src/main/resources/application-prod.yml",
        line: 3,
        detail: "address http://orders-api.shop.svc.cluster.local (profile: prod)",
      },
    ]);
  });
});

describe("http edges: target matching", () => {
  test("an app name gives exact only when every call has an endpoint in the target repo, and a call matching two endpoints is evidence of both", () => {
    const calls = (...paths: string[]) =>
      paths.map((path, i) => ({
        method: "GET" as const,
        path,
        operationId: null,
        evidence: { path: "src/main/java/C.java", line: 10 + i },
      }));
    const graph = buildGraph(
      [
        repo("bff", card([], [client({ via: "feign", name: "OrdersClient", app: "orders", calls: calls("/orders/special", "/missing") })])),
        repo("orders-api", card([app("orders"), endpoint("/orders/{id}"), endpoint("/orders/special")], [])),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    const [edge] = graph.edges;
    expect(edge?.confidence).toBe("high");
    expect(edge?.evidence.filter((e) => e.detail.startsWith("handles")).map((e) => e.detail)).toEqual([
      "handles GET /orders/{id} (Api.handle)",
      "handles GET /orders/special (Api.handle)",
    ]);
  });

  test("an endpoint that forwards everything (a SPA) is not a call target, and a matching call is evidence of every matching endpoint", () => {
    const calls = [
      { method: "GET" as const, path: "/api/orders/search", operationId: null, evidence: { path: "src/main/java/R.java", line: 20 } },
    ];
    const graph = buildGraph(
      [
        repo("reports", card([], [client({ via: "rest-template", name: "Report", calls })])),
        repo("web-shell", card([endpoint("/**"), endpoint("/{path}")], [])),
        repo("orders-api", card([endpoint("/api/orders/{id}"), endpoint("/api/orders/search")], [])),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.edges.map((e) => [e.to, e.confidence, e.evidence.filter((v) => v.detail.startsWith("handles")).length])).toEqual([
      ["orders-api", "medium", 2],
    ]);
  });

  test("an app name or port pointing to the client's repo ends the search without an edge", () => {
    const calls = [
      { method: "GET" as const, path: "/api/orders/{id}", operationId: null, evidence: { path: "src/main/java/B.java", line: 20 } },
    ];
    const graph = buildGraph(
      [
        repo(
          "shop",
          card(
            [app("orders", 8080), app("billing")],
            [
              client({ via: "feign", name: "OrdersClient", app: "orders", calls }),
              client({ name: "self.url", url: "http://localhost:8080" }),
            ],
          ),
        ),
        repo("legacy", card([endpoint("/api/orders/{id}")], [])),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.edges).toEqual([]);
  });

  test("lb://name in the configuration points to an app by name, and without calls the confidence is high", () => {
    const graph = buildGraph(
      [
        repo("gateway", card([], [client({ name: "spring.cloud.gateway.routes[0].uri", app: "orders", url: "lb://orders" })])),
        repo("orders-api", card([app("orders")], [])),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.edges.map((e) => [e.from, e.to, e.key, e.confidence])).toEqual([["gateway", "orders-api", "orders", "high"]]);
  });

  test("an app with the same name in the client's repo does not lower the confidence of the edge to the only other repo", () => {
    const graph = buildGraph(
      [
        repo("bff", card([app("orders")], [client({ via: "feign", name: "OrdersClient", app: "orders" })])),
        repo("orders-api", card([app("orders")], [])),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.edges.map((e) => [e.to, e.confidence])).toEqual([["orders-api", "high"]]);
  });

  test("an address shared by several profiles lists them all in the evidence", () => {
    const graph = buildGraph(
      [
        repo("shop-bff", card([], [client({ app: "orders", url: "http://orders:8080", profiles: ["dev", "prod"] })])),
        repo("orders-api", card([app("orders")], [])),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.edges[0]?.evidence[0]?.detail).toBe("address in config orders.url: orders, http://orders:8080 (profiles: dev, prod)");
  });

  test("find_endpoint lists a callee once for a client split by profile, and `from` is unknown while one endpoint of the repo has no reach (ADR-82)", () => {
    const call = {
      method: "GET" as const,
      path: "/api/orders/{id}",
      operationId: null,
      evidence: { path: "src/main/java/OrdersClient.java", line: 4 },
    };
    const ordersClient = (url: string, profiles: string[]) =>
      client({ via: "feign", name: "OrdersClient", app: "orders", url, profiles, calls: [call] });
    const reach = { via: "feign" as const, client: "OrdersClient", method: call.method, path: call.path, evidence: call.evidence };
    const bff = (untraced: ProvidedEndpoint[]) => {
      // A mapping with two methods is two reaches on one line.
      const c = card(
        [{ ...endpoint("/orders/{id}"), reaches: [reach, { ...reach, method: "POST" as const }] }, ...untraced],
        [ordersClient("http://orders:8080", ["default"]), ordersClient("http://orders.prod", ["prod"])],
      );
      return { ...c, reachTraced: true };
    };
    const find = (untraced: ProvidedEndpoint[], query: string) => {
      const cards = [repo("bff", bff(untraced)), repo("orders-api", card([app("orders"), endpoint("/api/orders/{id}")], []))];
      return findEndpoints(buildGraphWithIndex(cards, { config: NO_CONFIG, file: CONFIG_FILE, problems: [] }).http, query, "GET").endpoints;
    };

    expect(find([], "/orders/7")[0]?.calls?.map((c) => `${c.repo} ${c.method} ${c.path} ${c.client}`)).toEqual([
      "orders-api GET /api/orders/{id} OrdersClient",
    ]);
    expect(find([], "/api/orders/7")[0]?.callers.map((c) => c.from?.map((e) => e.path) ?? null)).toEqual([
      ["/orders/{id}"],
      ["/orders/{id}"],
    ]);
    // A handler the call graph did not find might make the call too, so no endpoint is not the answer.
    expect(find([endpoint("/other")], "/api/orders/7")[0]?.callers.map((c) => c.from)).toEqual([null, null]);
  });

  test("the same app name in two repos (a clone, a fork) gives an edge to each with medium confidence", () => {
    const graph = buildGraph(
      [
        repo("bff", card([], [client({ via: "feign", name: "OrdersClient", app: "orders" })])),
        repo("orders-api", card([app("orders")], [])),
        repo("orders-api-fork", card([app("orders")], [])),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.edges.map((e) => [e.to, e.confidence])).toEqual([
      ["orders-api", "medium"],
      ["orders-api-fork", "medium"],
    ]);
  });

  test("a host equal to the repo name or to the last segment of the remote repo address gives a medium edge", () => {
    const graph = buildGraph(
      [
        repo(
          "bff",
          card([], [client({ url: "http://orders-api.shop.svc:8080" }), client({ name: "billing.url", url: "https://billing/api" })]),
        ),
        repo("orders-api", card([], [])),
        repo("settlements", card([], []), "gitlab.example.com/shop/billing"),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.edges.map((e) => [e.to, e.key, e.confidence])).toEqual([
      ["orders-api", "orders-api", "medium"],
      ["settlements", "billing", "medium"],
    ]);
  });

  test("an app alias from workspace.yaml points to a repo for a name no card has, and a bad alias goes to configProblems", () => {
    const graph = buildGraph(
      [repo("bff", card([], [client({ url: "http://sales.internal.example.com/api" })])), repo("orders-api", card([], []))],
      {
        config: { packages: {}, apps: { "Sales.internal.example.com": "orders-api", other: "missing" }, edges: [] },
        file: CONFIG_FILE,
        problems: [],
      },
    );
    expect(graph.edges.map((e) => [e.to, e.key, e.confidence, e.evidence[1]?.detail])).toEqual([
      ["orders-api", "sales.internal.example.com", "high", "graph.apps: sales.internal.example.com → orders-api"],
    ]);
    expect(graph.configProblems).toEqual(["graph.apps “other”: no repo “missing” in the repo list (give its id or host/path address)"]);
  });

  test("calls without an address matching the endpoints of two repos give low edges, and a path without a fixed segment gives none", () => {
    const calls = (path: string) => [
      { method: "GET" as const, path, operationId: null, evidence: { path: "src/main/java/Report.java", line: 20 } },
    ];
    const graph = buildGraph(
      [
        repo("reports", card([], [client({ via: "rest-template", name: "Report", calls: calls("/api/orders/{}") })])),
        repo("raw", card([], [client({ via: "rest-template", name: "Raw", calls: calls("/{}") })])),
        repo("orders-api", card([endpoint("/api/orders/{id}"), endpoint("/{id}")], [])),
        repo("orders-legacy", card([endpoint("/api/orders/**")], [])),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.edges.map((e) => [e.from, e.to, e.confidence])).toEqual([
      ["reports", "orders-api", "low"],
      ["reports", "orders-legacy", "low"],
    ]);
  });

  test("a repo's client never joins the repo with itself", () => {
    const graph = buildGraph([repo("orders-api", card([app("orders-api", 8081)], [client({ url: "http://localhost:8081" })]))], {
      config: NO_CONFIG,
      file: CONFIG_FILE,
      problems: [],
    });
    expect(graph.edges).toEqual([]);
  });
});

describe("calls without a target (ADR-116)", () => {
  const getStock = [
    { method: "GET" as const, path: "/api/stock/{sku}", operationId: null, evidence: { path: "src/main/java/StockClient.java", line: 12 } },
  ];

  test("a Feign client to an app no repo has is an unresolved-call-target problem that names the alias to add", () => {
    const graph = buildGraph(
      [
        repo(
          "orders-bff",
          card(
            [],
            [
              client({
                via: "feign",
                name: "StockClient",
                app: "inventory",
                calls: getStock,
                evidence: { path: "src/main/java/StockClient.java", line: 9 },
              }),
            ],
          ),
        ),
        repo("orders-api", card([app("orders-api"), endpoint("/api/orders/{id}")], [])),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.edges).toEqual([]);
    expect(graph.problems).toEqual([
      {
        code: "unresolved-call-target",
        repo: "orders-bff",
        via: "feign",
        client: "StockClient",
        evidence: { path: "src/main/java/StockClient.java", line: 9 },
        message: "no repo in the list is “inventory”; if it is one of yours, map it to its repo under graph.apps in workspace.yaml",
      },
    ]);
  });

  test("an alias for the app connects the client, and the problem goes away", () => {
    const graph = buildGraph(
      [
        repo("orders-bff", card([], [client({ via: "feign", name: "StockClient", app: "inventory", calls: getStock })])),
        repo("stock", card([], [])),
      ],
      { config: { ...NO_CONFIG, apps: { inventory: "stock" } }, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.edges.map((e) => [e.from, e.to, e.kind, e.source])).toEqual([["orders-bff", "stock", "calls", "http"]]);
    expect(graph.problems).toEqual([]);
  });

  test("a call to localhost names the port no app runs on, and calls matching no endpoint name the client", () => {
    const graph = buildGraph(
      [
        repo(
          "shop-web",
          card(
            [],
            [
              client({ via: "env", name: "VITE_STOCK_URL", url: "http://localhost:9999", calls: getStock }),
              client({ via: "rest-template", name: "StockReport", calls: getStock }),
            ],
          ),
        ),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.problems.map((p) => [p.client, p.message])).toEqual([
      ["VITE_STOCK_URL", "no app in the list runs on localhost:9999 (server.port on its card)"],
      ["StockReport", "no repo in the list has an endpoint matching the calls of StockReport"],
    ]);
  });

  test("calls that match only an endpoint of the client's own repo (a sibling app) are not a problem", () => {
    const graph = buildGraph(
      [repo("shop", card([endpoint("/api/stock/{sku}")], [client({ via: "rest-client", name: "StockClient", calls: getStock })]))],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.edges).toEqual([]);
    expect(graph.problems).toEqual([]);
  });

  test("an address in the configuration without calls or a name, and a client pointing to its own repo, are not problems", () => {
    const graph = buildGraph(
      [
        repo(
          "shop",
          card(
            [app("orders", 8080)],
            [
              client({ name: "management.zipkin.tracing.endpoint", url: "http://zipkin:9411/api/v2/spans" }),
              client({ via: "feign", name: "OrdersClient", app: "orders", calls: getStock }),
            ],
          ),
        ),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.problems).toEqual([]);
  });
});

describe("clients from OpenAPI specs (ADR-129)", () => {
  /** A spec client's calls: each operation with its line in the spec. */
  const ops = (...list: [method: "GET" | "POST", path: string, operationId: string | null][]) =>
    list.map(([method, path, operationId], i) => ({ method, path, operationId, evidence: { path: "src/api/orders.yaml", line: 10 + i } }));
  const spec = (fields: Partial<ConsumedHttp>) =>
    client({ via: "openapi", name: "Orders BFF", evidence: { path: "src/api/orders.yaml", line: null }, ...fields });
  const described = (path: string, method: ProvidedEndpoint["method"], id: string) => ({
    ...endpoint(path, method),
    operation: { id, summary: null, evidence: { path: "openapi.yaml", line: 3 } },
  });
  const edges = (cards: GraphCardInput[]) =>
    buildGraph(cards, { config: NO_CONFIG, file: CONFIG_FILE, problems: [] }).edges.map((e) => [e.from, e.to, e.key, e.confidence]);

  test("a normalised spec behind a gateway connects to the repo serving its operations under another prefix, not to the gateway or a repo serving one of them", () => {
    const web = spec({
      url: "https://gateway.example.com/shop",
      calls: ops(
        ["GET", "/orders/v1/orders/{orderId}", null],
        ["POST", "/orders/v1/orders", null],
        ["GET", "/orders/v1/orders/{orderId}/lines", null],
      ),
    });
    const bff = [
      app("orders-bff"),
      endpoint("/bff/api/orders/{id}"),
      endpoint("/bff/api/orders", "POST"),
      endpoint("/bff/api/orders/{id}/lines"),
    ];
    const graph = buildGraph(
      [
        repo("web", card([], [web])),
        repo("orders-bff", card(bff, [])),
        // Routes everything under /shop, and its name is the host of the spec's server.
        repo("gateway", card([app("gateway"), endpoint("/shop/**")], [])),
        // Ends like one of the three operations.
        repo("reports", card([endpoint("/reports/orders/{id}")], [])),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.edges.map((e) => [e.from, e.to, e.key, e.confidence])).toEqual([["web", "orders-bff", "Orders BFF", "high"]]);
    expect(graph.edges[0]?.evidence.slice(0, 3).map((e) => `${e.repo} ${e.path}:${e.line} ${e.detail}`)).toEqual([
      "web src/api/orders.yaml:null OpenAPI spec Orders BFF: https://gateway.example.com/shop",
      "web src/api/orders.yaml:10 calls GET /shop/orders/v1/orders/{orderId}",
      "orders-bff src/main/java/Api.java:10 handles GET /bff/api/orders/{id} (Api.handle)",
    ]);
    expect(graph.problems).toEqual([]);
  });

  test("an operationId matches the endpoint its spec describes when that path holds the call's last fixed segment, and a repo with the same paths wins over one whose paths only end alike", () => {
    const byId = spec({
      calls: ops(["GET", "/order-service/orders", "listOrders"], ["GET", "/order-service/orders/{id}/summary", "getOrder"]),
    });
    const ids = [described("/api/orders/all", "GET", "listOrders"), described("/api/orders/{id}", "GET", "getOrder")];
    // Only listOrders: getOrder's path has no `summary`, so the id alone does not match.
    expect(edges([repo("web", card([], [byId])), repo("orders-api", card(ids, []))])).toEqual([
      ["web", "orders-api", "Orders BFF", "high"],
    ]);
    // Ids like getById repeat across services; on another resource they match nothing.
    const generic = spec({ calls: ops(["GET", "/orders/{id}", "getById"], ["GET", "/orders", "findAll"]) });
    const users = [described("/users/{id}", "GET", "getById"), described("/users", "GET", "findAll")];
    expect(edges([repo("web", card([], [generic])), repo("users-api", card(users, []))])).toEqual([]);

    const byPath = spec({ calls: ops(["GET", "/api/orders/{id}", null]) });
    expect(
      edges([
        repo("web", card([], [byPath])),
        repo("orders-api", card([endpoint("/api/orders/{id}")], [])),
        repo("reports", card([endpoint("/reports/orders/{id}")], [])),
      ]),
    ).toEqual([["web", "orders-api", "Orders BFF", "high"]]);
    // Two repos serving the spec the same way (a fork) are both possible.
    expect(
      edges([
        repo("web", card([], [byPath])),
        repo("orders-api", card([endpoint("/api/orders/{id}")], [])),
        repo("orders-api-fork", card([endpoint("/api/orders/{id}")], [])),
      ]),
    ).toEqual([
      ["web", "orders-api", "Orders BFF", "low"],
      ["web", "orders-api-fork", "Orders BFF", "low"],
    ]);
  });

  test("a spec no repo serves points to the app its server path or title names, and otherwise is a call without a target", () => {
    const calls = ops(["GET", "/v1/stock/{sku}", null]);
    const behindGateway = spec({ name: "Stock", url: "https://gateway.example.com/inventory/api", calls });
    const titled = spec({ name: "Inventory API", url: "https://gateway.example.com/", calls });
    const inventory = repo("inventory", card([app("inventory")], []));
    expect(edges([repo("web", card([], [behindGateway])), inventory])).toEqual([["web", "inventory", "inventory", "high"]]);
    expect(edges([repo("web", card([], [titled])), inventory])).toEqual([["web", "inventory", "inventory", "high"]]);

    // The host names the gateway, which has endpoints but serves none of the calls, so the title decides.
    const gateway = repo("gateway", card([app("gateway"), endpoint("/shop/**")], []));
    expect(edges([repo("web", card([], [titled])), gateway, inventory])).toEqual([["web", "inventory", "inventory", "high"]]);

    const graph = buildGraph([repo("web", card([], [titled])), gateway], { config: NO_CONFIG, file: CONFIG_FILE, problems: [] });
    expect(graph.problems.map((p) => [p.repo, p.via, p.client, p.message])).toEqual([
      [
        "web",
        "openapi",
        "Inventory API",
        "no repo in the list serves 50% of the operations of Inventory API (by operationId, or by path with another prefix)",
      ],
    ]);
  });

  test("a BFF serving the paths of the spec it generates a client from still connects to the backend, and serving them alone ends the search", () => {
    const client = spec({ name: "Orders", calls: ops(["GET", "/api/orders/{id}", "getOrder"], ["POST", "/api/orders", null]) });
    const mirror = [endpoint("/api/orders/{id}"), endpoint("/api/orders", "POST")];
    const backend = repo("orders-api", card([endpoint("/orders/api/orders/{id}"), endpoint("/orders/api/orders", "POST")], []));
    expect(edges([repo("orders-bff", card(mirror, [client])), backend])).toEqual([["orders-bff", "orders-api", "Orders", "high"]]);
    // The backend's paths without the BFF's prefix end less like the calls than the mirror does, and still count.
    const shorter = repo("orders-api", card([endpoint("/orders/{id}"), endpoint("/orders", "POST")], []));
    expect(edges([repo("orders-bff", card(mirror, [client])), shorter])).toEqual([["orders-bff", "orders-api", "Orders", "high"]]);
    const alone = buildGraph([repo("orders-bff", card(mirror, [client]))], { config: NO_CONFIG, file: CONFIG_FILE, problems: [] });
    expect([alone.edges, alone.problems]).toEqual([[], []]);
  });

  test("a spec a script downloads has no calls, so its host or localhost port alone names the app, and an address naming none is a call without a target", () => {
    const downloaded = (url: string) => spec({ name: "api:orders", url, evidence: { path: "package.json", line: 5 } });
    const bff = repo("orders-bff", card([app("orders-bff", 8090), endpoint("/api/orders/{id}")], []));
    expect(edges([repo("web", card([], [downloaded("https://orders-bff.dev.example.com")])), bff])).toEqual([
      ["web", "orders-bff", "orders-bff", "high"],
    ]);
    expect(edges([repo("web", card([], [downloaded("http://localhost:8090")])), bff])).toEqual([
      ["web", "orders-bff", "localhost:8090", "medium"],
    ]);
    const graph = buildGraph([repo("web", card([], [downloaded("http://localhost:9999")])), bff], {
      config: NO_CONFIG,
      file: CONFIG_FILE,
      problems: [],
    });
    expect(graph.problems.map((p) => p.message)).toEqual([
      "no app in the list serves the spec api:orders downloads from http://localhost:9999; its host or localhost port names none",
    ]);
    // A public API, a host label that names no app, and a spec without operations are not calls the graph can miss.
    const api = repo("api", card([app("api")], []));
    const quiet = buildGraph([repo("web", card([], [downloaded("https://api.example.com"), spec({ name: "Shared schemas" })])), api], {
      config: NO_CONFIG,
      file: CONFIG_FILE,
      problems: [],
    });
    expect([quiet.edges, quiet.problems]).toEqual([[], []]);
  });

  test("find_endpoint lists the spec's repo as a caller, without the endpoints that make the call, since the generated client is not in the repo", () => {
    const bff = { ...card([], [spec({ name: "Orders", calls: ops(["GET", "/api/orders/{id}", "getOrder"]) })]), reachTraced: true };
    const cards = [repo("orders-bff", bff), repo("orders-api", card([app("orders-api"), endpoint("/api/orders/{id}")], []))];
    const found = findEndpoints(
      buildGraphWithIndex(cards, { config: NO_CONFIG, file: CONFIG_FILE, problems: [] }).http,
      "/api/orders/7",
      "GET",
    );
    expect(found.endpoints[0]?.callers.map((c) => [c.repo, c.via, c.client, c.path, c.confidence, c.from])).toEqual([
      ["orders-bff", "openapi", "Orders", "/api/orders/{id}", "high", null],
    ]);
  });
});

test("more changed endpoints than the limit are cut and say so (ADR-145)", () => {
  const { http } = buildGraphWithIndex([], { config: NO_CONFIG, file: CONFIG_FILE, problems: [] });
  const changes = Array.from({ length: MAX_CHANGED_ENDPOINTS + 1 }, (_, i) => ({
    change: "added" as const,
    app: null,
    method: "GET" as const,
    path: `/api/generated/${i}`,
    before: null,
    after: { handler: null, request: null, response: null },
    dtos: [],
  }));
  const { endpoints, truncated } = withCallers(http, "catalog", changes);
  expect(endpoints).toHaveLength(MAX_CHANGED_ENDPOINTS);
  expect(truncated).toBe(true);
});

describe("the graph and find_endpoint on real git", () => {
  // Several repos with commits and two card computations on real git take longer than the default 5 s on Windows in CI.
  const REAL_GIT_TIMEOUT = 30_000;

  async function setup(extra: readonly string[] = []) {
    const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
    const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
    const vcs = new Vcs(systemTempFolder);
    const workspace = new Workspace({
      file: new WorkspaceFile(join(home, "workspace.yaml")),
      vcs,
      hosting: fakeHosting().hosting,
      openEditor: () => {},
      openFolder: () => {},
      afterClone: async () => {},
    });
    await workspace.setProjectsDir(projects);
    for (const name of [...SHOP, ...extra]) makeRepo(fixtureFiles(name), name, projects);
    const cards = new Cards({ vcs, repos: workspace, cache: new CardCache(join(home, "cards"), () => {}), log: () => {} });
    return { home, projects, cards, graph: new Graph({ cards, workspace }), workspace };
  }

  test(
    "cards from a commit read the controllers and clients picked by search, without test code, and DTOs from files named after the types",
    async () => {
      const { graph, cards } = await setup();
      const found = await graph.findEndpoint("/api/orders/42", "GET");

      expect(found.truncated).toBe(false);
      expect(found.endpoints.map((e) => [e.repo, e.method, e.path, e.handler, e.response, e.evidence.line])).toEqual([
        ["orders-api", "GET", "/api/orders/{id}", "OrdersController.get", "OrderDto", 19],
      ]);
      expect(found.endpoints[0]?.callers.map((c) => [c.repo, c.via, c.client, c.path, c.confidence])).toEqual([
        ["legacy-reports", "rest-template", "OrdersReport", "/api/orders/{}", "medium"],
        ["orders-bff", "feign", "OrdersClient", "/api/orders/{id}", "exact"],
        ["orders-bff", "feign", "OrdersClient", "/api/orders/{id}", "exact"],
      ]);
      // A controller from src/test is not an app endpoint.
      expect((await graph.findEndpoint("test-only", undefined)).endpoints).toEqual([]);
      // DTO files have no annotations, so the read pulls them in by the type names from the controller.
      expect((await cards.card("orders-api")).card?.dtos.map((d) => d.name)).toEqual(["OrderDto", "OrderLine", "OrderStatus"]);
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "find_endpoint tells which endpoints of a caller reach the call and which endpoints an endpoint calls (ADR-82)",
    async () => {
      const { graph } = await setup();
      const ref = (e: { method: string | null; path: string; handler: string | null }) => `${e.method} ${e.path} ${e.handler}`;
      const [get] = (await graph.findEndpoint("/api/orders/42", "GET")).endpoints;
      expect(get?.callers.map((c) => [c.repo, c.from?.map(ref) ?? null])).toEqual([
        ["legacy-reports", ["GET /reports/orders/{id} ReportsController.order"]],
        // orders-bff has Kotlin code, which the reach does not read yet.
        ["orders-bff", null],
        ["orders-bff", null],
      ]);
      const [cancel] = (await graph.findEndpoint("/api/orders/{id}/cancel", "PUT")).endpoints;
      // Only the scheduled job makes this call.
      expect(cancel?.callers.find((c) => c.repo === "legacy-reports")?.from).toEqual([]);

      const [report] = (await graph.findEndpoint("/reports/orders/7", "GET")).endpoints;
      expect(report?.calls?.map((c) => [c.repo, ref(c), c.client, c.confidence, `${c.evidence.path}:${c.evidence.line}`])).toEqual([
        [
          "orders-api",
          "GET /api/orders/{id} OrdersController.get",
          "OrdersReport",
          "medium",
          "src/main/java/com/example/reports/OrdersReport.java:17",
        ],
      ]);
      expect((await graph.findEndpoint("/api/orders/42", "GET")).endpoints[0]?.calls).toEqual([]);
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "find_endpoint also searches by a fragment of the path, handler and app name, case-insensitive",
    async () => {
      const { graph } = await setup();
      const paths = async (query: string) => (await graph.findEndpoint(query, undefined)).endpoints.map((e) => `${e.method} ${e.path}`);
      expect(await paths("payments-SERVICE")).toEqual(["POST /api/payments/{orderId}"]);
      expect(await paths("ordersController.cancel")).toEqual(["PUT /api/orders/{id}/cancel"]);
      expect(await paths("/api/orders")).toEqual(["POST /api/orders", "GET /api/orders/{id}", "PUT /api/orders/{id}/cancel"]);
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "find_endpoint finds endpoints from an OpenAPI spec by the end of their path, a whole address and words, best match first (ADR-87)",
    async () => {
      const { graph } = await setup(["catalog"]);
      const found = async (query: string) =>
        (await graph.findEndpoint(query, undefined)).endpoints.map(
          (e) => `${e.match} ${e.repo} ${e.method} ${e.path} ${e.source} ${e.handler}`,
        );
      // The agent knows the path without the context path.
      expect(await found("/api/products/42")).toEqual([
        "path-end catalog GET /catalog/api/products/{productId} openapi ProductsController.getProduct",
      ]);
      expect(await found("GET http://localhost:8083/catalog/api/products/42/stock?warehouse=1")).toEqual([
        "path catalog GET /catalog/api/products/{productId}/stock openapi ProductsController.getProductStock",
      ]);
      // Words from the operation summary; the mapped endpoint in the code has the summary too.
      expect(await found("product categories")).toEqual([
        "text catalog GET /catalog/api/categories code CategoriesController.listCategories",
      ]);
      // The client spec in catalog is not an orders endpoint.
      expect((await found("/api/orders/42")).map((e) => e.split(" ")[1])).toEqual(["orders-api"]);
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "a frontend's normalised copy of a spec and a build's client spec connect to the repos serving them (ADR-129)",
    async () => {
      const { graph } = await setup(["catalog", "back-office"]);
      const edges = (await graph.graph()).edges.filter((e) => e.from === "back-office" || e.from === "catalog");
      expect(edges.map((e) => [e.from, e.to, e.key, e.confidence])).toEqual([
        ["back-office", "catalog", "Catalog", "high"],
        // The spec the generate:orders script downloads from orders-bff's port.
        ["back-office", "orders-bff", "localhost:8090", "medium"],
        ["catalog", "orders-api", "Orders", "high"],
      ]);
      const [product] = (await graph.findEndpoint("/catalog/api/products/42", "GET")).endpoints;
      expect(product?.callers.map((c) => [c.repo, c.via, c.client, c.path, c.from])).toEqual([
        ["back-office", "openapi", "Catalog", "/shop/catalog/v1/products/{id}", null],
      ]);
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "a task's commits in its worktree give the endpoints they change, with the repos that call them as the default branch has them (ADR-145)",
    async () => {
      const { graph, projects, home } = await setup();
      const repo = join(projects, "orders-api");
      const base = gitIn(repo, "rev-parse", "HEAD").trim();
      const worktree = join(home, "orders-api-task");
      gitIn(repo, "worktree", "add", "-b", "trackwall/cancel-by-post", worktree, base);
      const controller = "src/main/java/com/example/orders/api/OrdersController.java";
      commitFiles(
        worktree,
        {
          "src/main/java/com/example/orders/api/OrderLine.java":
            "package com.example.orders.api;\n\n@lombok.Data\npublic class OrderLine {\n    private String sku;\n    private int quantity;\n    private String note;\n}\n",
          [controller]: readFileSync(join(repo, controller), "utf8").replace("method = RequestMethod.PUT", "method = RequestMethod.POST"),
        },
        "Cancel by POST and add a note to order lines",
      );

      const changed = await graph.changedEndpoints("orders-api", worktree, base);

      expect(changed.head).toBe(gitIn(worktree, "rev-parse", "HEAD").trim());
      expect(changed.truncated).toBe(false);
      expect(changed.contractsCompared).toBe(true);
      expect(
        changed.endpoints.map((e) => [
          e.change,
          `${e.method} ${e.path}`,
          e.dtos,
          e.callers.map((c) => `${c.repo} ${c.client} ${c.evidence.path}:${c.evidence.line}`),
        ]),
      ).toEqual([
        [
          "changed",
          "GET /api/orders/{id}",
          ["OrderLine"],
          [
            "legacy-reports OrdersReport src/main/java/com/example/reports/OrdersReport.java:17",
            "orders-bff OrdersClient src/main/kotlin/com/example/bff/OrdersClient.kt:11",
            "orders-bff OrdersClient src/main/kotlin/com/example/bff/OrdersClient.kt:11",
          ],
        ],
        [
          "changed",
          "POST /api/orders",
          ["OrderLine"],
          [
            "orders-bff OrdersClient src/main/kotlin/com/example/bff/OrdersClient.kt:14",
            "orders-bff OrdersClient src/main/kotlin/com/example/bff/OrdersClient.kt:14",
          ],
        ],
        // The default branch's PUT has a caller, which the task's POST breaks.
        [
          "removed",
          "PUT /api/orders/{id}/cancel",
          [],
          ["legacy-reports OrdersReport src/main/java/com/example/reports/OrdersReport.java:21"],
        ],
        ["added", "POST /api/orders/{id}/cancel", [], []],
      ]);
      expect(changed.endpoints[0]?.before).toEqual({ handler: "OrdersController.get", request: null, response: "OrderDto" });
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "a new commit in a repo changes the graph on the next question",
    async () => {
      const { graph, projects } = await setup();
      expect((await graph.graph()).edges.some((e) => e.from === "orders-api")).toBe(false);
      commitFiles(
        join(projects, "orders-api"),
        {
          "src/main/java/com/example/orders/api/PaymentsCheck.java":
            '@FeignClient(name = "payments-service")\ninterface PaymentsCheck {\n  @PostMapping("/api/payments/{id}") void pay();\n}\n',
        },
        "Add the payments client",
      );
      expect((await graph.graph()).edges.filter((e) => e.from === "orders-api").map((e) => [e.to, e.key, e.confidence])).toEqual([
        ["payments", "payments-service", "exact"],
      ]);
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "a client to an app outside the list is a graph problem, in the whole graph and in the subgraph of its repo (ADR-116)",
    async () => {
      const { graph, projects } = await setup();
      expect((await graph.graph()).problems).toEqual([]);
      commitFiles(
        join(projects, "orders-api"),
        {
          "src/main/java/com/example/orders/api/StockClient.java":
            '@FeignClient(name = "inventory")\ninterface StockClient {\n  @GetMapping("/api/stock/{sku}") Stock level();\n}\n',
        },
        "Add the stock client",
      );
      const problems = (await graph.graph()).problems.map((p) => [p.code, p.repo, p.client, `${p.evidence.path}:${p.evidence.line}`]);
      expect(problems).toEqual([
        ["unresolved-call-target", "orders-api", "StockClient", "src/main/java/com/example/orders/api/StockClient.java:1"],
      ]);
      expect((await graph.subgraph("orders-api", 1)).problems.map((p) => p.client)).toEqual(["StockClient"]);
      expect((await graph.subgraph("shop-web", 1)).problems).toEqual([]);
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "an app alias from workspace.yaml works at once, without a new commit",
    async () => {
      const { graph, workspace } = await setup();
      const before = await graph.graph();
      expect(before.edges.some((e) => e.from === "orders-bff" && e.key === "zipkin")).toBe(false);
      writeFileSync(workspace.configFile(), `${await Bun.file(workspace.configFile()).text()}graph:\n  apps:\n    zipkin: payments\n`);
      const after = await graph.graph();
      expect(after.edges.filter((e) => e.key === "zipkin").map((e) => [e.from, e.to, e.confidence])).toEqual([
        ["orders-bff", "payments", "high"],
      ]);
    },
    REAL_GIT_TIMEOUT,
  );
});
