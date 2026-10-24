import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsumedHttp, GraphConfig, ProvidedApp, ProvidedEndpoint, RepoCard } from "@trackwall/protocol";
import { CardCache } from "../src/modules/cards/card-cache.ts";
import { Cards } from "../src/modules/cards/cards.ts";
import { extractCard } from "../src/modules/cards/extract-card.ts";
import { buildGraph } from "../src/modules/graph/build-graph.ts";
import { Graph } from "../src/modules/graph/graph.ts";
import type { GraphCardInput } from "../src/modules/graph/graph-input.ts";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { commitFiles, makeRepo } from "./support/git-repo.ts";
import { fakeHosting } from "./support/hosting.ts";
import { snapshotOf } from "./support/snapshot.ts";
import { fixtureFiles } from "./support/spring-fixtures.ts";

const CONFIG_FILE = "/home/ja/.trackwall/workspace.yaml";
const NO_CONFIG: GraphConfig = { packages: {}, apps: {}, edges: [] };
const SHOP = ["orders-api", "orders-bff", "payments", "legacy-reports", "shop-web"];

/** Karty repo sklepu z fixture'ów (`test/fixtures/spring`), policzone bez gita. */
function shopCards(): GraphCardInput[] {
  return SHOP.map((repo) => ({ kind: "ok", repo, remote: null, card: extractCard(snapshotOf(fixtureFiles(repo))), tags: [] }));
}

function card(provides: RepoCard["provides"], consumes: RepoCard["consumes"]): RepoCard {
  return {
    commit: "a".repeat(40),
    buildFiles: [],
    provides,
    consumes,
    tools: [],
    mise: { configFiles: [], tasks: [], complete: true },
    mechanisms: [],
    problems: [],
  };
}

function app(name: string, port: number | null = null): ProvidedApp {
  return { kind: "app", name, port, module: "", evidence: { path: "src/main/resources/application.yml", line: 3 } };
}

