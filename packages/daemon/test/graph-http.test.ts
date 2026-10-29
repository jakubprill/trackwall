import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsumedHttp, GraphConfig, ProvidedApp, ProvidedEndpoint, RepoCard } from "@trackwall/protocol";
import { CardCache } from "../src/modules/cards/card-cache.ts";
import { Cards } from "../src/modules/cards/cards.ts";
import { extractCard } from "../src/modules/cards/extract-card.ts";
import { loadSyntaxParsers } from "../src/modules/cards/syntax-tree.ts";
import { buildGraph, buildGraphWithIndex } from "../src/modules/graph/build-graph.ts";
import { findEndpoints } from "../src/modules/graph/find-endpoint.ts";
import { Graph } from "../src/modules/graph/graph.ts";
import type { GraphCardInput } from "../src/modules/graph/graph-input.ts";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { commitFiles, makeRepo } from "./support/git-repo.ts";
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
      paths.map((path, i) => ({ method: "GET" as const, path, evidence: { path: "src/main/java/C.java", line: 10 + i } }));
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
    const calls = [{ method: "GET" as const, path: "/api/orders/search", evidence: { path: "src/main/java/R.java", line: 20 } }];
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
    const calls = [{ method: "GET" as const, path: "/api/orders/{id}", evidence: { path: "src/main/java/B.java", line: 20 } }];
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
    const call = { method: "GET" as const, path: "/api/orders/{id}", evidence: { path: "src/main/java/OrdersClient.java", line: 4 } };
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
    const calls = (path: string) => [{ method: "GET" as const, path, evidence: { path: "src/main/java/Report.java", line: 20 } }];
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
  const getStock = [{ method: "GET" as const, path: "/api/stock/{sku}", evidence: { path: "src/main/java/StockClient.java", line: 12 } }];

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
