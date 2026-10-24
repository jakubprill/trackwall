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
 * Pliki z repo są niezaufane (§8): repo, którego użytkownik nie wybrał, może mieć plik buildu ułożony tak, żeby
 * zająć pamięć albo procesor daemona. Każdy test tutaj bez poprawki trwał sekundy albo kończył się brakiem pamięci.
 */
describe("karta repo przy złośliwych i dużych plikach", () => {
  test("właściwości Maven, które mnożą się przy podstawianiu, nie zajmują pamięci: wersja zostaje niepodstawiona", () => {
    const props = Array.from({ length: 8 }, (_, i) => `<p${i}>${`\${p${i + 1}}`.repeat(200)}</p${i}>`).join("");
    const pom = `<project><groupId>g</groupId><artifactId>a</artifactId><version>\${p0}</version><properties>${props}<p8>x</p8></properties></project>`;
    const started = performance.now();
    const [provided] = extractMaven(snapshotOf({ "pom.xml": pom })).provides;
    expect(performance.now() - started).toBeLessThan(1000);
    expect(provided?.version?.length).toBeLessThanOrEqual(4096);
  });

  test("bardzo długa linia skryptu Gradle nie blokuje daemona", () => {
    const line = `implementation${" ".repeat(50_000)}x\nid${" ".repeat(50_000)}x\n`;
    const started = performance.now();
    extractGradle(snapshotOf({ "build.gradle": `${line}dependencies { implementation 'com.example:lib:1.0' }\n` }));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("dziesiątki tysięcy package.json w drzewie nie blokują szukania korzeni buildów", () => {
    const paths = Array.from({ length: 20_000 }, (_, i) => `libs/p${i}/package.json`);
    const started = performance.now();
    const out = extractNpm(snapshotOf({ "web/package.json": JSON.stringify({ name: "web", private: true }) }, paths));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(out.buildFiles.map((f) => f.path)).toEqual(["web/package.json"]);
  });

  test("wersja Maven z tysiącami otwartych ${ nie blokuje daemona", () => {
    const pom = `<project><groupId>g</groupId><artifactId>a</artifactId><version>${"${".repeat(100_000)}</version></project>`;
    const started = performance.now();
    extractMaven(snapshotOf({ "pom.xml": pom }));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("package.json z dziesiątkami tysięcy zależności i wzorzec workspace z tysiącami ukośników nie blokują daemona", () => {
    const dependencies = Object.fromEntries(Array.from({ length: 40_000 }, (_, i) => [`dep-${i}`, "1.0.0"]));
    const started = performance.now();
    const out = extractNpm(
      snapshotOf({ "package.json": JSON.stringify({ name: "app", workspaces: [`a${"/".repeat(100_000)}b`], dependencies }, null, 2) }),
    );
    expect(performance.now() - started).toBeLessThan(2000);
    expect(out.consumes.at(-1)?.evidence).toEqual({ path: "package.json", line: 40_006 });
  });

  test("[tools] z dziesiątkami tysięcy wpisów i wrapper z powtórzonym gradle- nie blokują daemona", () => {
    const mise = `[tools]\n${Array.from({ length: 20_000 }, (_, i) => `tool${i} = "1"`).join("\n")}\n`;
    const started = performance.now();
    const { tools } = extractTools(
      snapshotOf({ "mise.toml": mise, "gradle/wrapper/gradle-wrapper.properties": `distributionUrl=${"gradle-".repeat(70_000)}` }),
      [],
    );
    expect(performance.now() - started).toBeLessThan(2000);
    expect(tools.at(-1)?.evidence).toEqual({ path: "mise.toml", line: 20_001 });
  });

  test("ścieżka z tysiącami powtórzeń k8s/ nie blokuje spisu mechanizmów", () => {
    const started = performance.now();
    extractCard(snapshotOf({}, [`${"k8s/".repeat(8000)}x.yaml`, `${"k8s/".repeat(8000)}y.yaml`]), parsers);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("wzorzec glob z wieloma gwiazdkami na długiej ścieżce kończy się od razu (wzorzec workspace jest z repo)", () => {
    const started = performance.now();
    expect(globMatcher("*a*a*a*a*a*a*a*a*b")("a".repeat(4000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("plik buildu, którego git nie oddał w limicie odczytu, jest problemem karty", async () => {
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

  test("plik Javy z tysiącami zagnieżdżonych nawiasów, niezamkniętymi napisami i adnotacjami nie blokuje daemona", () => {
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

  test("klasa z RestTemplate, dziesiątkami tysięcy niedomkniętych wywołań i różnych adresów bazowych nie blokuje daemona", () => {
    const java = `class C {\n  RestTemplate rest;\n${"x.a(".repeat(50_000)}\n${Array.from({ length: 20_000 }, (_, i) => `b.baseUrl("http://h${i}");`).join("\n")}\n}`;
    const started = performance.now();
    extractCard(snapshotOf({ "src/main/java/a/C.java": java }), parsers);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("tysiące wywołań zagnieżdżonych w ciele metody i łańcuch .uri( nie blokują daemona", () => {
    const nested = `class C {\n  RestTemplate rest;\n  void f() { ${"x.a(".repeat(20_000)}${")".repeat(20_000)} }\n  void g() { ${"w.get().uri(".repeat(20_000)}${")".repeat(20_000)} }\n}`;
    const started = performance.now();
    extractCard(snapshotOf({ "src/main/java/a/C.java": nested }), parsers);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("application.yml z tysiącami adresów w jednym module daje kartę z pierwszymi 500 i problemem, a 500 adresów problemu nie daje", () => {
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

  test("plik z dziesiątkami tysięcy wywołań RestTemplate nie blokuje daemona", () => {
    const calls = Array.from({ length: 30_000 }, (_, i) => `    rest.getForObject("http://h/p${i}", String.class);`).join("\n");
    const java = `class C {\n  RestTemplate rest;\n  void f() {\n${calls}\n  }\n}`;
    const started = performance.now();
    extractCard(snapshotOf({ "src/main/java/a/C.java": java }), parsers);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("application.yml z dziesiątkami tysięcy kluczy i setkami profili nie blokuje daemona", () => {
    const flat = Array.from({ length: 30_000 }, (_, i) => `k${i}: v${i}`).join("\n");
    const profiles = Array.from({ length: 800 }, (_, i) => `---\nspring.config.activate.on-profile: p${i}\nurl${i}: http://h${i}`).join(
      "\n",
    );
    const started = performance.now();
    extractCard(snapshotOf({ "src/main/resources/application.yml": `${flat}\n${profiles}\n` }), parsers);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("błąd wyszukiwania plików źródłowych jest problemem karty, a pliki buildu zostają", async () => {
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
        throw new Error("git grep: przekroczony limit czasu");
      },
    };
    const snapshot = await readSnapshot(vcs, "/repo", "a".repeat(40), (path) => path.endsWith("pom.xml"), CARD_SOURCES);
    expect(snapshot.text("pom.xml")).toBe("<project/>");
    expect(snapshot.problems).toEqual([
      { path: "", message: "searching for files with controllers and HTTP clients failed: git grep: przekroczony limit czasu" },
    ]);
  });

  test("stałe, które sklejają się same ze sobą albo podwajają, nie zajmują pamięci", () => {
    const constants = Array.from({ length: 30 }, (_, i) => `static final String C${i} = C${i + 1} + C${i + 1};`).join("\n");
    const java = `@RestController class Api {\n${constants}\nstatic final String C30 = "${"x".repeat(1000)}";\nstatic final String L = L + "/a";\n@GetMapping(C0) void a() {}\n@GetMapping(L) void b() {}\n}`;
    const started = performance.now();
    const card = extractCard(snapshotOf({ "src/main/java/a/Api.java": java }), parsers);
    expect(performance.now() - started).toBeLessThan(1000);
    for (const p of card.provides) if (p.kind === "endpoint") expect(p.path.length).toBeLessThanOrEqual(4096);
  });

  test(`\${...} z application.yml, które mnożą się przy rozwiązywaniu albo tworzą cykl, nie blokują daemona`, () => {
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

  test("typ odpowiedzi i pola DTO z dziesiątkami tysięcy argumentów dają przycięty zapis typu szybko", () => {
    const args = "A,".repeat(40_000);
    const java = `@RestController class Api { @GetMapping("/a") M<${args}A> a() { return null; } }\nclass M { N<${args}D> f; }\nclass D { int x; }`;
    const started = performance.now();
    const card = extractCard(snapshotOf({ "src/main/java/a/Api.java": java }), parsers);
    expect(performance.now() - started).toBeLessThan(2000);
    const endpoint = card.provides.find((p) => p.kind === "endpoint");
    expect(endpoint?.kind === "endpoint" ? endpoint.response?.length : 0).toBe(257);
    expect(card.dtos.map((d) => (d.kind === "enum" ? d.name : `${d.name}: ${d.fields[0]?.type.length}`))).toEqual(["M: 257", "D: 3"]);
  });

  test("graf z tysiącami endpointów i klientów bez adresu liczy się szybko", () => {
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
