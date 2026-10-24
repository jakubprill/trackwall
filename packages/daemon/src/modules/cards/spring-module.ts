import { type HttpMethod, HttpMethod as HttpMethodSchema, withoutCredentials } from "@trackwall/protocol";
import { annotationArgs, enumNames, type Lookup, stringValues } from "./java-expr.ts";
import type { JavaAnnotation, JavaType } from "./java-source.ts";
import { DEFAULT_PROFILE, type ModuleConfig } from "./spring-config.ts";

/**
 * Wspólne dla ekstraktorów Spring (§4.6, ADR-30): moduł z konfiguracją, odczyt mapowań (`@*Mapping`,
 * `@*Exchange`) i rozwijanie adresu w każdym profilu.
 */

/** Moduł Spring: konfiguracja, nazwa aplikacji, ścieżka kontekstu i typy z całego repo po prostej nazwie. */
export interface SpringModule {
  config: ModuleConfig;
  app: string | null;
  /** Ścieżka kontekstu aplikacji (`server.servlet.context-path`, `spring.webflux.base-path`); `""` bez niej. */
  contextPath: string;
  /** Typy Javy i Kotlina z czytanych plików repo po prostej nazwie (interfejs z mapowaniami, który kontroler implementuje). */
  types: TypeIndex;
  /** Klucze konfiguracji (znormalizowane), z których kod wziął adres: nie są już osobnym klientem z konfiguracji. */
  usedKeys: Set<string>;
}

/** Typ z pliku po prostej nazwie; pierwszy w kolejności plików wygrywa. */
export type TypeIndex = Map<string, { type: JavaType; path: string }>;

/** Mapowanie z adnotacji: metody HTTP (`null`: każda) i ścieżki (`""`: bez ścieżki). */
export interface Mapping {
  methods: (HttpMethod | null)[];
  paths: string[];
  line: number;
}

/** Adnotacje mapowań Spring MVC i WebFlux z metodą, którą przesądzają (`null`: z atrybutu `method`). */
export const REQUEST_MAPPINGS: Readonly<Record<string, HttpMethod | null>> = {
  RequestMapping: null,
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  PatchMapping: "PATCH",
  DeleteMapping: "DELETE",
};

/** Adnotacje interfejsów HTTP Spring 6 (`@HttpExchange`). */
export const EXCHANGE_MAPPINGS: Readonly<Record<string, HttpMethod | null>> = {
  HttpExchange: null,
  GetExchange: "GET",
  PostExchange: "POST",
  PutExchange: "PUT",
  PatchExchange: "PATCH",
  DeleteExchange: "DELETE",
};

/** Mapowanie z pierwszej adnotacji z tabeli `table`; `undefined` bez takiej adnotacji. */
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

/** Adres w jednym profilu: wartość po rozwinięciu `${…}`, profile, w których ją ma, i wpis, z którego pochodzi. */
export interface UrlVariant {
  value: string;
  profiles: string[];
  source: { path: string; line: number } | null;
}

/**
 * Tekst adresu w każdym profilu modułu: najpierw profil domyślny, potem każdy profil, który daje inną wartość.
 * Tekst bez `${…}` jest jeden i bez profili (adres w kodzie). Użytkownik i hasło z adresu są zamaskowane, a zapytanie pominięte (§8). Klucze, z których adres pochodzi, trafiają do
 * `usedKeys`.
 */
export function urlVariants(module: SpringModule, text: string): UrlVariant[] {
  for (const key of placeholderKeys(text)) module.usedKeys.add(key);
  if (!text.includes("${")) return [{ value: withoutCredentials(text), profiles: [], source: null }];
  const variant = (profile: string): UrlVariant => {
    const { value, source } = module.config.resolve(text, profile);
    return { value: withoutCredentials(value), profiles: [profile], source: source ? { path: source.path, line: source.line } : null };
  };
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

/** Klucze z `${klucz}` i `${klucz:domyślna}` na najwyższym poziomie tekstu, znormalizowane jak w konfiguracji. */
function placeholderKeys(text: string): string[] {
  return [...text.matchAll(/\$\{([^:}$]{1,300})/g)].map((m) => (m[1] ?? "").toLowerCase().replace(/[-_]/g, ""));
}
