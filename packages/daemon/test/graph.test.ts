import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsumedPackage, GraphConfig, ProvidedPackage, RepoCard } from "@trackwall/protocol";
import { CardCache } from "../src/modules/cards/card-cache.ts";
import { Cards } from "../src/modules/cards/cards.ts";
import { buildGraph, type GraphCardInput } from "../src/modules/graph/build-graph.ts";
import { Graph } from "../src/modules/graph/graph.ts";
import { subgraph } from "../src/modules/graph/subgraph.ts";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { gitIn, makeRepo } from "./support/git-repo.ts";
import { fakeHosting } from "./support/hosting.ts";

const CONFIG_FILE = "/home/ja/.trackwall/workspace.yaml";
const NO_CONFIG: GraphConfig = { packages: {}, edges: [] };

function provides(name: string, path = "pom.xml"): ProvidedPackage {
  return { kind: "package", ecosystem: "maven", name, version: "1.0.0", evidence: { path, line: 3 } };
}

function consumes(name: string, scope = "compile"): ConsumedPackage {
  return { kind: "package", ecosystem: "maven", name, version: "1.0.0", scope, evidence: { path: "pom.xml", line: 12 } };
}

function card(p: ProvidedPackage[], c: ConsumedPackage[]): RepoCard {
  return { commit: "a".repeat(40), buildFiles: [], provides: p, consumes: c, tools: [], mechanisms: [], problems: [] };
}

function repo(id: string, repoCard: RepoCard | null, remote: string | null = null): GraphCardInput {
  return { kind: "ok", repo: id, remote, card: repoCard, tags: [] };
}

describe("buildGraph: krawędzie z kart", () => {
  test("paczka używana przez jedno repo i budowana przez drugie daje krawędź exact z dowodami z obu stron", () => {
    const graph = buildGraph(
      [
        repo("orders-bff", card([], [consumes("com.example:orders-client")])),
        repo("orders-api", card([provides("com.example:orders-client", "client/pom.xml")], [])),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE },
    );

    expect(graph.edges).toEqual([
      {
        from: "orders-bff",
        to: "orders-api",
        kind: "package",
        key: "com.example:orders-client",
        confidence: "exact",
        evidence: [
          { repo: "orders-bff", path: "pom.xml", line: 12, detail: "używa com.example:orders-client 1.0.0 (compile)" },
          { repo: "orders-api", path: "client/pom.xml", line: 3, detail: "buduje com.example:orders-client" },
        ],
      },
    ]);
    expect(graph.nodes.map((n) => [n.repo, n.provides, n.problem])).toEqual([
      ["orders-bff", 0, null],
      ["orders-api", 1, null],
    ]);
    expect(graph.configProblems).toEqual([]);
  });

  test("paczka z tą samą nazwą w innym ekosystemie nie łączy repo", () => {
    const npm: ConsumedPackage = { ...consumes("com.example:orders-client"), ecosystem: "npm" };
    const graph = buildGraph([repo("web", card([], [npm])), repo("orders-api", card([provides("com.example:orders-client")], []))], {
      config: NO_CONFIG,
      file: CONFIG_FILE,
    });
    expect(graph.edges).toEqual([]);
  });

  test("paczka budowana przez dwa repo (np. dwa klony) daje krawędź do każdego z pewnością medium", () => {
    const graph = buildGraph(
      [
        repo("app", card([], [consumes("com.example:core")])),
        repo("core", card([provides("com.example:core")], [])),
        repo("core-kopia", card([provides("com.example:core")], [])),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE },
    );
    expect(graph.edges.map((e) => [e.from, e.to, e.confidence])).toEqual([
      ["app", "core", "medium"],
      ["app", "core-kopia", "medium"],
    ]);
  });

  test("repo bez karty albo nieczytelne jest węzłem bez krawędzi z powodem", () => {
    const graph = buildGraph([repo("pusty", null), { kind: "unavailable", repo: "zepsuty", message: "fatal: not a git repository" }], {
      config: NO_CONFIG,
      file: CONFIG_FILE,
    });
    expect(graph.nodes).toEqual([
      { repo: "pusty", remote: null, tags: [], provides: 0, problem: null },
      { repo: "zepsuty", remote: null, tags: [], provides: null, problem: "fatal: not a git repository" },
    ]);
    expect(graph.edges).toEqual([]);
  });
});