function endpoint(path: string, method: ProvidedEndpoint["method"] = "GET"): ProvidedEndpoint {
  return { kind: "endpoint", method, path, app: null, handler: "Api.handle", evidence: { path: "src/main/java/Api.java", line: 10 } };
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

describe("krawędzie http na repo sklepu", () => {
  test("Feign, WebClient, RestTemplate i adresy frontendu dają krawędzie z pewnością z tego, co je łączy", () => {
    const graph = buildGraph(shopCards(), { config: NO_CONFIG, file: CONFIG_FILE, problems: [] });

    expect(graph.edges.map((e) => [e.from, e.to, e.kind, e.key, e.confidence])).toEqual([
      // Same ścieżki pasujące do endpointów jednego repo: adres bazowy jest poza konfiguracją.
      ["legacy-reports", "orders-api", "http", "OrdersReport", "medium"],
      // Nazwa aplikacji z @FeignClient i ścieżki obu wywołań zgadzają się z orders-api.
      ["orders-bff", "orders-api", "http", "orders-api", "exact"],
      // Host z adresu WebClient to spring.application.name, a /api z adresu i /payments/{orderId} to endpoint.
      ["orders-bff", "payments", "http", "payments-service", "exact"],
      // localhost:8090 z .env i proxy Vite to port aplikacji orders-bff.
      ["shop-web", "orders-bff", "http", "localhost:8090", "medium"],
    ]);
    expect(graph.nodes.map((n) => [n.repo, n.apps, n.endpoints])).toEqual([
      ["orders-api", ["orders-api"], 3],
      ["orders-bff", ["orders-bff"], 0],
      ["payments", ["payments-service"], 1],
      ["legacy-reports", ["legacy-reports"], 0],
      ["shop-web", [], 0],
    ]);
  });

  test("krawędź klienta Feign ma dowody: adnotację, adres z każdego profilu, aplikację celu i pary wywołanie–endpoint", () => {
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

describe("krawędzie http: dopasowanie celu", () => {
  test("nazwa aplikacji daje exact tylko wtedy, gdy każde wywołanie ma endpoint w repo celu, a wywołanie pasujące do dwóch endpointów jest dowodem obu", () => {
    const calls = (...paths: string[]) =>
      paths.map((path, i) => ({ method: "GET" as const, path, evidence: { path: "src/main/java/C.java", line: 10 + i } }));
    const graph = buildGraph(
      [
        repo("bff", card([], [client({ via: "feign", name: "OrdersClient", app: "orders", calls: calls("/orders/special", "/nie-ma") })])),
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

  test("endpoint przekierowujący wszystko (SPA) nie jest celem wywołań, a pasujące wywołanie jest dowodem każdego pasującego endpointu", () => {
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

  test("nazwa aplikacji albo port wskazujące repo klienta kończą szukanie bez krawędzi", () => {
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

  test("lb://nazwa w konfiguracji wskazuje aplikację po nazwie, a bez wywołań pewność jest high", () => {
    const graph = buildGraph(
      [
        repo("gateway", card([], [client({ name: "spring.cloud.gateway.routes[0].uri", app: "orders", url: "lb://orders" })])),
        repo("orders-api", card([app("orders")], [])),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.edges.map((e) => [e.from, e.to, e.key, e.confidence])).toEqual([["gateway", "orders-api", "orders", "high"]]);
  });

  test("aplikacja o tej samej nazwie w repo klienta nie obniża pewności krawędzi do jedynego innego repo", () => {
    const graph = buildGraph(
      [
        repo("bff", card([app("orders")], [client({ via: "feign", name: "OrdersClient", app: "orders" })])),
        repo("orders-api", card([app("orders")], [])),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.edges.map((e) => [e.to, e.confidence])).toEqual([["orders-api", "high"]]);
  });

  test("adres wspólny dla kilku profili wymienia je wszystkie w dowodzie", () => {
    const graph = buildGraph(
      [
        repo("shop-bff", card([], [client({ app: "orders", url: "http://orders:8080", profiles: ["dev", "prod"] })])),
        repo("orders-api", card([app("orders")], [])),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.edges[0]?.evidence[0]?.detail).toBe("address in config orders.url: orders, http://orders:8080 (profiles: dev, prod)");
  });

  test("ta sama nazwa aplikacji w dwóch repo (klon, fork) daje krawędź do każdego z pewnością medium", () => {
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

  test("host równy nazwie repo albo ostatniemu członowi adresu repo zdalnego daje krawędź medium", () => {
    const graph = buildGraph(
      [
        repo(
          "bff",
          card([], [client({ url: "http://orders-api.shop.svc:8080" }), client({ name: "billing.url", url: "https://billing/api" })]),
        ),
        repo("orders-api", card([], [])),
        repo("rozliczenia", card([], []), "gitlab.example.com/sklep/billing"),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.edges.map((e) => [e.to, e.key, e.confidence])).toEqual([
      ["orders-api", "orders-api", "medium"],
      ["rozliczenia", "billing", "medium"],
    ]);
  });

  test("alias aplikacji z workspace.yaml wskazuje repo dla nazwy, której żadna karta nie ma, a zły alias trafia do configProblems", () => {
    const graph = buildGraph(
      [repo("bff", card([], [client({ url: "http://zamowienia.internal.example.com/api" })])), repo("orders-api", card([], []))],
      {
        config: { packages: {}, apps: { "Zamowienia.internal.example.com": "orders-api", inne: "nie-ma" }, edges: [] },
        file: CONFIG_FILE,
        problems: [],
      },
    );
    expect(graph.edges.map((e) => [e.to, e.key, e.confidence, e.evidence[1]?.detail])).toEqual([
      ["orders-api", "zamowienia.internal.example.com", "high", "graph.apps: zamowienia.internal.example.com → orders-api"],
    ]);
    expect(graph.configProblems).toEqual(["graph.apps “inne”: no repo “nie-ma” in the repo list (give its id or host/path address)"]);
  });

  test("wywołania bez adresu pasujące do endpointów dwóch repo dają krawędzie low, a ścieżka bez stałego członu nie daje żadnej", () => {
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

  test("klient repo nigdy nie łączy repo z nim samym", () => {
    const graph = buildGraph([repo("orders-api", card([app("orders-api", 8081)], [client({ url: "http://localhost:8081" })]))], {
      config: NO_CONFIG,
      file: CONFIG_FILE,
      problems: [],
    });
    expect(graph.edges).toEqual([]);
  });
});

describe("graf i find_endpoint na prawdziwym gicie", () => {
  // Kilka repo z commitami i dwa liczenia kart na prawdziwym gicie trwają na Windowsie w CI dłużej niż domyślne 5 s.
  const REAL_GIT_TIMEOUT = 30_000;

  async function setup() {
    const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
    const projects = mkdtempSync(join(tmpdir(), "trackwall-projekty-"));
    const vcs = new Vcs();
    const workspace = new Workspace({
      file: new WorkspaceFile(join(home, "workspace.yaml")),
      vcs,
      hosting: fakeHosting().hosting,
      openEditor: () => {},
    });
    await workspace.setProjectsDir(projects);
    for (const name of SHOP) makeRepo(fixtureFiles(name), name, projects);
    const cards = new Cards({ vcs, repos: workspace, cache: new CardCache(join(home, "cards"), () => {}) });
    return { home, projects, graph: new Graph({ cards, workspace }), workspace };
  }

  test(
    "karty z commita czytają kontrolery i klientów wybranych wyszukiwaniem, bez kodu testów",
    async () => {
      const { graph } = await setup();
      const found = await graph.findEndpoint("/api/orders/42", "GET");

      expect(found.truncated).toBe(false);
      expect(found.endpoints.map((e) => [e.repo, e.method, e.path, e.handler, e.evidence.line])).toEqual([
        ["orders-api", "GET", "/api/orders/{id}", "OrdersController.get", 19],
      ]);
      expect(found.endpoints[0]?.callers.map((c) => [c.repo, c.via, c.client, c.path, c.confidence])).toEqual([
        ["legacy-reports", "rest-template", "OrdersReport", "/api/orders/{}", "medium"],
        ["orders-bff", "feign", "OrdersClient", "/api/orders/{id}", "exact"],
        ["orders-bff", "feign", "OrdersClient", "/api/orders/{id}", "exact"],
      ]);
      // Kontroler z src/test nie jest endpointem aplikacji.
      expect((await graph.findEndpoint("test-only", undefined)).endpoints).toEqual([]);
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "find_endpoint szuka też po fragmencie ścieżki, handlera i nazwy aplikacji, bez wielkości liter",
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
    "nowy commit w repo zmienia graf przy następnym pytaniu",
    async () => {
      const { graph, projects } = await setup();
      expect((await graph.graph()).edges.some((e) => e.from === "orders-api")).toBe(false);
      commitFiles(
        join(projects, "orders-api"),
        {
          "src/main/java/com/example/orders/api/PaymentsCheck.java":
            '@FeignClient(name = "payments-service")\ninterface PaymentsCheck {\n  @PostMapping("/api/payments/{id}") void pay();\n}\n',
        },
        "Dodaj klienta płatności",
      );
      expect((await graph.graph()).edges.filter((e) => e.from === "orders-api").map((e) => [e.to, e.key, e.confidence])).toEqual([
        ["payments", "payments-service", "exact"],
      ]);
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "alias aplikacji z workspace.yaml działa od razu, bez nowego commita",
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
