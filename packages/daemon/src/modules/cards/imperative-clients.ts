import {
  type ConsumedHttp,
  type HttpCall,
  type HttpClientVia,
  type HttpMethod,
  HttpMethod as HttpMethodSchema,
  joinHttpPath,
  parseHttpUrl,
} from "@trackwall/protocol";
import { identChain, type Lookup, splitConcat, splitTopLevel, stringValues } from "./java-expr.ts";
import type { JavaFile } from "./java-source.ts";
import { closingIndex, isIdent, isPunct, type Token } from "./java-tokens.ts";
import { httpClients, type SpringModule } from "./spring-module.ts";

/**
 * Klienci HTTP z kodu (§4.6, ADR-30): wywołania `WebClient`, `RestClient` i `RestTemplate` w jednym pliku i ich adres
 * bazowy (`baseUrl(…)`, `create(…)`, `rootUri(…)`, adres sklejony z pierwszym argumentem wywołania), także z pola
 * `@Value("${klucz}")`. Plik z jednym adresem bazowym daje jednego klienta z wywołaniami; z kilkoma adresami każdy
 * adres jest osobnym klientem, a wywołań, których nie da się przypisać, graf szuka po samych ścieżkach.
 */

/** Typy klientów po nazwie w kodzie, w kolejności sprawdzania. */
const CLIENT_TYPES: [string, HttpClientVia][] = [
  ["WebClient", "webclient"],
  ["RestClient", "rest-client"],
  ["RestTemplate", "rest-template"],
  ["RestTemplateBuilder", "rest-template"],
];
/** Metody `WebClient` / `RestClient` wybierające metodę HTTP przed `.uri(…)`. */
const FLUENT_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
/** Metody `RestTemplate`: pierwszy argument to adres, a metoda HTTP wynika z nazwy (`null`: z argumentu `HttpMethod`). */
const TEMPLATE_METHODS: Record<string, HttpMethod | null> = {
  getForObject: "GET",
  getForEntity: "GET",
  postForObject: "POST",
  postForEntity: "POST",
  postForLocation: "POST",
  put: "PUT",
  patchForObject: "PATCH",
  delete: "DELETE",
  exchange: null,
  execute: null,
};
/** Metody ustawiające adres bazowy klienta. */
const BASE_METHODS = new Set(["baseUrl", "rootUri", "create"]);
/** Ile tokenów wstecz szukać metody HTTP w łańcuchu przed `.uri(…)`. */
const MAX_CHAIN = 60;
/**
 * Najdłuższa lista argumentów (w tokenach), którą ekstraktor rozkłada: adres z kilkoma sklejeniami to kilkadziesiąt
 * tokenów, a wywołania zagnieżdżone tysiące razy (plik z repo, §8) kopiowałyby resztę pliku przy każdym wywołaniu.
 */
const MAX_ARGUMENT_TOKENS = 256;
/** Najwięcej wywołań `.uri(…)` i metod `RestTemplate` rozkładanych w jednym pliku: dłuższa lista to nie kod aplikacji. */
const MAX_SCANNED_CALLS = 2000;

interface FoundCall extends HttpCall {
  /** Adres bazowy sklejony z wywołaniem (`baseUrl + "/orders"`, `"http://…/orders"`); `undefined`, gdy go nie ma. */
  base: string | undefined;
}

export function imperativeClients(file: JavaFile, module: SpringModule, lookup: Lookup): ConsumedHttp[] {
  const via = CLIENT_TYPES.find(([name]) => file.tokens.some((t) => isIdent(t, name)))?.[1];
  if (via === undefined) return [];
  const ctx: ScanContext = { tokens: file.tokens, lookup, values: valueFields(file.tokens), path: file.path };
  const calls = findCalls(ctx);
  // Wywołania po adresie bazowym; adres ustawiony tylko w budowniczym (`baseUrl(…)`) bez wywołań to klient bez wywołań.
  const byBase = new Map<string | undefined, { line: number | null; calls: HttpCall[] }>();
  for (const base of findBases(ctx)) if (!byBase.has(base.text)) byBase.set(base.text, { line: base.line, calls: [] });
  for (const { base, ...call } of calls) {
    const group = byBase.get(base) ?? { line: call.evidence.line, calls: [] };
    group.calls.push(call);
    byBase.set(base, group);
  }
  // Wywołania bez własnego adresu idą do jedynego adresu bazowego klasy.
  const unassigned = byBase.get(undefined);
  const [only, ...others] = [...byBase.keys()].filter((k) => k !== undefined);
  if (unassigned && only !== undefined && others.length === 0) {
    byBase.get(only)?.calls.push(...unassigned.calls);
    byBase.delete(undefined);
  }
  const name = file.types[0]?.name ?? file.path;
  return [...byBase].flatMap(([base, group]) =>
    httpClients(module, base, {
      via,
      name,
      app: null,
      calls: group.calls,
      evidence: { path: file.path, line: group.line ?? file.types[0]?.line ?? null },
    }),
  );
}

