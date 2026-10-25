import { type ConsumedHttp, type HttpMethod, HttpMethod as HttpMethodSchema, lbAppName, withoutCredentials } from "@trackwall/protocol";
import { annotationArgs, enumNames, type Lookup, stringValues } from "./java-expr.ts";
import type { JavaAnnotation, JavaType } from "./java-source.ts";
import { DEFAULT_PROFILE, type ModuleConfig } from "./spring-config.ts";

/**
 * Shared by the Spring extractors (§4.6, ADR-30): the module with its configuration, reading mappings (`@*Mapping`,
 * `@*Exchange`), expanding an address in every profile and an HTTP client from an address.
 */

/** A Spring module: configuration, app name, context path and types from the whole repo by simple name. */
export interface SpringModule {
  config: ModuleConfig;
  app: string | null;
  /** The app's context path (`server.servlet.context-path`, `spring.webflux.base-path`); `""` without one. */
  contextPath: string;
  /** Java and Kotlin types from the repo files read, by simple name (an interface with mappings that a controller implements). */
  types: TypeIndex;
}

/** How many calls of one client to record on the card: more is a generated client, and evidence from a few is enough anyway. */
const MAX_CLIENT_CALLS = 200;

/** A type from a file by simple name; the first in file order wins. */
export type TypeIndex = Map<string, { type: JavaType; path: string }>;

/** A mapping from an annotation: HTTP methods (`null`: any) and paths (`""`: no path). */
export interface Mapping {
  methods: (HttpMethod | null)[];
  paths: string[];
  line: number;
}

/** Spring MVC and WebFlux mapping annotations with the method they decide (`null`: from the `method` attribute). */
export const REQUEST_MAPPINGS: Readonly<Record<string, HttpMethod | null>> = {
  RequestMapping: null,
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  PatchMapping: "PATCH",
  DeleteMapping: "DELETE",
};

/** Spring 6 HTTP interface annotations (`@HttpExchange`). */
export const EXCHANGE_MAPPINGS: Readonly<Record<string, HttpMethod | null>> = {
  HttpExchange: null,
  GetExchange: "GET",
  PostExchange: "POST",
  PutExchange: "PUT",
  PatchExchange: "PATCH",
  DeleteExchange: "DELETE",
};

/** The mapping from the first annotation from table `table`; `undefined` without such an annotation. */
export function mappingOf(
  annotations: readonly JavaAnnotation[],
  table: Readonly<Record<string, HttpMethod | null>>,
  lookup: Lookup,
): Mapping | undefined {
  const annotation = annotations.find((a) => Object.hasOwn(table, a.name));
  if (!annotation) return undefined;
  const args = annotationArgs(annotation.args);
  const paths = stringValues(args.get("value") ?? args.get("path") ?? args.get("url"), lookup);
  const fixed = table[annotation.name] ?? null;
  const declared = enumNames(args.get("method"))
    .map((name) => HttpMethodSchema.safeParse(name.toUpperCase()).data)
    .filter((m) => m !== undefined);
  return {
    methods: fixed ? [fixed] : declared.length > 0 ? declared : [null],
    paths: paths.length > 0 ? paths : [""],
    line: annotation.line,
  };
}

/** An address in one profile: the value after expanding `${…}`, the profiles that have it, and the entry it comes from. */
export interface UrlVariant {
  value: string;
  profiles: string[];
  source: { path: string; line: number } | null;
}

/**
 * The address text in every profile of the module: first the default profile, then every profile that gives another
 * value. Text without `${…}` gives a single entry without profiles (an address in code). The user and password in the address are
 * masked, and the query is left out (§8).
 */
export function urlVariants(module: SpringModule, text: string): UrlVariant[] {
  if (!text.includes("${")) return [{ value: withoutCredentials(text), profiles: [], source: null }];
  const variant = (profile: string): UrlVariant => {
    const { value, source } = module.config.resolve(text, profile);
    return { value: withoutCredentials(value), profiles: [profile], source: source ? { path: source.path, line: source.line } : null };
  };
  // A profile with the same value as `default` does not change it, so it is not listed.
  const variants = [variant(DEFAULT_PROFILE)];
  for (const profile of module.config.profiles) {
    const next = variant(profile);
    if (next.value === variants[0]?.value) continue;
    const same = variants.find((v) => v.value === next.value);
    if (same) same.profiles.push(profile);
    else variants.push(next);
  }
  return variants;
}

/** What an HTTP client has regardless of the address; `app: null` takes the app name from an `lb://` address. */
export type ClientBase = Pick<ConsumedHttp, "via" | "name" | "app" | "calls" | "evidence">;

/** An HTTP client with its address in one profile. */
export function clientAt(base: ClientBase, variant: UrlVariant): ConsumedHttp {
  return {
    kind: "http",
    ...base,
    app: base.app ?? lbAppName(variant.value),
    url: variant.value || null,
    profiles: variant.profiles,
    urlSource: variant.source,
    calls: base.calls.slice(0, MAX_CLIENT_CALLS),
  };
}

/** An HTTP client in every profile where the address differs; without an address one client with `url: null`. */
export function httpClients(module: SpringModule, urlText: string | undefined, base: ClientBase): ConsumedHttp[] {
  const variants = urlText ? urlVariants(module, urlText) : [{ value: "", profiles: [], source: null }];
  return variants.map((v) => clientAt(base, v));
}
