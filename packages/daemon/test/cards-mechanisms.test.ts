import { describe, expect, test } from "bun:test";
import { extractCard } from "../src/modules/cards/extract-card.ts";
import { loadSyntaxParsers } from "../src/modules/cards/syntax-tree.ts";
import { snapshotOf } from "./support/snapshot.ts";

const parsers = await loadSyntaxParsers();

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

describe("spis mechanizmów", () => {
  test("mechanizmy z zależności i nazw plików, z dowodami", () => {
    const card = extractCard(
      snapshotOf({ "pom.xml": SPRING_BFF_POM }, ["Dockerfile", "deploy/k8s/deployment.yaml", "chart/Chart.yaml", "api/openapi.yaml"]),
      parsers,
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
});
