import type { CardProblem, Dto, Provided, ProvidedEndpoint } from "@trackwall/protocol";
import { readJavaSyntax } from "./dto-java.ts";
import { readKotlinSyntax } from "./dto-kotlin.ts";
import type { SourceSyntax, TypeDeclaration } from "./dto-syntax.ts";
import { stemOf } from "./repo-path.ts";
import type { RepoSnapshot } from "./snapshot.ts";
import { isJvmSource, isTypeName } from "./spring.ts";
import { PARSE_TIME_LIMIT_MS, type SyntaxParsers } from "./syntax-tree.ts";

/**
 * Kontrakty endpointów HTTP i DTO (§4.6, ADR-38): endpoint z karty dostaje typ ciała żądania (`@RequestBody`)
 * i odpowiedzi z drzewa składni pliku, w którym leży jego metoda, a karta typy z repo osiągalne z tych typów przez
 * pola. Typ wskazuje prosta nazwa, więc z dwóch typów o tej samej nazwie w repo wygrywa ten z pliku o tej nazwie
 * (`OrderDto.java`), a potem pierwszy w kolejności plików.
 */

export interface Contracts {
  /** Fakty `provides` w tej samej kolejności, endpointy z typami kontraktu. */
  provides: Provided[];
  dtos: Dto[];
  problems: CardProblem[];
}

/**
 * Łączny czas parsowania na kartę (test podaje inny, żeby nie czekać): limit na plik (`PARSE_TIME_LIMIT_MS`) nie wystarcza, gdy złośliwych plików jest
 * wiele, a parser blokuje wątek daemona (§8).
 */
const CARD_PARSE_BUDGET_MS = 10_000;
/** Najwięcej DTO na karcie; więcej to wygenerowany model, a nie kontrakt pisany ręcznie. */
const MAX_DTOS = 500;
/** Opakowania, które nie zmieniają treści odpowiedzi: odpowiedzią jest ich argument. */
const RESPONSE_WRAPPERS = new Set([
  "ResponseEntity",
  "HttpEntity",
  "Mono",
  "Optional",
  "CompletableFuture",
  "CompletionStage",
  "Callable",
  "DeferredResult",
  "WebAsyncTask",
]);
/** Typy zwracane bez treści odpowiedzi. */
const NO_CONTENT = new Set(["void", "Void", "Unit", "?", "*"]);

export function extractContracts(
  snapshot: RepoSnapshot,
  provides: readonly Provided[],
  parsers: SyntaxParsers,
  budgetMs: number = CARD_PARSE_BUDGET_MS,
): Contracts {
  const syntax = new SyntaxOfFiles(snapshot, parsers, budgetMs);
  const withContracts = provides.map((p) => (p.kind === "endpoint" ? withContract(p, syntax) : p));
  const dtos = reachableDtos(
    withContracts.filter((p) => p.kind === "endpoint"),
    syntax,
  );
  return { provides: withContracts, dtos, problems: syntax.problems };
}

function withContract(endpoint: ProvidedEndpoint, syntax: SyntaxOfFiles): ProvidedEndpoint {
  const contract = syntax.of(endpoint.evidence.path)?.methods.get(methodName(endpoint.handler));
  return { ...endpoint, request: contract?.request ?? null, response: contract ? responseType(contract.returns) : null };
}

/** `metoda` z handlera `Klasa.metoda`. */
function methodName(handler: string): string {
  return handler.slice(handler.lastIndexOf(".") + 1);
}

/** Typ zwracany bez opakowań z `RESPONSE_WRAPPERS`; `null`, gdy odpowiedź nie ma treści. */
export function responseType(returns: string | null): string | null {
  let type = returns?.replaceAll(/\s+/g, "") ?? null;
  while (type !== null) {
    const open = type.indexOf("<");
    if (open < 0 || !type.endsWith(">") || !RESPONSE_WRAPPERS.has(type.slice(0, open).replace(/^.*\./, ""))) break;
    type = type.slice(open + 1, -1);
  }
  return type === null || type === "" || NO_CONTENT.has(type) ? null : type;
}

