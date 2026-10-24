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
 * Kontrakty endpointów HTTP i DTO (§4.6, ADR-38): endpoint z karty dostaje typ ciała żądania (`@RequestBody`)
 * i odpowiedzi z metody, w której leży jego mapowanie, a karta typy z repo osiągalne z tych typów przez pola. Typ
 * wskazuje prosta nazwa, więc z dwóch typów o tej samej nazwie w repo wygrywa ten z pliku o tej nazwie
 * (`OrderDto.java`), a potem pierwszy w kolejności plików.
 */

export interface Contracts {
  /** Fakty `provides` w tej samej kolejności, endpointy z typami kontraktu. */
  provides: Provided[];
  dtos: Dto[];
  problems: CardProblem[];
}

/** Najwięcej DTO na karcie; więcej to wygenerowany model, a nie kontrakt pisany ręcznie. */
const MAX_DTOS = 500;
/** Najwięcej pól albo stałych enuma jednego DTO na karcie. */
const MAX_DTO_MEMBERS = 200;
/** Najdłuższy zapis typu na karcie; dłuższy jest przycinany, żeby jeden plik z repo nie rozdął karty i kontekstu agenta. */
const MAX_TYPE_LENGTH = 256;
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
/** Typy zwracane bez treści odpowiedzi (`*` to `ResponseEntity<*>` w Kotlinie). */
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
  // Przycięcie dopiero po odkryciu DTO: nazwa ucięta w połowie wskazałaby inny typ.
  return clipTypes({ provides: withContracts, dtos, problems });
}

/**
 * Kontrakt z metody o nazwie z handlera, w której leży linia mapowania endpointu (w pliku bywa kilka klas
 * i przeciążeń); bez linii albo bez takiej metody pierwsza metoda o tej nazwie (interfejs API, który kontroler
 * implementuje, ma metodę o tej samej nazwie).
 */
function withContract(endpoint: ProvidedEndpoint, syntax: SyntaxOfFiles): ProvidedEndpoint {
  const name = simpleName(endpoint.handler);
  const methods = (syntax.of(endpoint.evidence.path)?.methods ?? []).filter((m) => m.name === name);
  const contract = methodAt(methods, endpoint.evidence.line) ?? methods[0];
  return { ...endpoint, request: contract?.request ?? null, response: contract ? responseType(contract.returns) : null };
}

/** Metoda, w której leży linia; z zagnieżdżonych (metoda klasy lokalnej) najwęższa. */
function methodAt(methods: readonly MethodContract[], line: number | null): MethodContract | undefined {
  if (line === null) return undefined;
  let found: MethodContract | undefined;
  for (const m of methods)
    if (m.startLine <= line && line <= m.endLine && (!found || m.endLine - m.startLine < found.endLine - found.startLine)) found = m;
  return found;
}

/** Typ zwracany bez opakowań z `RESPONSE_WRAPPERS` (także `ResponseEntity<T>?`); `null`, gdy odpowiedź nie ma treści. */
export function responseType(returns: string | null): string | null {
  let type = returns;
  while (type !== null) {
    const nullable = type.endsWith("?") && type.length > 1 ? type.slice(0, -1) : type;
    const open = nullable.indexOf("<");
    const wrapper = simpleName(open < 0 ? nullable : nullable.slice(0, open));
    if (!RESPONSE_WRAPPERS.has(wrapper)) break;
    // Opakowanie bez argumentu (`ResponseEntity`) nie mówi, co jest treścią.
    type = open < 0 || !nullable.endsWith(">") ? null : nullable.slice(open + 1, -1);
  }
  return type === null || type === "" || NO_CONTENT.has(type) ? null : type;
}

/** DTO osiągalne z typów żądań i odpowiedzi endpointów przez typy pól, w kolejności odkrycia. */
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
    if (dto.kind !== "enum") for (const field of dto.fields) queue.push(...typeNames(field.type));
  }
  return dtos;
}

/** DTO z dowodem, z najwyżej `MAX_DTO_MEMBERS` polami albo stałymi. */
function toDto(declared: TypeDeclaration, path: string, problems: CardProblem[]): Dto {
  const evidence = { path, line: declared.line };
  const members = declared.kind === "enum" ? declared.values : declared.fields;
  if (members.length > MAX_DTO_MEMBERS)
    problems.push({
      path,
      message: `${declared.name} has more than ${MAX_DTO_MEMBERS} ${declared.kind === "enum" ? "constants" : "fields"}; the card lists the first ones`,
    });
  if (declared.kind === "enum") return { name: declared.name, kind: "enum", values: declared.values.slice(0, MAX_DTO_MEMBERS), evidence };
  return { name: declared.name, kind: declared.kind, fields: declared.fields.slice(0, MAX_DTO_MEMBERS), evidence };
}

/**
 * Nazwy typów w zapisie typu (`Map<String,List<Api.Line>>` → `Map`, `String`, `List`, `Line`): ostatni człon każdej
 * nazwy kwalifikowanej, gdy zaczyna się wielką literą, bo wcześniejsze to pakiet albo typ zewnętrzny, a nie DTO.
 */
function typeNames(type: string): string[] {
  return (type.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g) ?? []).map(simpleName).filter(isTypeName);
}

/** Zapisy typów na karcie przycięte do `MAX_TYPE_LENGTH` znaków (z „…”), z jednym problemem na kartę. */
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

/** Drzewa składni plików karty, każde liczone raz; problemy parsowania trafiają do `problems` karty. */
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

  /** Składnia pliku; `null`, gdy go nie przeczytano, nie jest Javą ani Kotlinem albo nie ma drzewa. */
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

  /** Po wyczerpaniu budżetu albo bez parserów żaden kolejny plik nie dostanie drzewa, więc jeden problem na kartę. */
  private stop(message: string): void {
    this.stopped = true;
    this.problems.push({ path: "", message });
  }
}

/**
 * Pliki źródłowe karty po nazwach typów, które w nich deklarowano: wyszukiwanie tekstu bez parsowania, więc nazwa
 * z komentarza też trafia do indeksu, ale `declaration` sprawdza ją potem w drzewie składni.
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