describe("buildGraph: wpisy graph w workspace.yaml", () => {
  test("alias paczki łączy repo, którego karta paczki nie pokazuje, z pewnością high i dowodem w workspace.yaml", () => {
    const graph = buildGraph(
      [
        repo("orders-bff", card([], [consumes("com.example:orders-client")])),
        repo("orders-api", card([], []), "gitlab.example.com/sklep/orders-api"),
      ],
      {
        config: { packages: { "com.example:orders-client": "gitlab.example.com/Sklep/orders-api" }, edges: [] },
        file: CONFIG_FILE,
      },
    );
    expect(graph.edges).toEqual([
      {
        from: "orders-bff",
        to: "orders-api",
        kind: "package",
        key: "com.example:orders-client",
        confidence: "high",
        evidence: [
          { repo: "orders-bff", path: "pom.xml", line: 12, detail: "używa com.example:orders-client 1.0.0 (compile)" },
          {
            repo: null,
            path: CONFIG_FILE,
            line: null,
            detail: "graph.packages: com.example:orders-client → gitlab.example.com/Sklep/orders-api",
          },
        ],
      },
    ]);
  });

  test("alias nie zastępuje paczki, którą karta znalazła w innym repo", () => {
    const graph = buildGraph(
      [
        repo("app", card([], [consumes("com.example:core")])),
        repo("core", card([provides("com.example:core")], [])),
        repo("inne", card([], [])),
      ],
      { config: { packages: { "com.example:core": "inne" }, edges: [] }, file: CONFIG_FILE },
    );
    expect(graph.edges.map((e) => [e.from, e.to, e.confidence])).toEqual([["app", "core", "exact"]]);
  });

  test("ręczna krawędź łączy repo po identyfikatorze z opisem jako kluczem", () => {
    const graph = buildGraph([repo("web", card([], [])), repo("orders-bff", card([], []))], {
      config: { packages: {}, edges: [{ from: "web", to: "orders-bff", note: "HTTP /api/orders" }] },
      file: CONFIG_FILE,
    });
    expect(graph.edges).toEqual([
      {
        from: "web",
        to: "orders-bff",
        kind: "manual",
        key: "HTTP /api/orders",
        confidence: "exact",
        evidence: [{ repo: null, path: CONFIG_FILE, line: null, detail: "graph.edges[0]: web → orders-bff" }],
      },
    ]);
  });

  test("wpis z repo spoza listy trafia do configProblems i nie daje krawędzi", () => {
    const graph = buildGraph([repo("web", card([], []))], {
      config: { packages: { "com.example:x": "nie-ma" }, edges: [{ from: "web", to: "nie-ma-tez", note: "HTTP" }] },
      file: CONFIG_FILE,
    });
    expect(graph.edges).toEqual([]);
    expect(graph.configProblems).toEqual([
      "graph.packages „com.example:x”: nie ma repo „nie-ma” na liście repo (podaj identyfikator albo adres host/ścieżka)",
      "graph.edges[0].to: nie ma repo „nie-ma-tez” na liście repo (podaj identyfikator albo adres host/ścieżka)",
    ]);
  });
});

describe("subgraph", () => {
  // a → b → c → d, e osobno
  const graph = buildGraph(
    ["a", "b", "c", "d", "e"].map((id) => repo(id, card([], []))),
    {
      config: {
        packages: {},
        edges: [
          { from: "a", to: "b", note: "1" },
          { from: "b", to: "c", note: "2" },
          { from: "c", to: "d", note: "3" },
        ],
      },
      file: CONFIG_FILE,
    },
  );

  test("głębokość 1 to repo i jego sąsiedzi w obie strony z krawędziami między nimi", () => {
    const sub = subgraph(graph, "b", 1);
    expect(sub.nodes.map((n) => n.repo)).toEqual(["a", "b", "c"]);
    expect(sub.edges.map((e) => e.key)).toEqual(["1", "2"]);
  });

  test("głębokość 2 sięga o krawędź dalej, a repo bez połączeń zostaje samo", () => {
    expect(subgraph(graph, "a", 2).nodes.map((n) => n.repo)).toEqual(["a", "b", "c"]);
    expect(subgraph(graph, "e", 3).nodes.map((n) => n.repo)).toEqual(["e"]);
  });
});

