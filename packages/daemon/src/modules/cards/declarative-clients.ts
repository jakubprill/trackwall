import { type ConsumedHttp, type HttpCall, joinHttpPath, parseHttpUrl } from "@trackwall/protocol";
import { annotationArgs, type Lookup, stringValues } from "./java-expr.ts";
import { annotationNamed, type JavaFile, type JavaType } from "./java-source.ts";
import { normalizeKey } from "./spring-config.ts";
import { EXCHANGE_MAPPINGS, httpClients, type Mapping, mappingOf, REQUEST_MAPPINGS, type SpringModule } from "./spring-module.ts";

/**
 * Klienci HTTP z interfejsów (§4.6, ADR-30): `@FeignClient` (nazwa aplikacji z `name`/`value`, adres z `url` albo
 * z `spring.cloud.openfeign.client.config.<klient>.url`, prefiks z `path` i z `@RequestMapping` interfejsu) oraz
 * interfejsy `@HttpExchange` Spring 6 (adres bazowy ustawia kod konfiguracji, więc tu tylko ścieżki). Wywołania to
 * metody z mapowaniami.
 */

/** Klucze adresu klienta Feign w konfiguracji: Spring Cloud OpenFeign 4 i starsze `feign.client`. */
const FEIGN_URL_KEYS = ["spring.cloud.openfeign.client.config.{}.url", "feign.client.config.{}.url"];

export function declarativeClients(file: JavaFile, module: SpringModule, lookup: Lookup): ConsumedHttp[] {
  return file.types.flatMap((type) => {
    if (type.keyword !== "interface") return [];
    if (annotationNamed(type.annotations, "FeignClient")) return feignClient(type, file, module, lookup);
    return httpInterface(type, file, module, lookup);
  });
}

function feignClient(type: JavaType, file: JavaFile, module: SpringModule, lookup: Lookup): ConsumedHttp[] {
  const annotation = annotationNamed(type.annotations, "FeignClient");
  const args = annotationArgs(annotation?.args ?? null);
  const first = (key: string) => stringValues(args.get(key), lookup)[0];
  const nameText = first("value") ?? first("name") ?? first("serviceId");
  const app = nameText === undefined ? null : module.config.resolve(nameText).value || null;
  const urlText = first("url") || configuredUrl(module, first("contextId") ?? app);
  const prefix = joinHttpPath(first("path") ?? "", mappingOf(type.annotations, REQUEST_MAPPINGS, lookup)?.paths[0] ?? "");
  const calls = methodCalls(type, file, REQUEST_MAPPINGS, lookup, prefix);
  const evidence = { path: file.path, line: annotation?.line ?? type.line };
  return httpClients(module, urlText, { via: "feign", name: type.name, app, calls, evidence });
}

/** `${…}` klucza adresu klienta Feign w konfiguracji, gdy któryś profil go ma; `undefined` bez wpisu. */
function configuredUrl(module: SpringModule, client: string | null | undefined): string | undefined {
  if (!client) return undefined;
  const key = FEIGN_URL_KEYS.map((k) => k.replace("{}", client)).find((k) => module.config.keys().has(normalizeKey(k)));
  return key && `\${${key}}`;
}

/** Interfejs HTTP Spring 6: `@HttpExchange` na interfejsie albo `@GetExchange`… na metodach. */
function httpInterface(type: JavaType, file: JavaFile, module: SpringModule, lookup: Lookup): ConsumedHttp[] {
  const classLevel = mappingOf(type.annotations, EXCHANGE_MAPPINGS, lookup);
  const base = classLevel?.paths[0] ?? "";
  const absolute = parseHttpUrl(module.config.resolve(base).value) !== undefined;
  const calls = methodCalls(type, file, EXCHANGE_MAPPINGS, lookup, absolute ? "" : base);
  if (calls.length === 0) return [];
  const evidence = { path: file.path, line: classLevel?.line ?? type.line };
  return httpClients(module, absolute ? base : undefined, { via: "http-interface", name: type.name, app: null, calls, evidence });
}

function methodCalls(
  type: JavaType,
  file: JavaFile,
  table: Readonly<Record<string, Mapping["methods"][number]>>,
  lookup: Lookup,
  prefix: string,
): HttpCall[] {
  const calls: HttpCall[] = [];
  for (const method of type.methods) {
    const mapping = mappingOf(method.annotations, table, lookup);
    if (!mapping) continue;
    for (const path of mapping.paths)
      for (const httpMethod of mapping.methods)
        calls.push({ method: httpMethod, path: joinHttpPath(prefix, path), evidence: { path: file.path, line: mapping.line } });
  }
  return calls;
}
