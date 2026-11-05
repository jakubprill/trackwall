import { describe, expect, test } from "bun:test";
import type { CodeMatch, ImpactedRepo, RepoGraph, SearchCodeResult, TypeChange } from "@trackwall/protocol";
import { importPatterns, type LibrarySearch, packageConsumers, withLibraryUsers, withUsers } from "../src/modules/graph/library-users.ts";

const money: TypeChange = {
  change: "changed",
  package: "com.example.money",
  type: "com.example.money.Money.Currency",
  declaration: false,
  members: ["PLN"],
  evidence: { path: "money/src/main/java/com/example/money/Money.java", line: 13 },
};
const rate: TypeChange = { ...money, change: "removed", type: "com.example.money.Rate", members: [] };

const line = (repo: string, path: string, n: number, text: string): CodeMatch => ({
  repo,
  path,
  line: n,
  column: 1,
  text,
  before: [],
  after: [],
});

function searchGiving(matches: CodeMatch[], truncated = false): { search: LibrarySearch; asked: unknown[] } {
  const asked: unknown[] = [];
  const search: LibrarySearch = async (query, repos) => {
    asked.push({ pattern: query.pattern, paths: query.paths, repos });
    const result: SearchCodeResult = { matches, files: [], truncated, searched: [], failed: [], skipped: [] };
    return result;
  };
  return { search, asked };
}

describe("the users of changed library types (ADR-205)", () => {
  test("the consumers are the repos with a depends-on edge to the task's repo", () => {
    const edge = (from: string, to: string, kind: "depends-on" | "calls") => ({
      from,
      to,
      kind,
      source: "package" as const,
      key: "com.example:money",
      confidence: "certain" as const,
      evidence: [{ repo: from, path: "pom.xml", line: 12, detail: "dependency" }],
    });
    const graph = {
      nodes: [],
      edges: [
        edge("billing", "money", "depends-on"),
        edge("shop", "money", "depends-on"),
        edge("shop", "money", "calls"),
        edge("money", "money", "depends-on"),
      ],
      problems: [],
    } as unknown as RepoGraph;

    expect(packageConsumers(graph, "money")).toEqual(["billing", "shop"]);
  });

  test("a consumer imports a type by its own name, its outer type, a static member or its whole package; another type of the package does not count", async () => {
    const { search, asked } = searchGiving([
      line("billing", "src/main/java/Invoice.java", 3, "import com.example.money.Money;"),
      line("shop", "src/main/java/Cart.java", 4, "import static com.example.money.Money.Currency.PLN;"),
      line("shop", "src/main/java/Totals.java", 2, "import com.example.money.Money.Currency;"),
      line("reports", "src/main/java/Sum.java", 5, "import com.example.money.*;"),
      line("audit", "src/main/java/Log.java", 2, "import com.example.money.MoneyFormat;"),
      line("audit", "src/main/java/Old.java", 2, "import com.example.money.sub.Rate;"),
    ]);

    const { types, truncated } = await withUsers([money, rate], ["audit", "billing", "reports", "shop"], search);

    expect(asked).toEqual([
      {
        pattern:
          "^[[:space:]]*import[[:space:]]+(static[[:space:]]+)?(com\\.example\\.money\\.Money|com\\.example\\.money\\.\\*|com\\.example\\.money\\.Rate)([.;]|[[:space:]])",
        paths: ["*.java"],
        repos: ["audit", "billing", "reports", "shop"],
      },
    ]);
    expect(types.map((t) => [t.type, t.users])).toEqual([
      [
        "com.example.money.Money.Currency",
        [
          { repo: "billing", evidence: { path: "src/main/java/Invoice.java", line: 3 } },
          { repo: "shop", evidence: { path: "src/main/java/Cart.java", line: 4 } },
          { repo: "reports", evidence: { path: "src/main/java/Sum.java", line: 5 } },
        ],
      ],
      ["com.example.money.Rate", [{ repo: "reports", evidence: { path: "src/main/java/Sum.java", line: 5 } }]],
    ]);
    expect(truncated).toBe(false);
  });

  test("without consumers nothing is searched, and a cut search or a consumer git could not search marks the result as cut", async () => {
    const none = searchGiving([]);
    expect((await withUsers([money], [], none.search)).types[0]?.users).toEqual([]);
    expect(none.asked).toEqual([]);

    expect((await withUsers([money], ["shop"], searchGiving([], true).search)).truncated).toBe(true);
    const failing: LibrarySearch = async () => ({
      matches: [],
      files: [],
      truncated: false,
      searched: [],
      failed: [{ repo: "shop", message: "fatal: bad object HEAD" }],
      skipped: [],
    });
    expect(await withUsers([money], ["shop"], failing)).toMatchObject({ truncated: true, failed: true });
  });

  test("a name that is not Java identifiers and dots stays out of the pattern, a $ in one is escaped, and the default package is skipped", () => {
    const types = [
      { package: "com.example", type: "com.example.(a|.*)" },
      { package: "com.example", type: "com.example.Gen$Money" },
      { package: "", type: "Loose" },
    ];
    expect(importPatterns(types)).toEqual([
      "^[[:space:]]*import[[:space:]]+(static[[:space:]]+)?(com\\.example\\.Gen\\$Money|com\\.example\\.\\*)([.;]|[[:space:]])",
    ]);
  });

  test("many packages are split into patterns that code search takes", () => {
    const packages = Array.from({ length: 30 }, (_, i) => `com.example.platform.module${i}.api`);
    const patterns = importPatterns(packages.map((p) => ({ package: p, type: `${p}.Client` })));

    expect(patterns.length).toBeGreaterThan(1);
    for (const p of patterns) expect(p.length).toBeLessThanOrEqual(500);
    expect(patterns.join("|").match(/module\d+\\.api\\.Client/g)).toHaveLength(30);
  });

  test("a user the endpoints do not reach joins ring 1, surely reached and carrying nothing on; a reached one keeps its ring", () => {
    const shop: ImpactedRepo = { repo: "shop", ring: 2, uses: ["orders-bff"], calls: [], through: null, sure: false };
    const bff: ImpactedRepo = { repo: "orders-bff", ring: 1, uses: ["money"], calls: [], through: null, sure: true };
    const users = (...repos: string[]) => repos.map((repo) => ({ repo, evidence: { path: "A.java", line: 1 } }));

    expect(withLibraryUsers([bff, shop], "money", [{ ...money, users: users("shop", "billing", "orders-bff") }])).toEqual([
      { repo: "billing", ring: 1, uses: ["money"], calls: [], through: [], sure: true },
      bff,
      shop,
    ]);
  });
});