/** DTO osiągalne z typów żądań i odpowiedzi endpointów przez typy pól, w kolejności odkrycia. */
function reachableDtos(endpoints: readonly ProvidedEndpoint[], syntax: SyntaxOfFiles): Dto[] {
  const queue = endpoints.flatMap((e) => [e.request, e.response]).flatMap((t) => (t === null ? [] : typeNames(t)));
  const seen = new Set<string>();
  const dtos: Dto[] = [];
  for (let i = 0; i < queue.length; i++) {
    const name = queue[i] ?? "";
    if (seen.has(name)) continue;
    seen.add(name);
    const found = syntax.declaration(name);
    if (!found) continue;
    if (dtos.length === MAX_DTOS) {
      syntax.problems.push({ path: "", message: `the repo has more than ${MAX_DTOS} DTOs; the card lists the first ones` });
      break;
    }
    const { line, ...dto } = found.type;
    dtos.push({ ...dto, evidence: { path: found.path, line } });
    for (const field of dto.fields) queue.push(...typeNames(field.type));
  }
  return dtos;
}

/** Nazwy typów w zapisie typu (`Map<String, List<Line>>` → `Map`, `String`, `List`, `Line`): człony od wielkiej litery. */
function typeNames(type: string): string[] {
  return (type.match(/[A-Za-z_$][\w$]*/g) ?? []).filter(isTypeName);
}

/** Drzewa składni plików karty, każde liczone raz, we wspólnym budżecie czasu. */
class SyntaxOfFiles {
  readonly problems: CardProblem[] = [];
  private readonly snapshot: RepoSnapshot;
  private readonly parsers: SyntaxParsers;
  private readonly parsed = new Map<string, SourceSyntax | null>();
  private declaredIn: Map<string, string[]> | undefined;
  private readonly budgetMs: number;
  private spentMs = 0;
  private overBudget = false;

  constructor(snapshot: RepoSnapshot, parsers: SyntaxParsers, budgetMs: number) {
    this.snapshot = snapshot;
    this.parsers = parsers;
    this.budgetMs = budgetMs;
  }

  /** Składnia pliku; `null`, gdy go nie przeczytano, nie jest Javą ani Kotlinem albo parsowanie przekroczyło limit. */
  of(path: string): SourceSyntax | null {
    const cached = this.parsed.get(path);
    if (cached !== undefined) return cached;
    const result = this.parse(path);
    this.parsed.set(path, result);
    return result;
  }

  /** Deklaracja typu o nazwie `name` z plików karty: najpierw z pliku o tej nazwie, potem z innych. */
  declaration(name: string): { type: TypeDeclaration; path: string } | undefined {
    for (const path of this.filesDeclaring(name)) {
      const type = this.of(path)?.types.find((t) => t.name === name);
      if (type) return { type, path };
    }
    return undefined;
  }

  private filesDeclaring(name: string): string[] {
    this.declaredIn ??= declarationIndex(this.snapshot);
    const paths = this.declaredIn.get(name) ?? [];
    return [...paths.filter((p) => stemOf(p) === name), ...paths.filter((p) => stemOf(p) !== name)];
  }

  private parse(path: string): SourceSyntax | null {
    const text = this.snapshot.text(path);
    const language = path.endsWith(".java") ? "java" : path.endsWith(".kt") ? "kotlin" : null;
    if (text === undefined || language === null || this.overBudget) return null;
    if (this.spentMs > this.budgetMs) {
      this.overBudget = true;
      this.problems.push({
        path: "",
        message: `parsing Java and Kotlin took longer than ${this.budgetMs} ms; the remaining endpoints have no request and response types and the DTO list is incomplete`,
      });
      return null;
    }
    const started = performance.now();
    const result = this.parsers.read(language, text, language === "java" ? readJavaSyntax : readKotlinSyntax);
    this.spentMs += performance.now() - started;
    if (result.kind === "parsed") return result.value;
    this.problems.push({
      path,
      message: `parsing the file took longer than ${PARSE_TIME_LIMIT_MS} ms; its endpoints and types are missing from contracts`,
    });
    return null;
  }
}

/** Pliki źródłowe karty po nazwach typów, które w nich deklarowano (wyszukiwanie tekstu, bez parsowania). */
function declarationIndex(snapshot: RepoSnapshot): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const path of snapshot.paths) {
    const text = isJvmSource(path) ? snapshot.text(path) : undefined;
    if (text === undefined) continue;
    for (const m of text.matchAll(/\b(?:enum\s+class|class|record|enum|object)\s+([A-Za-z_$][\w$]*)/g)) {
      const name = m[1] ?? "";
      const paths = index.get(name);
      if (!paths) index.set(name, [path]);
      else if (paths.at(-1) !== path) paths.push(path);
    }
  }
  return index;
}
