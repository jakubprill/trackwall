import { type Language, Node, Parser } from "web-tree-sitter";
import { type JvmGrammars, loadJvmGrammars } from "../../platform/tree-sitter.ts";

/**
 * Java and Kotlin syntax trees from tree-sitter (§4.6, ADR-37) for the extractors for which tokens are not enough
 * (`java-tokens.ts`): parameter and field types, records, `data class`. The parser runs in WASM in the daemon process,
 * without compiling the repo and without a native addon. Syntactically invalid code gives a tree with `ERROR` nodes, not
 * an exception.
 */
export type JvmLanguage = "java" | "kotlin";

/**
 * The longest parse of one file. The parser runs synchronously on the daemon's thread, and the Kotlin grammar grows
 * faster than linearly in time on malicious input (a 96 KB file takes several seconds), so a file from the repo (§8)
 * must not block the API for longer than this.
 */
export const PARSE_TIME_LIMIT_MS = 1000;

/**
 * The result of reading a tree. Without a tree: `timeout` when parsing the file exceeded `PARSE_TIME_LIMIT_MS`,
 * `over-budget` when the card used up the total parse time (`withParseBudget`), `unavailable` when the parsers failed to load.
 */
type SyntaxRead<T> =
  | { kind: "parsed"; value: T }
  | { kind: "timeout" }
  | { kind: "over-budget"; budgetMs: number }
  | { kind: "unavailable"; reason: string };

export interface SyntaxParsers {
  /**
   * Gives `read` the root of the file's tree and returns its result. The tree lives in WASM memory, which GC does not
   * clean, and is freed right after `read`, so `read` is synchronous and returns values read from the nodes, not nodes.
   */
  read<T>(language: JvmLanguage, text: string, read: (root: Node) => T): SyntaxRead<T>;
}

/**
 * The parsers of one card: the reads share the total parse time, and `complete` says whether every file got a tree. A
 * card that lacked something because of time or a missing parser depends on the moment it was computed, not only on the commit.
 */
export interface CardParsers extends SyntaxParsers {
  readonly complete: boolean;
}

/** The total parse time of one card (§8): a per-file limit is not enough when there are many malicious files. */
export const CARD_PARSE_BUDGET_MS = 10_000;

/**
 * Parsers on the grammars `loadJvmGrammars` loads once per process (it also retries after an error): `Parser` objects
 * live in WASM memory, which GC does not clean, and the reads are synchronous, so all cards share one pair.
 */
const parsersOf = new WeakMap<JvmGrammars, SyntaxParsers>();

/** Parsers for both languages; loading the grammars is the only asynchronous part, so the extractors stay synchronous. */
export async function loadSyntaxParsers(): Promise<SyntaxParsers> {
  const grammars = await loadJvmGrammars();
  const parsers = parsersOf.get(grammars) ?? syntaxParsers(grammars);
  parsersOf.set(grammars, parsers);
  return parsers;
}

/**
 * A card's parsers with a total time budget: a read after `budgetMs` is used up does not parse and gives `over-budget`.
 * The check comes before the read, so a card can exceed the budget by the time of the last file (parsing at most
 * `PARSE_TIME_LIMIT_MS` and reading the tree, linear in its size).
 */
export function withParseBudget(parsers: SyntaxParsers, budgetMs: number): CardParsers {
  let spentMs = 0;
  let complete = true;
  return {
    get complete() {
      return complete;
    },
    read(language, text, read) {
      if (spentMs >= budgetMs) {
        complete = false;
        return { kind: "over-budget", budgetMs };
      }
      const started = performance.now();
      const result = parsers.read(language, text, read);
      spentMs += performance.now() - started;
      if (result.kind !== "parsed") complete = false;
      return result;
    },
  };
}

/**
 * Parsers when the grammars failed to load: every read gives `unavailable` with the reason. A card without Java and
 * Kotlin files reads nothing, so it stays complete in `withParseBudget`.
 */
export function unavailableParsers(reason: string): SyntaxParsers {
  return { read: () => ({ kind: "unavailable", reason }) };
}

function syntaxParsers(grammars: JvmGrammars): SyntaxParsers {
  const parsers = { java: parserFor(grammars.java), kotlin: parserFor(grammars.kotlin) };
  return {
    read(language, text, read) {
      const parser = parsers[language];
      const deadline = performance.now() + PARSE_TIME_LIMIT_MS;
      const tree = parser.parse(text, null, { progressCallback: () => performance.now() > deadline });
      if (!tree) {
        // Without `reset` the next `parse` would resume the interrupted file.
        parser.reset();
        return { kind: "timeout" };
      }
      try {
        return { kind: "parsed", value: checkedResult(read(tree.rootNode)) };
      } finally {
        tree.delete();
      }
    },
  };
}

function parserFor(language: Language): Parser {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

/**
 * A node or a promise would reach into the tree after `delete`, and WASM would then return someone else's data instead
 * of an error. Only the result itself is checked: a node in an array or in an object field (`root.children`) gets through,
 * so review guards that.
 */
function checkedResult<T>(result: T): T {
  if (result instanceof Node || result instanceof Promise) {
    throw new Error("syntax tree reader must return plain values, not a tree node or a promise");
  }
  return result;
}
