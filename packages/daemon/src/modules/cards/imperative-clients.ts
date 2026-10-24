import {
  type ConsumedHttp,
  type HttpCall,
  type HttpClientVia,
  type HttpMethod,
  HttpMethod as HttpMethodSchema,
  joinHttpPath,
  parseHttpUrl,
} from "@trackwall/protocol";
import { identChain, type Lookup, splitTopLevel, stringValues } from "./java-expr.ts";
import type { JavaFile } from "./java-source.ts";
import { closingIndex, isIdent, isPunct, type Token } from "./java-tokens.ts";
import { type SpringModule, urlVariants } from "./spring-module.ts";

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
const MAX_CALLS = 200;

interface FoundCall extends HttpCall {
  /** Adres bazowy sklejony z wywołaniem (`baseUrl + "/orders"`, `"http://…/orders"`); `undefined`, gdy go nie ma. */
  base: string | undefined;
}

export function imperativeClients(file: JavaFile, module: SpringModule, lookup: Lookup): ConsumedHttp[] {
  const via = CLIENT_TYPES.find(([name]) => file.tokens.some((t) => isIdent(t, name)))?.[1];
  if (via === undefined) return [];
  const values = valueFields(file.tokens);
  const ctx: ScanContext = { tokens: file.tokens, lookup, values, path: file.path };
  const calls = findCalls(ctx).slice(0, MAX_CALLS);
  const bases = unique([...findBases(ctx), ...calls.flatMap((c) => (c.base ? [{ text: c.base, line: c.evidence.line ?? 0 }] : []))]);
  const name = file.types[0]?.name ?? file.path;
  const client = (base: { text: string; line: number } | undefined, own: HttpCall[]): ConsumedHttp[] => {
    const line = base?.line ?? own[0]?.evidence.line ?? file.types[0]?.line ?? null;
    const evidence = { path: file.path, line };
    const variants = base ? urlVariants(module, base.text) : [{ value: "", profiles: [], source: null }];
    return variants.map((v) => ({
      kind: "http",
      via,
      name,
      app: appOf(v.value),
      url: v.value || null,
      profiles: v.profiles,
      urlSource: v.source,
      calls: own,
      evidence,
    }));
  };
  const strip = (c: FoundCall): HttpCall => ({ method: c.method, path: c.path, evidence: c.evidence });
  if (bases.length <= 1) return bases.length === 0 && calls.length === 0 ? [] : client(bases[0], calls.map(strip));
  const unassigned = calls.filter((c) => c.base === undefined).map(strip);
  return [
    ...bases.flatMap((b) => client(b, calls.filter((c) => c.base === b.text).map(strip))),
    ...(unassigned.length > 0 ? client(undefined, unassigned) : []),
  ];
}

/** Nazwa aplikacji z adresu `lb://nazwa` (load balancer Spring Cloud). */
export function appOf(url: string): string | null {
  const parsed = parseHttpUrl(url);
  return parsed?.scheme === "lb" ? parsed.host : null;
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
    const [arg] = splitTopLevel(ctx.tokens.slice(i + 3, closingIndex(ctx.tokens, i + 2) - 1));
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

function findCalls(ctx: ScanContext): FoundCall[] {
  const calls: FoundCall[] = [];
  for (let i = 0; i + 2 < ctx.tokens.length; i++) {
    const t = ctx.tokens[i + 1];
    if (!isPunct(ctx.tokens[i], ".") || t?.kind !== "ident" || !isPunct(ctx.tokens[i + 2], "(")) continue;
    const args = splitTopLevel(ctx.tokens.slice(i + 3, closingIndex(ctx.tokens, i + 2) - 1));
    const call =
      t.text === "uri" ? fluentCall(ctx, i, args) : Object.hasOwn(TEMPLATE_METHODS, t.text) ? templateCall(ctx, t.text, args) : undefined;
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
    if (t.text === "method") return httpMethodIn(tokens.slice(j + 2, closingIndex(tokens, j + 1) - 1));
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

/** Składniki sklejania `+` poza nawiasami. */
function splitConcat(expr: readonly Token[]): Token[][] {
  const parts: Token[][] = [[]];
  for (let i = 0; i < expr.length; i++) {
    const t = expr[i];
    if (isPunct(t, "(") || isPunct(t, "[") || isPunct(t, "{")) {
      const end = closingIndex(expr, i);
      parts.at(-1)?.push(...expr.slice(i, end));
      i = end - 1;
    } else if (isPunct(t, "+")) parts.push([]);
    else if (t) parts.at(-1)?.push(t);
  }
  return parts.filter((p) => p.length > 0);
}

function unique<T extends { text: string }>(items: T[]): T[] {
  return items.filter((item, i) => items.findIndex((other) => other.text === item.text) === i);
}
