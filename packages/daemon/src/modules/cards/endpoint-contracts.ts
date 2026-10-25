import type { CardProblem, Dto, DtoField, Provided, ProvidedEndpoint } from "@trackwall/protocol";
import { readJavaSyntax } from "./contract-java.ts";
import { readKotlinSyntax } from "./contract-kotlin.ts";
import { type MethodContract, type SourceSyntax, simpleName, type TypeDeclaration } from "./contract-syntax.ts";
import { isTypeName } from "./java-tokens.ts";
import { stemOf } from "./repo-path.ts";
import type { RepoSnapshot } from "./snapshot.ts";
import { isJvmSource, jvmLanguageOf } from "./spring.ts";
import { PARSE_TIME_LIMIT_MS, type SyntaxParsers } from "./syntax-tree.ts";

/**
 * HTTP endpoint contracts and DTOs (§4.6, ADR-38): an endpoint on the card gets the request body type (`@RequestBody`)
 * and the response type from the method its mapping lies in, and the card gets the repo's types reachable from those types
 * through fields. A type is referred to by its simple name, so of two types with the same name in the repo the one from
 * the file with that name wins (`OrderDto.java`), and then the first in file order.
 */

export interface Contracts {
  /** The `provides` facts in the same order, endpoints with contract types. */
  provides: Provided[];
  dtos: Dto[];
  problems: CardProblem[];
}

/** At most this many DTOs on a card; more is a generated model, not a hand-written contract. */
const MAX_DTOS = 500;
/** At most this many fields or enum constants of one DTO on a card. */
const MAX_DTO_MEMBERS = 200;
/**
 * The longest type notation on a card; a longer one is cut so that one file from the repo does not bloat the card and
 * the agent's context.
 */
const MAX_TYPE_LENGTH = 256;
/** Wrappers that do not change the response content: the response is their argument. */
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
/** Return types without response content (`*` is `ResponseEntity<*>` in Kotlin). */
const NO_CONTENT = new Set(["void", "Void", "Unit", "?", "*"]);

export function extractContracts(snapshot: RepoSnapshot, provides: readonly Provided[], parsers: SyntaxParsers): Contracts {
  const problems: CardProblem[] = [];
  const syntax = new SyntaxOfFiles(snapshot, parsers, problems);
  const withContracts = provides.map((p) => (p.kind === "endpoint" ? withContract(p, syntax) : p));
  const dtos = reachableDtos(
    withContracts.filter((p) => p.kind === "endpoint"),
    syntax,
    problems,
  );
  // Cutting only after discovering the DTOs: a name cut in half would point to another type.
  return clipTypes({ provides: withContracts, dtos, problems });
}

/**
 * The contract from the method named after the handler that contains the endpoint's mapping line (a file can have
 * several classes and overloads); without a line or without such a method the first method with that name (an API
 * interface the controller implements has a method with the same name).
 */
function withContract(endpoint: ProvidedEndpoint, syntax: SyntaxOfFiles): ProvidedEndpoint {
  const name = simpleName(endpoint.handler);
  const methods = (syntax.of(endpoint.evidence.path)?.methods ?? []).filter((m) => m.name === name);
  const contract = methodAt(methods, endpoint.evidence.line) ?? methods[0];
  return { ...endpoint, request: contract?.request ?? null, response: contract ? responseType(contract.returns) : null };
}

/** The method that contains the line; of nested ones (a method of a local class) the narrowest. */
function methodAt(methods: readonly MethodContract[], line: number | null): MethodContract | undefined {
  if (line === null) return undefined;
  let found: MethodContract | undefined;
  for (const m of methods)
    if (m.startLine <= line && line <= m.endLine && (!found || m.endLine - m.startLine < found.endLine - found.startLine)) found = m;
  return found;
}

/** The return type without the wrappers from `RESPONSE_WRAPPERS` (also `ResponseEntity<T>?`); `null` when the response has no content. */
export function responseType(returns: string | null): string | null {
  let type = returns;
  while (type !== null) {
    const nullable = type.endsWith("?") && type.length > 1 ? type.slice(0, -1) : type;
    const open = nullable.indexOf("<");
    const wrapper = simpleName(open < 0 ? nullable : nullable.slice(0, open));
    if (!RESPONSE_WRAPPERS.has(wrapper)) break;
    // A wrapper without an argument (`ResponseEntity`) does not say what the content is.
    type = open < 0 || !nullable.endsWith(">") ? null : nullable.slice(open + 1, -1);
  }
  return type === null || type === "" || NO_CONTENT.has(type) ? null : type;
}

/** DTOs reachable from the endpoints' request and response types through field types, in discovery order. */
function reachableDtos(endpoints: readonly ProvidedEndpoint[], syntax: SyntaxOfFiles, problems: CardProblem[]): Dto[] {
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
      problems.push({ path: "", message: `the repo has more than ${MAX_DTOS} DTOs; the card lists the first ones` });
      break;
    }
    const dto = toDto(found.type, found.path, problems);
    dtos.push(dto);
    // No `push(...names)`: a field type with hundreds of thousands of arguments would exceed the call argument limit under Node.
    for (const typeName of fieldTypeNames(dto)) queue.push(typeName);
  }
  return dtos;
}

