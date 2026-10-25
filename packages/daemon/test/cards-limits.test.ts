import { describe, expect, test } from "bun:test";
import { CARD_SOURCES, extractCard } from "../src/modules/cards/extract-card.ts";
import { globMatcher } from "../src/modules/cards/glob.ts";
import { extractGradle } from "../src/modules/cards/gradle.ts";
import { extractMaven } from "../src/modules/cards/maven.ts";
import { extractNpm } from "../src/modules/cards/npm.ts";
import { readSnapshot } from "../src/modules/cards/read-snapshot.ts";
import { loadSyntaxParsers } from "../src/modules/cards/syntax-tree.ts";
import { extractTools } from "../src/modules/cards/tools.ts";
import { buildGraph } from "../src/modules/graph/build-graph.ts";
import { snapshotOf } from "./support/snapshot.ts";

const parsers = await loadSyntaxParsers();

/**
 * Files from a repo are untrusted (§8): a repo the user did not choose can have a build file arranged to take up the
 * daemon's memory or CPU. Without its fix every test here took seconds or ran out of memory.
 */
describe("repo card with malicious and large files", () => {
  test("Maven properties that multiply during substitution do not take up memory: the version stays unsubstituted", () => {
    const props = Array.from({ length: 8 }, (_, i) => `<p${i}>${`\${p${i + 1}}`.repeat(200)}</p${i}>`).join("");
    const pom = `<project><groupId>g</groupId><artifactId>a</artifactId><version>\${p0}</version><properties>${props}<p8>x</p8></properties></project>`;
    const started = performance.now();
    const [provided] = extractMaven(snapshotOf({ "pom.xml": pom })).provides;
    expect(performance.now() - started).toBeLessThan(1000);
    expect(provided?.version?.length).toBeLessThanOrEqual(4096);
  });

  test("a very long Gradle script line does not block the daemon", () => {
    const line = `implementation${" ".repeat(50_000)}x\nid${" ".repeat(50_000)}x\n`;
    const started = performance.now();
    extractGradle(snapshotOf({ "build.gradle": `${line}dependencies { implementation 'com.example:lib:1.0' }\n` }));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("tens of thousands of package.json files in the tree do not block finding build roots", () => {
    const paths = Array.from({ length: 20_000 }, (_, i) => `libs/p${i}/package.json`);
    const started = performance.now();
    const out = extractNpm(snapshotOf({ "web/package.json": JSON.stringify({ name: "web", private: true }) }, paths));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(out.buildFiles.map((f) => f.path)).toEqual(["web/package.json"]);
  });

  test("a Maven version with thousands of open ${ does not block the daemon", () => {
    const pom = `<project><groupId>g</groupId><artifactId>a</artifactId><version>${"${".repeat(100_000)}</version></project>`;
    const started = performance.now();
    extractMaven(snapshotOf({ "pom.xml": pom }));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a package.json with tens of thousands of dependencies and a workspace pattern with thousands of slashes do not block the daemon", () => {
    const dependencies = Object.fromEntries(Array.from({ length: 40_000 }, (_, i) => [`dep-${i}`, "1.0.0"]));
    const started = performance.now();
    const out = extractNpm(
      snapshotOf({ "package.json": JSON.stringify({ name: "app", workspaces: [`a${"/".repeat(100_000)}b`], dependencies }, null, 2) }),
    );
    expect(performance.now() - started).toBeLessThan(2000);
    expect(out.consumes.at(-1)?.evidence).toEqual({ path: "package.json", line: 40_006 });
  });

  test("[tools] with tens of thousands of entries and a wrapper with repeated gradle- do not block the daemon", () => {
    const mise = `[tools]\n${Array.from({ length: 20_000 }, (_, i) => `tool${i} = "1"`).join("\n")}\n`;
    const started = performance.now();
    const { tools } = extractTools(
      snapshotOf({ "mise.toml": mise, "gradle/wrapper/gradle-wrapper.properties": `distributionUrl=${"gradle-".repeat(70_000)}` }),
      [],
    );
    expect(performance.now() - started).toBeLessThan(2000);
    expect(tools.at(-1)?.evidence).toEqual({ path: "mise.toml", line: 20_001 });
  });

  test("a path with thousands of repetitions of k8s/ does not block the list of mechanisms", () => {
    const started = performance.now();
    extractCard(snapshotOf({}, [`${"k8s/".repeat(8000)}x.yaml`, `${"k8s/".repeat(8000)}y.yaml`]), parsers);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a glob pattern with many asterisks on a long path finishes at once (the workspace pattern comes from the repo)", () => {
    const started = performance.now();
    expect(globMatcher("*a*a*a*a*a*a*a*a*b")("a".repeat(4000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a build file git did not return within the read limit is a card problem", async () => {
    const vcs = {
      commitFiles: async () => ({
        files: [
          { name: "pom.xml", path: "pom.xml", kind: "file" as const, size: 10 },
          { name: "pom.xml", path: "api/pom.xml", kind: "file" as const, size: 10 },
        ],
        truncated: false,
      }),
      readFiles: async () => new Map([["pom.xml", Buffer.from("<project/>")]]),
      grepFiles: async () => ({ paths: [], truncated: false }),
    };
    const snapshot = await readSnapshot(vcs, "/repo", "a".repeat(40), (path) => path.endsWith("pom.xml"), CARD_SOURCES);
    expect(snapshot.text("pom.xml")).toBe("<project/>");
    expect(snapshot.problems).toEqual([{ path: "api/pom.xml", message: "the file was not read within the 67108864 B commit read limit" }]);
  });

  test("a Java file with thousands of nested brackets, unclosed strings and annotations does not block the daemon", () => {
    const java = [
      "@RestController class Deep {",
      `  @GetMapping(${"(".repeat(50_000)}"/x"${")".repeat(50_000)})`,
      "  void x() {}",
      `  @PostMapping(${"{".repeat(50_000)}`,
      `  String s = "${"\\".repeat(50_000)}`,
      `${'@GetMapping("/a") '.repeat(20_000)}void many() {}`,
      "}",
    ].join("\n");
    const started = performance.now();
    extractCard(snapshotOf({ "src/main/java/a/Deep.java": java }), parsers);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("a class with RestTemplate, tens of thousands of unclosed calls and different base addresses does not block the daemon", () => {
    const java = `class C {\n  RestTemplate rest;\n${"x.a(".repeat(50_000)}\n${Array.from({ length: 20_000 }, (_, i) => `b.baseUrl("http://h${i}");`).join("\n")}\n}`;
    const started = performance.now();
    extractCard(snapshotOf({ "src/main/java/a/C.java": java }), parsers);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("thousands of calls nested in a method body and a .uri( chain do not block the daemon", () => {
    const nested = `class C {\n  RestTemplate rest;\n  void f() { ${"x.a(".repeat(20_000)}${")".repeat(20_000)} }\n  void g() { ${"w.get().uri(".repeat(20_000)}${")".repeat(20_000)} }\n}`;
    const started = performance.now();
    extractCard(snapshotOf({ "src/main/java/a/C.java": nested }), parsers);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("an application.yml with thousands of addresses in one module gives a card with the first 500 and a problem, and 500 addresses give no problem", () => {
    const urls = Array.from({ length: 5_000 }, (_, i) => `url${i}: http://h${i}`).join("\n");
    const card = extractCard(snapshotOf({ "src/main/resources/application.yml": `${urls}\n` }), parsers);
    expect(card.consumes.filter((c) => c.kind === "http")).toHaveLength(500);
    const exactly500 = Array.from({ length: 500 }, (_, i) => `url${i}: http://h${i}`).join("\n");
    expect(extractCard(snapshotOf({ "src/main/resources/application.yml": `${exactly500}\nplain: v\n` }), parsers).problems).toEqual([]);
    expect(card.problems).toContainEqual({
      path: "",
      message: "the module has more than 500 addresses in its config; the card shows the first ones",
    });
  });

  test("a file with tens of thousands of RestTemplate calls does not block the daemon", () => {
    const calls = Array.from({ length: 30_000 }, (_, i) => `    rest.getForObject("http://h/p${i}", String.class);`).join("\n");
    const java = `class C {\n  RestTemplate rest;\n  void f() {\n${calls}\n  }\n}`;
    const started = performance.now();
    extractCard(snapshotOf({ "src/main/java/a/C.java": java }), parsers);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("an application.yml with tens of thousands of keys and hundreds of profiles does not block the daemon", () => {
    const flat = Array.from({ length: 30_000 }, (_, i) => `k${i}: v${i}`).join("\n");
    const profiles = Array.from({ length: 800 }, (_, i) => `---\nspring.config.activate.on-profile: p${i}\nurl${i}: http://h${i}`).join(
      "\n",
    );
    const started = performance.now();
    extractCard(snapshotOf({ "src/main/resources/application.yml": `${flat}\n${profiles}\n` }), parsers);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("a source file search error is a card problem, and the build files stay", async () => {
    const vcs = {
      commitFiles: async () => ({
        files: [
          { name: "pom.xml", path: "pom.xml", kind: "file" as const, size: 10 },
          { name: "Api.java", path: "src/main/java/Api.java", kind: "file" as const, size: 10 },
        ],
        truncated: false,
      }),
      readFiles: async () => new Map([["pom.xml", Buffer.from("<project/>")]]),
      grepFiles: async () => {
        throw new Error("git grep: timed out");
      },
    };
    const snapshot = await readSnapshot(vcs, "/repo", "a".repeat(40), (path) => path.endsWith("pom.xml"), CARD_SOURCES);
    expect(snapshot.text("pom.xml")).toBe("<project/>");
    expect(snapshot.problems).toEqual([
      { path: "", message: "searching for files with controllers and HTTP clients failed: git grep: timed out" },
    ]);
  });

  test("constants that concatenate with themselves or double do not take up memory", () => {
    const constants = Array.from({ length: 30 }, (_, i) => `static final String C${i} = C${i + 1} + C${i + 1};`).join("\n");
    const java = `@RestController class Api {\n${constants}\nstatic final String C30 = "${"x".repeat(1000)}";\nstatic final String L = L + "/a";\n@GetMapping(C0) void a() {}\n@GetMapping(L) void b() {}\n}`;
    const started = performance.now();
    const card = extractCard(snapshotOf({ "src/main/java/a/Api.java": java }), parsers);
    expect(performance.now() - started).toBeLessThan(1000);
    for (const p of card.provides) if (p.kind === "endpoint") expect(p.path.length).toBeLessThanOrEqual(4096);
  });

  test(`\${...} from application.yml that multiply while resolving or form a cycle do not block the daemon`, () => {
    const yml = Array.from({ length: 30 }, (_, i) => `k${i}: "\${k${i + 1}}\${k${i + 1}}"`).join("\n");
    const started = performance.now();
    extractCard(
      snapshotOf({
        "src/main/resources/application.yml": `${yml}\nk30: http://x\na: \${b}\nb: \${a}\nserver:\n  port: \${k0}\n`,
        "src/main/java/a/C.java": `@FeignClient(name = "c", url = "\${k0}") interface C {}`,
      }),
      parsers,
    );
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a response type and DTO fields with tens of thousands of arguments give a cut type notation quickly", () => {
    const args = "A,".repeat(40_000);
    const java = `@RestController class Api { @GetMapping("/a") M<${args}A> a() { return null; } }\nclass M { N<${args}D> f; }\nclass D { int x; }`;
    const started = performance.now();
    const card = extractCard(snapshotOf({ "src/main/java/a/Api.java": java }), parsers);
    expect(performance.now() - started).toBeLessThan(2000);
    const endpoint = card.provides.find((p) => p.kind === "endpoint");
    expect(endpoint?.kind === "endpoint" ? endpoint.response?.length : 0).toBe(257);
    expect(card.dtos.map((d) => (d.kind === "enum" ? d.name : `${d.name}: ${d.fields[0]?.type.length}`))).toEqual(["M: 257", "D: 3"]);
  });

  test("a graph with thousands of endpoints and clients without an address is computed quickly", () => {
    const endpoints = Array.from({ length: 3000 }, (_, i) => `  @GetMapping("/api/r${i % 50}/{id}/x${i}") void e${i}() {}`).join("\n");
    const calls = Array.from(
      { length: 200 },
      (_, i) => `  void c${i}() { rest.getForObject("/api/r${i % 50}/" + id + "/x${i}", String.class); }`,
    ).join("\n");
    const api = extractCard(snapshotOf({ "src/main/java/a/Api.java": `@RestController class Api {\n${endpoints}\n}` }), parsers);
    const client = extractCard(snapshotOf({ "src/main/java/a/Client.java": `class Client {\n  RestTemplate rest;\n${calls}\n}` }), parsers);
    const cards = Array.from({ length: 30 }, (_, i) => ({
      kind: "ok" as const,
      repo: `r${i}`,
      remote: null,
      card: i === 0 ? client : api,
      tags: [],
    }));
    const started = performance.now();
    const graph = buildGraph(cards, { config: { packages: {}, apps: {}, edges: [] }, file: "workspace.yaml", problems: [] });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(graph.edges.filter((e) => e.from === "r0")).toHaveLength(29);
  });
});