interface ScanContext {
  tokens: readonly Token[];
  lookup: Lookup;
  /** Pola i parametry z `@Value("${klucz}")` po nazwie: tekst z `${…}` do rozwinięcia w konfiguracji. */
  values: Map<string, string>;
  path: string;
}

/** Nazwy pól i parametrów oznaczonych `@Value("…")` z tekstem adnotacji. */
function valueFields(tokens: readonly Token[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    if (!isPunct(tokens[i], "@") || !isIdent(tokens[i + 1], "Value") || !isPunct(tokens[i + 2], "(")) continue;
    const text = tokens[i + 3];
    const end = closingIndex(tokens, i + 2);
    const name = boundName(tokens, end);
    if (text?.kind === "string" && name) fields.set(name, text.value);
  }
  return fields;
}

/** Nazwa pola albo parametru za adnotacją: ostatni identyfikator przed `,` `)` `;` `=` (Java) albo przed `:` (Kotlin). */
function boundName(tokens: readonly Token[], from: number): string | undefined {
  for (let j = from; j < from + 8 && j < tokens.length; j++) {
    const t = tokens[j];
    const next = tokens[j + 1];
    if (t?.kind === "ident" && [",", ")", ";", "=", ":"].some((p) => isPunct(next, p))) return t.text;
  }
  return undefined;
}

function findBases(ctx: ScanContext): { text: string; line: number }[] {
  const bases: { text: string; line: number }[] = [];
  for (let i = 0; i + 2 < ctx.tokens.length; i++) {
    const t = ctx.tokens[i + 1];
    if (!isPunct(ctx.tokens[i], ".") || t?.kind !== "ident" || !BASE_METHODS.has(t.text) || !isPunct(ctx.tokens[i + 2], "(")) continue;
    const [arg] = argumentsAt(ctx.tokens, i + 2) ?? [];
    const text = arg && baseText(arg, ctx);
    if (text) bases.push({ text, line: t.line });
  }
  return bases;
}

/** Tekst adresu bazowego z argumentu: napis, stała albo pole `@Value`; `undefined` dla innego wyrażenia. */
function baseText(arg: readonly Token[], ctx: ScanContext): string | undefined {
  const chain = identChain(arg);
  const field = chain?.length === 1 ? ctx.values.get(chain[0] ?? "") : undefined;
  if (field !== undefined) return field;
  const [value] = stringValues(arg, ctx.lookup);
  return value !== undefined && (value.includes("${") || parseHttpUrl(value)) ? value : undefined;
}

/**
 * Argumenty wywołania z nawiasem `(` pod `open`. Z listy dłuższej niż `MAX_ARGUMENT_TOKENS` (np. ciało żądania
 * `Map.of(…)` w wywołaniu) tylko argumenty, które mieszczą się w limicie w całości: adres i metoda są na początku.
 */
function argumentsAt(tokens: readonly Token[], open: number): Token[][] | undefined {
  const end = closingIndex(tokens, open);
  if (end - open <= MAX_ARGUMENT_TOKENS) return splitTopLevel(tokens.slice(open + 1, end - 1));
  let lastComma = -1;
  for (let i = open + 1; i < open + 1 + MAX_ARGUMENT_TOKENS && i < end - 1; ) {
    const t = tokens[i];
    if (isPunct(t, "(") || isPunct(t, "{") || isPunct(t, "[")) i = closingIndex(tokens, i);
    else {
      if (isPunct(t, ",")) lastComma = i;
      i++;
    }
  }
  return lastComma < 0 ? undefined : splitTopLevel(tokens.slice(open + 1, lastComma));
}

function findCalls(ctx: ScanContext): FoundCall[] {
  const calls: FoundCall[] = [];
  let scanned = 0;
  for (let i = 0; i + 2 < ctx.tokens.length && scanned < MAX_SCANNED_CALLS; i++) {
    const t = ctx.tokens[i + 1];
    if (!isPunct(ctx.tokens[i], ".") || t?.kind !== "ident" || !isPunct(ctx.tokens[i + 2], "(")) continue;
    if (t.text !== "uri" && !Object.hasOwn(TEMPLATE_METHODS, t.text)) continue;
    scanned++;
    const args = argumentsAt(ctx.tokens, i + 2);
    if (args === undefined) continue;
    const call = t.text === "uri" ? fluentCall(ctx, i, args) : templateCall(ctx, t.text, args);
    // Bez zapytania: `?apiKey=…` w adresie z kodu nie trafia na kartę.
    if (call) calls.push({ ...call, path: joinHttpPath(call.path), evidence: { path: ctx.path, line: t.line } });
  }
  return calls;
}