/** The names of a DTO's field types; an enum has no fields. */
function fieldTypeNames(dto: Dto): string[] {
  return dto.kind === "enum" ? [] : dto.fields.flatMap((f) => typeNames(f.type));
}

/** A DTO with evidence, with at most `MAX_DTO_MEMBERS` fields or constants. */
function toDto(declared: TypeDeclaration, path: string, problems: CardProblem[]): Dto {
  const evidence = { path, line: declared.line };
  const tooMany = (members: string) =>
    problems.push({ path, message: `${declared.name} has more than ${MAX_DTO_MEMBERS} ${members}; the card lists the first ones` });
  if (declared.kind === "enum") {
    if (declared.values.length > MAX_DTO_MEMBERS) tooMany("constants");
    return { name: declared.name, kind: "enum", values: declared.values.slice(0, MAX_DTO_MEMBERS), evidence };
  }
  if (declared.fields.length > MAX_DTO_MEMBERS) tooMany("fields");
  return { name: declared.name, kind: declared.kind, fields: declared.fields.slice(0, MAX_DTO_MEMBERS), evidence };
}

/**
 * Type names in type notation (`Map<String,List<Api.Line>>` → `Map`, `String`, `List`, `Line`): the last part of every
 * qualified name when it starts with a capital letter, because the earlier parts are a package or an outer type, not a DTO.
 */
function typeNames(type: string): string[] {
  return (type.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g) ?? []).map(simpleName).filter(isTypeName);
}

/** Type notations on the card cut to `MAX_TYPE_LENGTH` characters (with “…”), with one problem per card. */
function clipTypes({ provides, dtos, problems }: Contracts): Contracts {
  let clippedAny = false;
  const clip = (type: string): string => {
    if (type.length <= MAX_TYPE_LENGTH) return type;
    clippedAny = true;
    return `${type.slice(0, MAX_TYPE_LENGTH)}…`;
  };
  const clipOrNull = (type: string | null) => (type === null ? null : clip(type));
  const clippedProvides = provides.map((p) =>
    p.kind === "endpoint" ? { ...p, request: clipOrNull(p.request), response: clipOrNull(p.response) } : p,
  );
  const clippedDtos = dtos.map((d) =>
    d.kind === "enum" ? d : { ...d, fields: d.fields.map((f): DtoField => ({ name: f.name, type: clip(f.type) })) },
  );
  const clipProblem = { path: "", message: `some types are longer than ${MAX_TYPE_LENGTH} characters; the card shows their beginning` };
  return { provides: clippedProvides, dtos: clippedDtos, problems: clippedAny ? [...problems, clipProblem] : problems };
}

/** Syntax trees of the card's files, each computed once; parse problems go to the card's `problems`. */
class SyntaxOfFiles {
  private readonly snapshot: RepoSnapshot;
  private readonly parsers: SyntaxParsers;
  private readonly problems: CardProblem[];
  private readonly parsed = new Map<string, SourceSyntax | null>();
  private declaredIn: Map<string, string[]> | undefined;
  private stopped = false;

  constructor(snapshot: RepoSnapshot, parsers: SyntaxParsers, problems: CardProblem[]) {
    this.snapshot = snapshot;
    this.parsers = parsers;
    this.problems = problems;
  }

  /** The file's syntax; `null` when it was not read, is not Java or Kotlin, or has no tree. */
  of(path: string): SourceSyntax | null {
    const cached = this.parsed.get(path);
    if (cached !== undefined) return cached;
    const result = this.parse(path);
    this.parsed.set(path, result);
    return result;
  }

  /** The declaration of type `name` from the card's files: first from the file with that name, then from the others. */
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
    const language = jvmLanguageOf(path);
    if (text === undefined || language === null || this.stopped) return null;
    const result = this.parsers.read(language, text, language === "java" ? readJavaSyntax : readKotlinSyntax);
    switch (result.kind) {
      case "parsed":
        return result.value;
      case "timeout":
        this.problems.push({
          path,
          message: `parsing the file took longer than ${PARSE_TIME_LIMIT_MS} ms; its endpoints have no request and response types and its DTOs are missing`,
        });
        return null;
      case "over-budget":
        this.stop(
          `parsing Java and Kotlin took longer than ${result.budgetMs} ms; the remaining endpoints have no request and response types and the DTO list is incomplete`,
        );
        return null;
      case "unavailable":
        this.stop(
          `Java and Kotlin parsers could not be loaded (${result.reason}); endpoints have no request and response types and the card has no DTOs`,
        );
        return null;
    }
  }

  /** Once the budget is used up or without parsers no further file gets a tree, so one problem per card. */
  private stop(message: string): void {
    this.stopped = true;
    this.problems.push({ path: "", message });
  }
}

/**
 * The card's source files by the type names declared in them: a text search without parsing, so a name from a comment
 * also lands in the index, but `declaration` checks it later in the syntax tree.
 */
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
