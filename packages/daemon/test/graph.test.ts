import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsumedPackage, GraphConfig, ProvidedPackage, RepoCard } from "@trackwall/protocol";
import { CardCache } from "../src/modules/cards/card-cache.ts";
import { Cards } from "../src/modules/cards/cards.ts";
import { buildGraph } from "../src/modules/graph/build-graph.ts";
import { Graph } from "../src/modules/graph/graph.ts";
import type { GraphCardInput } from "../src/modules/graph/graph-input.ts";
import { subgraph } from "../src/modules/graph/subgraph.ts";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { gitIn, makeRepo } from "./support/git-repo.ts";
import { fakeHosting } from "./support/hosting.ts";

const CONFIG_FILE = "/home/me/.trackwall/workspace.yaml";
const NO_CONFIG: GraphConfig = { packages: {}, apps: {}, edges: [] };

function provides(name: string, path = "pom.xml"): ProvidedPackage {
  return { kind: "package", ecosystem: "maven", name, version: "1.0.0", evidence: { path, line: 3 } };
}

function consumes(name: string, scope = "compile"): ConsumedPackage {
  return { kind: "package", ecosystem: "maven", name, version: "1.0.0", scope, evidence: { path: "pom.xml", line: 12 } };
}

function card(p: ProvidedPackage[], c: ConsumedPackage[]): RepoCard {
  return {
    commit: "a".repeat(40),
    buildFiles: [],
    provides: p,
    consumes: c,
    dtos: [],
    tools: [],
    mise: { configFiles: [], tasks: [], complete: true },
    mechanisms: [],
    reachTraced: false,
    problems: [],
  };
}

function repo(id: string, repoCard: RepoCard | null, remote: string | null = null): GraphCardInput {
  return { kind: "ok", repo: id, remote, card: repoCard, tags: [] };
}

