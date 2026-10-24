import type { ConsumedHttp, ProvidedApp, ProvidedEndpoint } from "@trackwall/protocol";
import { configClients } from "./config-clients.ts";
import { declarativeClients } from "./declarative-clients.ts";
import { imperativeClients } from "./imperative-clients.ts";
import { ConstantTable } from "./java-expr.ts";
import { type JavaFile, parseJavaFile } from "./java-source.ts";
import { type Extracted, emptyExtracted, type RepoSnapshot } from "./snapshot.ts";
import { ModuleConfig, moduleOf, readSpringConfigs } from "./spring-config.ts";
import { springEndpoints } from "./spring-endpoints.ts";
import type { SpringModule, TypeIndex } from "./spring-module.ts";

/**
 * Ekstraktor Spring (§4.6, ADR-30): dla każdego modułu (katalog nad `src/main`) aplikacja z `spring.application.name`,
 * endpointy z kontrolerów i klienci HTTP z interfejsów Feign i `@HttpExchange`, z wywołań `WebClient`, `RestClient`
 * i `RestTemplate` oraz z adresów w konfiguracji, każdy fakt z plikiem i linią. Kod czyta tylko pliki Javy i Kotlina,
 * które odczyt commita wybrał wyszukiwaniem (`JVM_SOURCE_PATTERN`), i nie kompiluje ich.
 */

/**
 * Wyrażenie (ERE dla `git grep`), którym odczyt commita wybiera pliki źródłowe do przeczytania: adnotacje mapowań,
 * klienci HTTP i stałe ze ścieżką. Plik bez żadnego z nich nie daje ekstraktorowi faktów, więc nie warto go czytać.
 */
export const JVM_SOURCE_PATTERN =
  "@(RestController|Controller|RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|FeignClient|HttpExchange|GetExchange|PostExchange|PutExchange|PatchExchange|DeleteExchange)|WebClient|RestClient|RestTemplate|(final|const val)[[:space:]].*=[[:space:]]*\"/";
/** Rozszerzenia plików źródłowych, które czyta ekstraktor. */
export const JVM_SOURCE_GLOBS = ["*.java", "*.kt"];

/** Plik źródłowy Javy albo Kotlina z kodu aplikacji: pod `src/` tylko z `src/main/`, bez testów. */
export function isJvmSource(path: string): boolean {
  if (path.length > 1024 || !(path.endsWith(".java") || path.endsWith(".kt"))) return false;
  const segments = path.split("/");
  const src = segments.indexOf("src");
  return src < 0 || segments[src + 1] === "main";
}

/** Fakty ekstraktora Spring. */
type SpringFacts = Extracted<ProvidedApp | ProvidedEndpoint, ConsumedHttp>;

export function extractSpring(snapshot: RepoSnapshot): SpringFacts {
  const out: SpringFacts = emptyExtracted();
  const configs = readSpringConfigs(snapshot, out);
  const files = snapshot.paths.filter(isJvmSource).flatMap((path) => {
    const text = snapshot.text(path);
    return text === undefined ? [] : [parseJavaFile(path, text)];
  });
  const constants = new ConstantTable(files);
  const types: TypeIndex = new Map();
  for (const file of files) for (const type of file.types) if (!types.has(type.name)) types.set(type.name, { type, path: file.path });
  const dirs = [...new Set([...configs.keys(), ...files.map((f) => moduleOf(f.path))])].sort();
  for (const dir of dirs) {
    const module = springModule(dir, configs.get(dir) ?? new ModuleConfig(dir, []), types);
    const app = providedApp(module);
    if (app) out.provides.push(app);
    for (const file of files.filter((f) => moduleOf(f.path) === dir)) extractFile(file, module, constants, out);
    out.consumes.push(...configClients(module));
  }
  return out;
}

function extractFile(file: JavaFile, module: SpringModule, constants: ConstantTable, out: SpringFacts): void {
  const lookup = constants.lookupIn(file);
  out.provides.push(...springEndpoints(file, module, lookup));
  out.consumes.push(...declarativeClients(file, module, lookup), ...imperativeClients(file, module, lookup));
}

function springModule(dir: string, config: ModuleConfig, types: TypeIndex): SpringModule {
  const contextPath = config.value("server.servlet.context-path") ?? config.value("spring.webflux.base-path") ?? "";
  return { config, app: config.value("spring.application.name") || null, contextPath, types, usedKeys: new Set() };
}

function providedApp(module: SpringModule): ProvidedApp | undefined {
  const entry = module.config.entry("spring.application.name");
  if (!module.app || !entry) return undefined;
  const port = Number(module.config.value("server.port"));
  return {
    kind: "app",
    name: module.app,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : null,
    module: module.config.module,
    evidence: { path: entry.path, line: entry.line },
  };
}
