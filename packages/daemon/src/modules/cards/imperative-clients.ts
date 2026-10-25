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
 * HTTP clients from code (§4.6, ADR-30): calls of `WebClient`, `RestClient` and `RestTemplate` in one file and their
 * base address (`baseUrl(…)`, `create(…)`, `rootUri(…)`, an address concatenated with the call's first argument), also
 * from a `@Value("${key}")` field. A file with one base address gives one client with the calls; with several addresses
 * each address is a separate client, and calls that cannot be assigned are matched by the graph on their paths alone.
 */

/** Client types by their name in code, in checking order. */
const CLIENT_TYPES: [string, HttpClientVia][] = [
  ["WebClient", "webclient"],
  ["RestClient", "rest-client"],
  ["RestTemplate", "rest-template"],
  ["RestTemplateBuilder", "rest-template"],
];
/** `WebClient` / `RestClient` methods that choose the HTTP method before `.uri(…)`. */
const FLUENT_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
/**
 * `RestTemplate` methods: the first argument is the address, and the HTTP method follows from the name (`null`: from an
 * `HttpMethod` argument).
 */
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
/** Methods that set a client's base address. */
const BASE_METHODS = new Set(["baseUrl", "rootUri", "create"]);
/** How many tokens back to look for the HTTP method in the chain before `.uri(…)`. */
const MAX_CHAIN = 60;
/**
 * The longest argument list (in tokens) the extractor takes apart: an address with a few concatenations is a few dozen
 * tokens, and calls nested thousands of times (a file from the repo, §8) would copy the rest of the file at every call.
 */
const MAX_ARGUMENT_TOKENS = 256;
/** At most this many `.uri(…)` calls and `RestTemplate` methods taken apart in one file: a longer list is not app code. */
const MAX_SCANNED_CALLS = 2000;

interface FoundCall extends HttpCall {
  /** A base address concatenated with the call (`baseUrl + "/orders"`, `"http://…/orders"`); `undefined` when there is none. */
  base: string | undefined;
}

export function imperativeClients(file: JavaFile, module: SpringModule, lookup: Lookup): ConsumedHttp[] {
  const via = CLIENT_TYPES.find(([name]) => file.tokens.some((t) => isIdent(t, name)))?.[1];
  if (via === undefined) return [];
  const ctx: ScanContext = { tokens: file.tokens, lookup, values: valueFields(file.tokens), path: file.path };
  const calls = findCalls(ctx);
  // Calls by base address; an address set only in the builder (`baseUrl(…)`) without calls is a client without calls.
  const byBase = new Map<string | undefined, { line: number | null; calls: HttpCall[] }>();
  for (const base of findBases(ctx)) if (!byBase.has(base.text)) byBase.set(base.text, { line: base.line, calls: [] });
  for (const { base, ...call } of calls) {
    const group = byBase.get(base) ?? { line: call.evidence.line, calls: [] };
    group.calls.push(call);
    byBase.set(base, group);
  }
  // Calls without their own address go to the class's only base address.
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
  /** Fields and parameters with `@Value("${key}")` by name: the text with `${…}` to expand in the configuration. */
  values: Map<string, string>;
  path: string;
}

/** Names of fields and parameters annotated with `@Value("…")`, with the annotation's text. */
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

/** The name of the field or parameter after the annotation: the last identifier before `,` `)` `;` `=` (Java) or before `:` (Kotlin). */
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

/** The base address text from an argument: a string, a constant or a `@Value` field; `undefined` for another expression. */
function baseText(arg: readonly Token[], ctx: ScanContext): string | undefined {
  const chain = identChain(arg);
  const field = chain?.length === 1 ? ctx.values.get(chain[0] ?? "") : undefined;
  if (field !== undefined) return field;
  const [value] = stringValues(arg, ctx.lookup);
  return value !== undefined && (value.includes("${") || parseHttpUrl(value)) ? value : undefined;
}

/**
 * The arguments of the call whose `(` bracket is at `open`. From a list longer than `MAX_ARGUMENT_TOKENS` (e.g. a request
 * body `Map.of(…)` in the call) only the arguments that fit within the limit in full: the address and the method come first.
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
    // Without the query: `?apiKey=…` in an address from code does not reach the card.
    if (call) calls.push({ ...call, path: joinHttpPath(call.path), evidence: { path: ctx.path, line: t.line } });
  }
  return calls;
}

type CallWithoutEvidence = Omit<FoundCall, "evidence">;

/** `.get().uri("/orders/{id}", id)` or `.uri(b -> b.path("/orders").build())`; the method from the chain before `.uri`. */
function fluentCall(ctx: ScanContext, dot: number, args: Token[][]): CallWithoutEvidence | undefined {
  const [first = []] = args;
  const pathCall = first.findIndex((t, j) => isIdent(t, "path") && isPunct(first[j + 1], "(") && isPunct(first[j - 1], "."));
  const target = pathCall >= 0 ? splitTopLevel(first.slice(pathCall + 2, closingIndex(first, pathCall + 1) - 1))[0] : first;
  const url = target && urlExpression(target, ctx);
  return url && { method: chainMethod(ctx.tokens, dot), ...url };
}

/** The HTTP method from the chain before `.uri`: `.get()`, `.method(HttpMethod.POST)`; `null` when the chain has none. */
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

/** The HTTP method from an `HttpMethod.POST` expression; `null` for another. */
function httpMethodIn(tokens: readonly Token[]): HttpMethod | null {
  const name = tokens.findLast((t) => t.kind === "ident");
  return (name?.kind === "ident" && HttpMethodSchema.safeParse(name.text).data) || null;
}

/**
 * Path and base address from an address expression: the `+` parts from the first string or constant. A `@Value` field
 * or a variable at the start is the base address (a `@Value` field gives its text), and a part after a string is `{}` (a
 * path variable). `undefined` when the expression gives neither a path from `/` nor an HTTP address.
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

/** A full address splits into a base address (scheme, host, port) and a path; a path from `/` keeps the base from the field. */
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
