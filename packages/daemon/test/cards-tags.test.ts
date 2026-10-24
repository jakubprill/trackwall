import { describe, expect, test } from "bun:test";
import type { RepoCard } from "@trackwall/protocol";
import { extractCard } from "../src/modules/cards/extract-card.ts";
import { globMatcher } from "../src/modules/cards/glob.ts";
import { repoTags } from "../src/modules/cards/tags.ts";
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

describe("tagi repo", () => {
  const tagsOf = (card: RepoCard, id: string, remote: string | null = null, rules = {}) =>
    repoTags(card, { id, remote }, rules).map((t) => `${t.name}: ${t.reason}`);

  test("BFF w Spring: java, backend i bff (z nazwy), każdy z powodem", () => {
    const card = extractCard(snapshotOf({ "pom.xml": SPRING_BFF_POM }));
    expect(tagsOf(card, "orders-bff")).toEqual([
      "backend: spring-boot in pom.xml:2",
      "bff: “bff” in the name orders-bff",
      "java: build file pom.xml",
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
      "frontend: react in apps/web/package.json:1",
      "monorepo: package.json lists 2 modules or packages",
      "typescript: typescript dependency in package.json:1",
    ]);
  });

  test("biblioteka: udostępnia paczkę bez frameworka aplikacji i wdrożenia; osobne buildy w podkatalogach to monorepo", () => {
    const lib = extractCard(
      snapshotOf({ "pom.xml": "<project><groupId>com.example</groupId><artifactId>common-model</artifactId></project>" }),
    );
    expect(tagsOf(lib, "common-model")).toEqual([
      "java: build file pom.xml",
      "library: provides com.example:common-model and has no app framework or deployment files",
    ]);

    const split = extractCard(
      snapshotOf({ "backend/pom.xml": SPRING_BFF_POM, "frontend/package.json": JSON.stringify({ name: "front", private: true }) }),
    );
    expect(tagsOf(split, "app")).toContain("monorepo: separate builds in directories backend, frontend");
  });

  test("bff tylko jako osobne słowo, nie fragment innego", () => {
    const card = extractCard(snapshotOf({}));
    expect(tagsOf(card, "bffcore")).toEqual([]);
    expect(tagsOf(card, "web_bff")).toEqual(["bff: “bff” in the name web_bff"]);
  });

  test("reguły repoTags z workspace.yaml pasują do identyfikatora albo adresu repo zdalnego, bez wielkości liter", () => {
    const rules = { "core-api": ["*-core"], payments: ["gitlab.example.com/Payments/**"] };
    const card = extractCard(snapshotOf({}));
    expect(tagsOf(card, "billing-core", "gitlab.example.com/payments/billing", rules)).toEqual([
      "core-api: repoTags rule in workspace.yaml: *-core",
      "payments: repoTags rule in workspace.yaml: gitlab.example.com/Payments/**",
    ]);
    expect(repoTags(null, { id: "web", remote: null }, rules)).toEqual([]);
  });
});

describe("glob", () => {
  test("* bez ukośnika, ** z ukośnikami albo niczym, ? jeden znak", () => {
    expect(globMatcher("packages/*")("packages/ui")).toBe(true);
    expect(globMatcher("packages/*")("packages/ui/x")).toBe(false);
    expect(globMatcher("packages/**")("packages/ui/x")).toBe(true);
    expect(globMatcher("a/**/b")("a/b")).toBe(true);
    expect(globMatcher("a/**/b")("a/x/y/b")).toBe(true);
    expect(globMatcher("a/**/b")("a/xb")).toBe(false);
    expect(globMatcher("a.b")("axb")).toBe(false);
    expect(globMatcher("v?")("v1")).toBe(true);
    expect(globMatcher("*-Core", { ignoreCase: true })("billing-core")).toBe(true);
  });
});
