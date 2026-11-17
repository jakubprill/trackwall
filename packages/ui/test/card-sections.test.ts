import { describe, expect, test } from "bun:test";
import type { RepoCard } from "@trackwall/protocol";
import { cardFacts, cardSections } from "../src/lib/card-sections.ts";

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

describe("the sections of the Card tab", () => {
  test("a repo with nothing recognized has no section, and every kind of fact is named as missing", () => {
    const { found, missing } = cardSections(cardFacts(EMPTY, []), true);
    expect(found).toEqual([]);
    expect(missing).toEqual(["tags", "mechanisms", "tools", "apps", "endpoints", "dtos", "clients", "provides", "uses", "build-files"]);
  });

  test("each kind of fact the card holds is a section with its count, in the card's order", () => {
    const card = {
      ...EMPTY,
      buildFiles: [{ path: "pom.xml", tool: "maven", name: "orders" }],
      mechanisms: [{ id: "spring-boot", evidence: [{ ...at("pom.xml"), detail: "spring-boot-starter-web" }] }],
      provides: [
        { kind: "app", name: "orders-api", port: 8081, module: null, evidence: at("application.yml") },
        { kind: "endpoint", method: "GET", path: "/orders" },
        { kind: "endpoint", method: "POST", path: "/orders" },
      ],
      consumes: [
        { kind: "http", name: "payments" },
        { kind: "package", ecosystem: "maven", name: "org.postgresql:postgresql" },
      ],
    } as unknown as RepoCard;
    const facts = cardFacts(card, [{ name: "java", reason: "pom.xml" }]);
    expect(facts.endpoints.map((e) => e.path)).toEqual(["/orders", "/orders"]);
    expect(facts.uses.map((p) => p.name)).toEqual(["org.postgresql:postgresql"]);
    expect(cardSections(facts, true)).toEqual({
      found: ["tags", "mechanisms", "apps", "endpoints", "clients", "uses", "build-files"],
      missing: ["tools", "dtos", "provides"],
    });
  });

  test("a repo without a commit has no card: only its tags make a section, and nothing of a card is named as missing", () => {
    expect(cardSections(cardFacts(null, [{ name: "no-mise", reason: "no mise config in the repo root" }]), false)).toEqual({
      found: ["tags"],
      missing: [],
    });
    expect(cardSections(cardFacts(null, []), false)).toEqual({ found: [], missing: ["tags"] });
  });
});
