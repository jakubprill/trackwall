import { describe, expect, test } from "bun:test";
import type { RepoCard } from "@trackwall/protocol";
import { cardGlance } from "../src/lib/card-glance.ts";

const at = (path: string) => ({ path, line: 1 });

const EMPTY: RepoCard = {
  commit: "a".repeat(40),
  buildFiles: [],
  provides: [],
  consumes: [],
  dtos: [],
  reachTraced: true,
  tools: [],
  mise: { configFiles: [], tasks: [], complete: true },
  mechanisms: [],
  problems: [],
};

describe("the card at a glance", () => {
  test("names mechanisms, one version per tool with the mise one first, apps with ports, and counts the API and dependencies", () => {
    const card = {
      ...EMPTY,
      mechanisms: [{ id: "spring-boot", evidence: [{ ...at("pom.xml"), detail: "spring-boot-starter-web" }] }],
      tools: [
        { tool: "java", version: "17", source: "hint", evidence: at("pom.xml") },
        { tool: "java", version: "21", source: "mise", evidence: at("mise.toml") },
        { tool: "maven", version: "3.9.9", source: "mise", evidence: at("mise.toml") },
      ],
      provides: [
        { kind: "app", name: "orders-api", port: 8081, module: null, evidence: at("src/main/resources/application.yml") },
        { kind: "endpoint", method: "GET", path: "/orders" },
        { kind: "endpoint", method: "POST", path: "/orders" },
        { kind: "package", ecosystem: "maven", name: "com.example:orders-client", version: "1.0.0", evidence: at("pom.xml") },
      ],
      consumes: [
        { kind: "http", name: "payments" },
        { kind: "package", ecosystem: "maven", name: "org.springframework.boot:spring-boot-starter-web" },
        { kind: "package", ecosystem: "maven", name: "org.postgresql:postgresql" },
      ],
      dtos: [{ name: "OrderDto" }],
    } as unknown as RepoCard;

    expect(cardGlance(card)).toEqual({
      stack: ["Spring Boot", "java 21", "maven 3.9.9"],
      apps: ["orders-api :8081"],
      api: "2 endpoints · 1 DTO",
      dependencies: "1 HTTP client · provides 1 package · uses 2 packages",
    });
  });

  test("a repo the card recognizes nothing in has empty lists and zero counts", () => {
    expect(cardGlance(EMPTY)).toEqual({
      stack: [],
      apps: [],
      api: "0 endpoints · 0 DTOs",
      dependencies: "0 HTTP clients · provides 0 packages · uses 0 packages",
    });
  });
});
