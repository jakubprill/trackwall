import { describe, expect, test } from "bun:test";
import type { SearchCodeResult, SearchCommitsResult } from "@trackwall/protocol";
import { codeSearchText } from "../src/mcp/code-search-text.ts";
import { commitSearchText } from "../src/mcp/commit-search-text.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("search_code text", () => {
  test("groups matches by repo and file, shows each line once and separates groups that are not next to each other", () => {
    const result: SearchCodeResult = {
      matches: [
        {
          repo: "orders",
          path: "src/Orders.java",
          line: 3,
          column: 3,
          text: "  void place() {}",
          before: [{ line: 2, text: "  // TODO" }],
          after: [{ line: 4, text: "  void cancel() {}" }],
        },
        {
          repo: "orders",
          path: "src/Orders.java",
          line: 4,
          column: 3,
          text: "  void cancel() {}",
          before: [{ line: 3, text: "  void place() {}" }],
          after: [{ line: 5, text: "}" }],
        },
        { repo: "orders", path: "src/Orders.java", line: 9, column: 3, text: "  void refund() {}", before: [], after: [] },
        { repo: "web", path: "src/app.ts", line: 1, column: 1, text: "void 0;", before: [], after: [] },
      ],
      files: [],
      truncated: false,
      searched: [
        { repo: "orders", commit: A, truncated: false },
        { repo: "web", commit: B, truncated: false },
        { repo: "payments", commit: B, truncated: false },
      ],
      failed: [],
      skipped: [],
    };

    expect(codeSearchText(result)).toBe(
      [
        "## orders @aaaaaaaaaaaa",
        "### src/Orders.java",
        "2-  // TODO",
        "3:  void place() {}",
        "4:  void cancel() {}",
        "5-}",
        "--",
        "9:  void refund() {}",
        "## web @bbbbbbbbbbbb",
        "### src/app.ts",
        "1:void 0;",
        "Searched 3 repos; 2 with matches.",
      ].join("\n"),
    );
  });

  test("files output lists each file with its count, and the closing lines name failed, skipped and truncated repos", () => {
    const result: SearchCodeResult = {
      matches: [],
      files: [
        { repo: "orders", path: "src/Orders.java", matches: 3 },
        { repo: "orders", path: "README.md", matches: 1 },
      ],
      truncated: true,
      searched: [
        { repo: "orders", commit: A, truncated: true },
        { repo: "web", commit: B, truncated: false },
      ],
      failed: [{ repo: "legacy", message: "git grep: timed out" }],
      skipped: ["payments", "shipping"],
    };

    expect(codeSearchText(result)).toBe(
      [
        "## orders @aaaaaaaaaaaa",
        "src/Orders.java (3)",
        "README.md (1)",
        "Searched 2 repos; 1 with matches.",
        "Failed in legacy: git grep: timed out",
        "Not searched (the limit was reached or time ran out): payments, shipping",
        "Truncated: more matches may exist (in orders); narrow the query.",
      ].join("\n"),
    );
  });

  test("no matches says so before the closing line", () => {
    const result: SearchCodeResult = {
      matches: [],
      files: [],
      truncated: false,
      searched: [{ repo: "orders", commit: A, truncated: false }],
      failed: [],
      skipped: [],
    };

    expect(codeSearchText(result)).toBe("No matches.\nSearched 1 repo; 0 with matches.");
  });
});

describe("search_commits text", () => {
  test("a line per commit with its repo, short hash, day, author and subject, then its files indented", () => {
    const result: SearchCommitsResult = {
      commits: [
        {
          repo: "orders",
          hash: A,
          author: "Ada Lovelace",
          date: "2026-10-30T18:02:11+01:00",
          subject: "Rename price to amount",
          files: ["src/Order.java", "src/OrderDto.java"],
          filesTruncated: true,
        },
        {
          repo: "web",
          hash: B,
          author: "Alan Turing",
          date: "2026-10-29T09:00:00Z",
          subject: "Merge branch 'main'",
          files: [],
          filesTruncated: false,
        },
      ],
      truncated: false,
      searched: [
        { repo: "orders", commit: A, truncated: false },
        { repo: "web", commit: B, truncated: false },
      ],
      failed: [],
      skipped: [],
    };

    expect(commitSearchText(result)).toBe(
      [
        "orders aaaaaaaaaaaa 2026-10-30 Ada Lovelace: Rename price to amount",
        "  src/Order.java",
        "  src/OrderDto.java",
        "  (more files)",
        "web bbbbbbbbbbbb 2026-10-29 Alan Turing: Merge branch 'main'",
        "Searched 2 repos; 2 with commits.",
      ].join("\n"),
    );
  });

  test("no commits says so before the closing line", () => {
    const result: SearchCommitsResult = { commits: [], truncated: false, searched: [], failed: [], skipped: [] };

    expect(commitSearchText(result)).toBe("No commits found.\nSearched 0 repos; 0 with commits.");
  });
});
