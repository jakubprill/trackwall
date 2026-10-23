import { describe, expect, test } from "bun:test";
import { extractGradle } from "../src/modules/cards/gradle.ts";
import { extractMaven } from "../src/modules/cards/maven.ts";
import { extractNpm } from "../src/modules/cards/npm.ts";
import { readSnapshot } from "../src/modules/cards/read-snapshot.ts";
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

  test("dziesiątki tysięcy package.json w drzewie (zacommitowane node_modules) nie blokują daemona", () => {
    const paths = Array.from({ length: 20_000 }, (_, i) => `node_modules/p${i}/package.json`);
    const started = performance.now();
    const out = extractNpm(snapshotOf({ "web/package.json": JSON.stringify({ name: "web", private: true }) }, paths));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(out.buildFiles.map((f) => f.path)).toEqual(["web/package.json"]);
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