type CallWithoutEvidence = Omit<FoundCall, "evidence">;

/** `.get().uri("/orders/{id}", id)` albo `.uri(b -> b.path("/orders").build())`; metoda z łańcucha przed `.uri`. */
function fluentCall(ctx: ScanContext, dot: number, args: Token[][]): CallWithoutEvidence | undefined {
  const [first = []] = args;
  const pathCall = first.findIndex((t, j) => isIdent(t, "path") && isPunct(first[j + 1], "(") && isPunct(first[j - 1], "."));
  const target = pathCall >= 0 ? splitTopLevel(first.slice(pathCall + 2, closingIndex(first, pathCall + 1) - 1))[0] : first;
  const url = target && urlExpression(target, ctx);
  return url && { method: chainMethod(ctx.tokens, dot), ...url };
}

/** Metoda HTTP z łańcucha przed `.uri`: `.get()`, `.method(HttpMethod.POST)`; `null`, gdy łańcuch jej nie ma. */
function chainMethod(tokens: readonly Token[], dot: number): HttpMethod | null {
  for (let j = dot - 1; j >= 0 && j > dot - MAX_CHAIN; j--) {
    const t = tokens[j];
    if (isPunct(t, ";") || isPunct(t, "{") || isPunct(t, "}")) break;
    if (t?.kind !== "ident" || !isPunct(tokens[j - 1], ".") || !isPunct(tokens[j + 1], "(")) continue;
    if (FLUENT_METHODS.has(t.text)) return HttpMethodSchema.parse(t.text.toUpperCase());
    if (t.text === "method") return httpMethodIn((argumentsAt(tokens, j + 1) ?? []).flat());
  }
  return null;
}

/** `restTemplate.getForObject(baseUrl + "/orders/{id}", …)`, `exchange(url, HttpMethod.GET, …)`. */
function templateCall(ctx: ScanContext, name: string, args: Token[][]): CallWithoutEvidence | undefined {
  const [first, second] = args;
  const url = first && urlExpression(first, ctx);
  if (!url) return undefined;
  return { method: TEMPLATE_METHODS[name] ?? (second ? httpMethodIn(second) : null), ...url };
}

/** Metoda HTTP z wyrażenia `HttpMethod.POST`; `null` dla innego. */
function httpMethodIn(tokens: readonly Token[]): HttpMethod | null {
  const name = tokens.findLast((t) => t.kind === "ident");
  return (name?.kind === "ident" && HttpMethodSchema.safeParse(name.text).data) || null;
}

/**
 * Ścieżka i adres bazowy z wyrażenia adresu: składniki `+` od pierwszego napisu albo stałej. Pole `@Value` albo
 * zmienna na początku to adres bazowy (pole `@Value` daje jego tekst), a składnik po napisie to `{}` (zmienna ścieżki).
 * `undefined`, gdy wyrażenie nie daje ścieżki od `/` ani adresu HTTP.
 */
function urlExpression(expr: readonly Token[], ctx: ScanContext): { path: string; base: string | undefined } | undefined {
  let text = "";
  let base: string | undefined;
  for (const [i, operand] of splitConcat(expr).entries()) {
    const literal = stringValues(operand, ctx.lookup)[0];
    const chain = identChain(operand);
    if (literal !== undefined && !literal.startsWith("<")) text += literal;
    else if (i === 0 && chain?.length === 1) base = ctx.values.get(chain[0] ?? "");
    else if (text !== "") text += "{}";
    else if (i === 0) continue;
    else return undefined;
  }
  return splitUrl(text, base);
}

/** Pełny adres dzieli się na adres bazowy (schemat, host, port) i ścieżkę; ścieżka od `/` zostaje z bazą z pola. */
function splitUrl(text: string, base: string | undefined): { path: string; base: string | undefined } | undefined {
  if (parseHttpUrl(text)) {
    const slash = text.indexOf("/", text.indexOf("://") + 3);
    return slash < 0 ? { path: "/", base: text } : { path: text.slice(slash), base: text.slice(0, slash) };
  }
  if (text.startsWith("/")) return { path: text, base };
  if (text.startsWith("${")) {
    const end = text.indexOf("}");
    return end > 0 && text[end + 1] === "/" ? { path: text.slice(end + 1), base: text.slice(0, end + 1) } : undefined;
  }
  return undefined;
}