describe("Graph na kartach z prawdziwego gita", () => {
  async function setup() {
    const home = mkdtempSync(join(tmpdir(), "trackwall-graph-home-"));
    const projects = mkdtempSync(join(tmpdir(), "trackwall-graph-projekty-"));
    const vcs = new Vcs();
    const file = new WorkspaceFile(join(home, "workspace.yaml"));
    const workspace = new Workspace({ file, vcs, hosting: fakeHosting().hosting, openUrl: () => {} });
    await workspace.setProjectsDir(projects);
    const cards = new Cards({ vcs, repos: workspace, cache: new CardCache(join(home, "cards"), () => {}) });
    return { projects, workspaceFile: file.path, graph: new Graph({ cards, workspace }) };
  }

  const CORE_POM =
    "<project>\n  <groupId>com.example</groupId>\n  <artifactId>core-lib</artifactId>\n  <version>1.2.0</version>\n</project>\n";
  const APP_POM =
    "<project>\n  <groupId>com.example</groupId>\n  <artifactId>orders</artifactId>\n  <dependencies>\n    <dependency>\n" +
    "      <groupId>com.example</groupId>\n      <artifactId>core-lib</artifactId>\n      <version>1.2.0</version>\n    </dependency>\n" +
    "  </dependencies>\n</project>\n";

  test("łączy repo przez wspólny artefakt Maven i ręczną krawędź po adresie repo zdalnego", async () => {
    const { projects, workspaceFile, graph } = await setup();
    makeRepo({ "pom.xml": CORE_POM }, "core-lib", projects);
    makeRepo({ "pom.xml": APP_POM }, "orders", projects);
    const web = makeRepo({ "package.json": JSON.stringify({ name: "web", private: true }) }, "web", projects);
    gitIn(web, "remote", "add", "origin", "https://gitlab.example.com/sklep/web.git");
    writeFileSync(
      workspaceFile,
      `${readFileSync(workspaceFile, "utf8")}graph:\n  edges:\n    - from: gitlab.example.com/sklep/web\n      to: orders\n      note: HTTP /api/orders\n`,
    );

    const result = await graph.graph();

    expect(result.edges.map((e) => [e.from, e.to, e.kind, e.key, e.confidence])).toEqual([
      ["orders", "core-lib", "package", "com.example:core-lib", "exact"],
      ["web", "orders", "manual", "HTTP /api/orders", "exact"],
    ]);
    expect(result.edges[0]?.evidence.map((e) => [e.repo, e.path, e.line])).toEqual([
      ["orders", "pom.xml", 5],
      ["core-lib", "pom.xml", 3],
    ]);
    expect(result.configFile).toBe(workspaceFile);
    expect((await graph.whoCalls("orders")).map((e) => e.from)).toEqual(["web"]);
    expect((await graph.subgraph("web", 2)).nodes.map((n) => n.repo).sort()).toEqual(["core-lib", "orders", "web"]);
  });

  test("zły klucz graph w workspace.yaml zostawia krawędzie z kart i podaje powód", async () => {
    const { projects, workspaceFile, graph } = await setup();
    makeRepo({ "pom.xml": CORE_POM }, "core-lib", projects);
    makeRepo({ "pom.xml": APP_POM }, "orders", projects);
    writeFileSync(workspaceFile, `${readFileSync(workspaceFile, "utf8")}graph:\n  edges: nie-lista\n`);

    const result = await graph.graph();

    expect(result.edges.map((e) => e.key)).toEqual(["com.example:core-lib"]);
    expect(result.configProblems).toHaveLength(1);
    expect(result.configProblems[0]).toContain("graph");
  });

  test("who_calls i subgraph dla repo spoza listy to not_found", async () => {
    const { graph } = await setup();
    await expect(graph.whoCalls("nie-ma")).rejects.toMatchObject({ code: "not_found" });
    await expect(graph.subgraph("nie-ma", 1)).rejects.toMatchObject({ code: "not_found" });
  });
});
