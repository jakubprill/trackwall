import { describe, expect, test } from "bun:test";
import { extractCard } from "../src/modules/cards/extract-card.ts";
import { globMatcher } from "../src/modules/cards/glob.ts";
import { extractGradle } from "../src/modules/cards/gradle.ts";
import { extractMaven } from "../src/modules/cards/maven.ts";
import { extractNpm } from "../src/modules/cards/npm.ts";
import { readSnapshot } from "../src/modules/cards/read-snapshot.ts";
import { extractTools } from "../src/modules/cards/tools.ts";
import { snapshotOf } from "./support/snapshot.ts";

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
    extractCard(snapshotOf({}, [`${"k8s/".repeat(8000)}x.yaml`, `${"k8s/".repeat(8000)}y.yaml`]));
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
    };
    const snapshot = await readSnapshot(vcs, "/repo", "a".repeat(40), (path) => path.endsWith("pom.xml"));
    expect(snapshot.text("pom.xml")).toBe("<project/>");
    expect(snapshot.problems).toEqual([{ path: "api/pom.xml", message: "pliku nie przeczytano w limicie 33554432 B odczytu commita" }]);
  });
});
