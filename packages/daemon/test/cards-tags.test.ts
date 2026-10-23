import { describe, expect, test } from "bun:test";
import type { RepoCard } from "@trackwall/protocol";
import { extractCard } from "../src/modules/cards/extract-card.ts";
import { globToRegExp } from "../src/modules/cards/glob.ts";
import { repoTags } from "../src/modules/cards/tags.ts";
import { extractTools } from "../src/modules/cards/tools.ts";
import { snapshotOf } from "./support/snapshot.ts";

const SPRING_BFF_POM = `<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.0</version>
  </parent>
  <groupId>com.example</groupId>
  <artifactId>orders-bff</artifactId>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-webflux</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.cloud</groupId>
      <artifactId>spring-cloud-starter-netflix-eureka-client</artifactId>
    </dependency>
  </dependencies>
</project>
`;

describe("karta repo", () => {
  test("spis mechanizmów z zależności i nazw plików, z dowodami", () => {
    const card = extractCard(
      snapshotOf({ "pom.xml": SPRING_BFF_POM }, ["Dockerfile", "deploy/k8s/deployment.yaml", "chart/Chart.yaml", "api/openapi.yaml"]),
    );
    expect(card.mechanisms.map((m) => [m.id, m.evidence.map((e) => `${e.path}:${e.line ?? "-"} ${e.detail}`)])).toEqual([
      [
        "spring-boot",
        [
          "pom.xml:2 org.springframework.boot:spring-boot-starter-parent",
          "pom.xml:10 org.springframework.boot:spring-boot-starter-webflux",
        ],
      ],
      ["webclient", ["pom.xml:10 org.springframework.boot:spring-boot-starter-webflux"]],
      ["openapi", ["api/openapi.yaml:- openapi.yaml"]],
      ["eureka", ["pom.xml:14 org.springframework.cloud:spring-cloud-starter-netflix-eureka-client"]],
      ["kubernetes", ["deploy/k8s/deployment.yaml:- deployment.yaml"]],
      ["helm", ["chart/Chart.yaml:- Chart.yaml"]],
      ["docker", ["Dockerfile:- Dockerfile"]],
    ]);
  });

  test("narzędzia z mise i .tool-versions w korzeniu oraz podpowiedzi z katalogów buildów i wrappera", () => {
    const { tools, problems } = extractTools(
      snapshotOf({
        "mise.toml": '[tools]\njava = "temurin-21"\nnode = ["22", "20"]\n"npm:prettier" = { version = "3.3.0" }\n',
        ".tool-versions": "# komentarz\nmaven 3.9.6\n",
        "web/.nvmrc": "v22.12.0\n",
        ".mvn/wrapper/maven-wrapper.properties": "distributionUrl=https://repo.example.com/apache-maven-3.9.9-bin.zip\n",
        "inny/.nvmrc": "18\n",
      }),
      ["web"],
    );
    expect(problems).toEqual([]);
    expect(tools.map((t) => [t.tool, t.version, t.source, `${t.evidence.path}:${t.evidence.line}`])).toEqual([
      ["java", "temurin-21", "mise", "mise.toml:2"],
      ["node", "22", "mise", "mise.toml:3"],
      ["node", "20", "mise", "mise.toml:3"],
      ["npm:prettier", "3.3.0", "mise", "mise.toml:4"],
      ["maven", "3.9.6", "mise", ".tool-versions:2"],
      ["maven", "3.9.9", "hint", ".mvn/wrapper/maven-wrapper.properties:1"],
      ["node", "22.12.0", "hint", "web/.nvmrc:1"],
    ]);
  });

  test("zły mise.toml to problem karty", () => {
    expect(extractTools(snapshotOf({ "mise.toml": "[tools\n" }), []).problems.map((p) => p.path)).toEqual(["mise.toml"]);
  });
});

describe("tagi repo", () => {
  const tagsOf = (card: RepoCard, id: string, remote: string | null = null, rules = {}) =>
    repoTags(card, { id, remote }, rules).map((t) => `${t.name}: ${t.reason}`);

  test("BFF w Spring: java, backend i bff (z nazwy), każdy z powodem", () => {
    const card = extractCard(snapshotOf({ "pom.xml": SPRING_BFF_POM }));
    expect(tagsOf(card, "orders-bff")).toEqual([
      "backend: spring-boot w pom.xml:2",
      "bff: „bff” w nazwie orders-bff",
      "java: plik buildu pom.xml",
    ]);
  });

  test("frontend w TypeScript i monorepo z paczkami workspace", () => {
    const card = extractCard(
      snapshotOf({
        "package.json": JSON.stringify({ name: "shop", private: true, workspaces: ["apps/*"], devDependencies: { typescript: "5" } }),
        "apps/web/package.json": JSON.stringify({ name: "web", private: true, dependencies: { react: "19" } }),
        "apps/admin/package.json": JSON.stringify({ name: "admin", private: true, dependencies: { vue: "3" } }),
      }),
    );
    expect(tagsOf(card, "shop")).toEqual([
      "frontend: react w apps/web/package.json:1",
      "monorepo: package.json wymienia 2 moduły lub paczki",
      "typescript: zależność typescript w package.json:1",
    ]);
  });

  test("biblioteka: udostępnia paczkę bez frameworka aplikacji i wdrożenia; osobne buildy w podkatalogach to monorepo", () => {
    const lib = extractCard(
      snapshotOf({ "pom.xml": "<project><groupId>com.example</groupId><artifactId>common-model</artifactId></project>" }),
    );
    expect(tagsOf(lib, "common-model")).toEqual([
      "java: plik buildu pom.xml",
      "library: udostępnia com.example:common-model i nie ma frameworka aplikacji ani plików wdrożenia",
    ]);

    const split = extractCard(
      snapshotOf({ "backend/pom.xml": SPRING_BFF_POM, "frontend/package.json": JSON.stringify({ name: "front", private: true }) }),
    );
    expect(tagsOf(split, "app")).toContain("monorepo: osobne buildy w katalogach backend, frontend");
  });

  test("bff tylko jako osobne słowo, nie fragment innego", () => {
    const card = extractCard(snapshotOf({}));
    expect(tagsOf(card, "bffcore")).toEqual([]);
    expect(tagsOf(card, "web_bff")).toEqual(["bff: „bff” w nazwie web_bff"]);
  });

  test("reguły repoTags z workspace.yaml pasują do identyfikatora albo adresu repo zdalnego, bez wielkości liter", () => {
    const rules = { "core-api": ["*-core"], payments: ["gitlab.example.com/Payments/**"] };
    const card = extractCard(snapshotOf({}));
    expect(tagsOf(card, "billing-core", "gitlab.example.com/payments/billing", rules)).toEqual([
      "core-api: reguła repoTags w workspace.yaml: *-core",
      "payments: reguła repoTags w workspace.yaml: gitlab.example.com/Payments/**",
    ]);
    expect(repoTags(null, { id: "web", remote: null }, rules)).toEqual([]);
  });
});

describe("glob", () => {
  test("* bez ukośnika, ** z ukośnikami albo niczym", () => {
    expect(globToRegExp("packages/*").test("packages/ui")).toBe(true);
    expect(globToRegExp("packages/*").test("packages/ui/x")).toBe(false);
    expect(globToRegExp("packages/**").test("packages/ui/x")).toBe(true);
    expect(globToRegExp("a/**/b").test("a/b")).toBe(true);
    expect(globToRegExp("a/**/b").test("a/x/y/b")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});
