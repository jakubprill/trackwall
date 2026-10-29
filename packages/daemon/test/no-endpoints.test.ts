import { describe, expect, test } from "bun:test";
import type { ConsumedPackage, ProvidedEndpoint } from "@trackwall/protocol";
import { extractCard } from "../src/modules/cards/extract-card.ts";
import { noEndpointsProblems } from "../src/modules/cards/no-endpoints.ts";
import { loadSyntaxParsers } from "../src/modules/cards/syntax-tree.ts";
import { NO_REACH, snapshotOf } from "./support/snapshot.ts";
import { fixtureFiles } from "./support/spring-fixtures.ts";

function uses(name: string, scope = "compile"): ConsumedPackage {
  return { kind: "package", ecosystem: "maven", name, version: null, scope, evidence: { path: "app/pom.xml", line: 14 } };
}

const ENDPOINT: ProvidedEndpoint = {
  kind: "endpoint",
  source: "code",
  method: "GET",
  path: "/api/orders",
  app: null,
  handler: "OrdersController.list",
  request: null,
  response: null,
  reaches: null,
  operation: null,
  evidence: { path: "src/main/java/OrdersController.java", line: 12 },
};

describe("the no-endpoints card problem (ADR-116)", () => {
  test("a Spring web app with no endpoint found gets the problem at the build file with the web dependency", () => {
    expect(noEndpointsProblems([], [uses("org.springframework.boot:spring-boot-starter-web")])).toEqual([
      {
        code: "no-endpoints",
        path: "app/pom.xml",
        message:
          "uses org.springframework.boot:spring-boot-starter-web, but the card found no endpoint: controllers from a library, JAX-RS or RouterFunction are not read",
      },
    ]);
    expect(noEndpointsProblems([], [uses("org.springframework:spring-webmvc")]).map((p) => p.code)).toEqual(["no-endpoints"]);
  });

  test("an app with an endpoint, an app without a web server and a web server only in tests get no problem", () => {
    expect(noEndpointsProblems([ENDPOINT], [uses("org.springframework.boot:spring-boot-starter-web")])).toEqual([]);
    expect(noEndpointsProblems([], [uses("org.springframework.boot:spring-boot-starter")])).toEqual([]);
    expect(noEndpointsProblems([], [uses("org.springframework.boot:spring-boot-starter-web", "testImplementation")])).toEqual([]);
  });

  test("a gateway, a Config Server, a Eureka server and a Spring Boot Admin server serve the framework's endpoints, not a gap", () => {
    for (const server of [
      "org.springframework.cloud:spring-cloud-starter-gateway",
      "org.springframework.cloud:spring-cloud-starter-gateway-server-webmvc",
      "org.springframework.cloud:spring-cloud-config-server",
      "org.springframework.cloud:spring-cloud-starter-netflix-eureka-server",
      "de.codecentric:spring-boot-admin-starter-server",
    ])
      expect(noEndpointsProblems([], [uses("org.springframework.boot:spring-boot-starter-webflux"), uses(server)])).toEqual([]);
  });

  test("on the card: the BFF fixture uses WebFlux without a controller, the orders API has its controller", async () => {
    const parsers = await loadSyntaxParsers();
    const problems = (repo: string) => extractCard(snapshotOf(fixtureFiles(repo)), parsers, NO_REACH).problems;
    expect(
      problems("orders-bff")
        .filter((p) => p.code === "no-endpoints")
        .map((p) => p.path),
    ).toEqual(["pom.xml"]);
    expect(problems("orders-api").filter((p) => p.code === "no-endpoints")).toEqual([]);
  });
});