describe("buildGraph: edges from cards", () => {
  test("a package used by one repo and built by another gives an exact edge with evidence from both sides", () => {
    const graph = buildGraph(
      [
        repo("orders-bff", card([], [consumes("com.example:orders-client")])),
        repo("orders-api", card([provides("com.example:orders-client", "client/pom.xml")], [])),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );

    expect(graph.edges).toEqual([
      {
        from: "orders-bff",
        to: "orders-api",
        kind: "package",
        key: "com.example:orders-client",
        confidence: "exact",
        evidence: [
          { repo: "orders-bff", path: "pom.xml", line: 12, detail: "uses com.example:orders-client 1.0.0 (compile)" },
          { repo: "orders-api", path: "client/pom.xml", line: 3, detail: "builds com.example:orders-client" },
        ],
      },
    ]);
    expect(graph.nodes.map((n) => [n.repo, n.provides, n.problem])).toEqual([
      ["orders-bff", 0, null],
      ["orders-api", 1, null],
    ]);
    expect(graph.configProblems).toEqual([]);
  });

  test("a package with the same name in another ecosystem does not join repos", () => {
    const npm: ConsumedPackage = { ...consumes("com.example:orders-client"), ecosystem: "npm" };
    const graph = buildGraph([repo("web", card([], [npm])), repo("orders-api", card([provides("com.example:orders-client")], []))], {
      config: NO_CONFIG,
      file: CONFIG_FILE,
      problems: [],
    });
    expect(graph.edges).toEqual([]);
  });

  test("a package built by two repos (e.g. two clones) gives an edge to each with medium confidence", () => {
    const graph = buildGraph(
      [
        repo("app", card([], [consumes("com.example:core")])),
        repo("core", card([provides("com.example:core")], [])),
        repo("core-kopia", card([provides("com.example:core")], [])),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.edges.map((e) => [e.from, e.to, e.confidence])).toEqual([
      ["app", "core", "medium"],
      ["app", "core-kopia", "medium"],
    ]);
  });

  test("a package built by two build files of one repo gives an exact edge and counts once", () => {
    const graph = buildGraph(
      [
        repo("app", card([], [consumes("com.example:core")])),
        repo("core", card([provides("com.example:core", "pom.xml"), provides("com.example:core", "build.gradle")], [])),
      ],
      { config: NO_CONFIG, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.edges.map((e) => [e.to, e.confidence])).toEqual([["core", "exact"]]);
    expect(graph.nodes.find((n) => n.repo === "core")?.provides).toBe(1);
  });

  test("a package named after an object prototype member (constructor) does not break the graph", () => {
    const npm: ConsumedPackage = { ...consumes("constructor"), ecosystem: "npm" };
    const graph = buildGraph([repo("web", card([], [npm]))], { config: NO_CONFIG, file: CONFIG_FILE, problems: [] });
    expect(graph.edges).toEqual([]);
    expect(graph.configProblems).toEqual([]);
  });

  test("a repo without a card or an unreadable one is a node without edges, with a reason", () => {
    const graph = buildGraph([repo("empty", null), { kind: "unavailable", repo: "unreadable", message: "fatal: not a git repository" }], {
      config: NO_CONFIG,
      file: CONFIG_FILE,
      problems: [],
    });
    expect(graph.nodes).toEqual([
      { repo: "empty", remote: null, tags: [], provides: 0, apps: [], endpoints: 0, problem: null },
      { repo: "unreadable", remote: null, tags: [], provides: null, apps: [], endpoints: null, problem: "fatal: not a git repository" },
    ]);
    expect(graph.edges).toEqual([]);
  });
});

describe("buildGraph: graph entries in workspace.yaml", () => {
  test("a package alias joins a repo whose card does not show the package, with high confidence and evidence in workspace.yaml", () => {
    const graph = buildGraph(
      [
        repo("orders-bff", card([], [consumes("com.example:orders-client")])),
        repo("orders-api", card([], []), "gitlab.example.com/shop/orders-api"),
      ],
      {
        config: { packages: { "com.example:orders-client": "gitlab.example.com/Shop/orders-api" }, apps: {}, edges: [] },
        file: CONFIG_FILE,
        problems: [],
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
          { repo: "orders-bff", path: "pom.xml", line: 12, detail: "uses com.example:orders-client 1.0.0 (compile)" },
          {
            repo: null,
            path: CONFIG_FILE,
            line: null,
            detail: "graph.packages: com.example:orders-client → gitlab.example.com/Shop/orders-api",
          },
        ],
      },
    ]);
  });

  test("an alias does not replace a package a card found in another repo", () => {
    const graph = buildGraph(
      [
        repo("app", card([], [consumes("com.example:core")])),
        repo("core", card([provides("com.example:core")], [])),
        repo("other", card([], [])),
      ],
      { config: { packages: { "com.example:core": "other" }, apps: {}, edges: [] }, file: CONFIG_FILE, problems: [] },
    );
    expect(graph.edges.map((e) => [e.from, e.to, e.confidence])).toEqual([["app", "core", "exact"]]);
  });

  test("an alias does not work for a package built by the same repo that uses it", () => {
    const graph = buildGraph([repo("app", card([provides("com.example:x")], [consumes("com.example:x")])), repo("other", card([], []))], {
      config: { packages: { "com.example:x": "other" }, apps: {}, edges: [] },
      file: CONFIG_FILE,
      problems: [],
    });
    expect(graph.edges).toEqual([]);
  });

  test("a manual edge joins repos by identifier with the note as the key", () => {
    const graph = buildGraph([repo("web", card([], [])), repo("orders-bff", card([], []))], {
      config: { packages: {}, apps: {}, edges: [{ from: "web", to: "orders-bff", note: "HTTP /api/orders" }] },
      file: CONFIG_FILE,
      problems: [],
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

  test("a manual edge from a repo to itself goes to configProblems", () => {
    const graph = buildGraph([repo("web", card([], []), "gitlab.example.com/shop/web")], {
      config: { packages: {}, apps: {}, edges: [{ from: "web", to: "gitlab.example.com/shop/web", note: "HTTP" }] },
      file: CONFIG_FILE,
      problems: [],
    });
    expect(graph.edges).toEqual([]);
    expect(graph.configProblems).toEqual(["graph.edges[0]: from and to point to the same repo (web)"]);
  });

  test("an entry with a repo outside the list goes to configProblems and gives no edge", () => {
    const graph = buildGraph([repo("web", card([], []))], {
      config: { packages: { "com.example:x": "missing" }, apps: {}, edges: [{ from: "web", to: "also-missing", note: "HTTP" }] },
      file: CONFIG_FILE,
      problems: [],
    });
    expect(graph.edges).toEqual([]);
    expect(graph.configProblems).toEqual([
      "graph.packages “com.example:x”: no repo “missing” in the repo list (give its id or host/path address)",
      "graph.edges[0].to: no repo “also-missing” in the repo list (give its id or host/path address)",
    ]);
  });
});

describe("subgraph", () => {
  // a → b → c → d, e on its own
  const graph = buildGraph(
    ["a", "b", "c", "d", "e"].map((id) => repo(id, card([], []))),
    {
      config: {
        packages: {},
        apps: {},
        edges: [
          { from: "a", to: "b", note: "1" },
          { from: "b", to: "c", note: "2" },
          { from: "c", to: "d", note: "3" },
        ],
      },
      file: CONFIG_FILE,
      problems: [],
    },
  );

  test("depth 1 is the repo and its neighbours in both directions with the edges between them", () => {
    const sub = subgraph(graph, "b", 1);
    expect(sub.nodes.map((n) => n.repo)).toEqual(["a", "b", "c"]);
    expect(sub.edges.map((e) => e.key)).toEqual(["1", "2"]);
  });

  test("depth 2 reaches one edge further, and a repo without connections stays alone", () => {
    expect(subgraph(graph, "a", 2).nodes.map((n) => n.repo)).toEqual(["a", "b", "c"]);
    expect(subgraph(graph, "e", 3).nodes.map((n) => n.repo)).toEqual(["e"]);
  });
});

describe("Graph on cards from real git", () => {
  async function setup() {
    const home = mkdtempSync(join(tmpdir(), "trackwall-graph-home-"));
    const projects = mkdtempSync(join(tmpdir(), "trackwall-graph-projects-"));
    const vcs = new Vcs(systemTempFolder);
    const file = new WorkspaceFile(join(home, "workspace.yaml"));
    const workspace = new Workspace({ file, vcs, hosting: fakeHosting().hosting, openEditor: () => {}, openFolder: () => {} });
    await workspace.setProjectsDir(projects);
    const cards = new Cards({ vcs, repos: workspace, cache: new CardCache(join(home, "cards"), () => {}), log: () => {} });
    return { projects, workspaceFile: file.path, graph: new Graph({ cards, workspace }) };
  }

  const CORE_POM =
    "<project>\n  <groupId>com.example</groupId>\n  <artifactId>core-lib</artifactId>\n  <version>1.2.0</version>\n</project>\n";
  const APP_POM =
    "<project>\n  <groupId>com.example</groupId>\n  <artifactId>orders</artifactId>\n  <dependencies>\n    <dependency>\n" +
    "      <groupId>com.example</groupId>\n      <artifactId>core-lib</artifactId>\n      <version>1.2.0</version>\n    </dependency>\n" +
    "  </dependencies>\n</project>\n";

  test("joins repos through a shared Maven artifact and a manual edge by remote repo address", async () => {
    const { projects, workspaceFile, graph } = await setup();
    makeRepo({ "pom.xml": CORE_POM }, "core-lib", projects);
    makeRepo({ "pom.xml": APP_POM }, "orders", projects);
    const web = makeRepo({ "package.json": JSON.stringify({ name: "web", private: true }) }, "web", projects);
    gitIn(web, "remote", "add", "origin", "https://gitlab.example.com/shop/web.git");
    writeFileSync(
      workspaceFile,
      `${readFileSync(workspaceFile, "utf8")}graph:\n  edges:\n    - from: gitlab.example.com/shop/web\n      to: orders\n      note: HTTP /api/orders\n`,
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
    expect((await graph.whoCalls("orders")).edges.map((e) => e.from)).toEqual(["web"]);
    expect((await graph.subgraph("web", 2)).nodes.map((n) => n.repo).sort()).toEqual(["core-lib", "orders", "web"]);
  });

  test("a bad graph key in workspace.yaml keeps the edges from the cards and gives a reason", async () => {
    const { projects, workspaceFile, graph } = await setup();
    makeRepo({ "pom.xml": CORE_POM }, "core-lib", projects);
    makeRepo({ "pom.xml": APP_POM }, "orders", projects);
    writeFileSync(workspaceFile, `${readFileSync(workspaceFile, "utf8")}graph:\n  edges: not-a-list\n`);

    const result = await graph.graph();

    expect(result.edges.map((e) => e.key)).toEqual(["com.example:core-lib"]);
    expect(result.configProblems).toHaveLength(1);
    expect(result.configProblems[0]).toContain("graph");
  });

  test("an empty packages subkey does not take away the manual edges", async () => {
    const { projects, workspaceFile, graph } = await setup();
    makeRepo({ "pom.xml": CORE_POM }, "core-lib", projects);
    makeRepo({ "pom.xml": APP_POM }, "orders", projects);
    writeFileSync(
      workspaceFile,
      `${readFileSync(workspaceFile, "utf8")}graph:\n  packages:\n  edges:\n    - { from: core-lib, to: orders, note: HTTP }\n`,
    );

    const result = await graph.graph();

    expect(result.edges.map((e) => [e.from, e.to])).toEqual([
      ["core-lib", "orders"],
      ["orders", "core-lib"],
    ]);
    expect(result.configProblems).toEqual([]);
  });

  test("a bad repoTags keeps the graph with edges, without tags from rules and with a reason", async () => {
    const { projects, workspaceFile, graph } = await setup();
    makeRepo({ "pom.xml": CORE_POM }, "core-lib", projects);
    makeRepo({ "pom.xml": APP_POM }, "orders", projects);
    writeFileSync(workspaceFile, `${readFileSync(workspaceFile, "utf8")}repoTags:\n  Bad-Name: ["*"]\n`);

    const result = await graph.graph();

    expect(result.edges.map((e) => e.key)).toEqual(["com.example:core-lib"]);
    expect(result.nodes.map((n) => n.tags)).toEqual([
      ["java", "library", "no-mise"],
      ["java", "library", "no-mise"],
    ]);
    expect(result.configProblems).toHaveLength(1);
    expect(result.configProblems[0]).toContain("repoTags");
  });

  test("who_calls and subgraph for a repo outside the list are not_found", async () => {
    const { graph } = await setup();
    await expect(graph.whoCalls("missing")).rejects.toMatchObject({ code: "not_found" });
    await expect(graph.subgraph("missing", 1)).rejects.toMatchObject({ code: "not_found" });
  });
});
