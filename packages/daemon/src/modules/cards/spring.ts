import type { ConsumedHttp, ProvidedApp, ProvidedEndpoint } from "@trackwall/protocol";
import { configClients } from "./config-clients.ts";
import { declarativeClients } from "./declarative-clients.ts";
import { imperativeClients } from "./imperative-clients.ts";
import { ConstantTable } from "./java-expr.ts";
import { parseJavaFile } from "./java-source.ts";
import { type Extracted, emptyExtracted, type RepoSnapshot } from "./snapshot.ts";
import { isTestPath, ModuleConfig, moduleOf, readSpringConfigs } from "./spring-config.ts";
import { springEndpoints } from "./spring-endpoints.ts";
import type { SpringModule, TypeIndex } from "./spring-module.ts";
import type { JvmLanguage } from "./syntax-tree.ts";

/**
 * The Spring extractor (§4.6, ADR-30): for every module (the directory above `src/main`) the app from
 * `spring.application.name`, endpoints from controllers, and HTTP clients from Feign and `@HttpExchange` interfaces, from
 * `WebClient`, `RestClient` and `RestTemplate` calls and from addresses in the configuration, each fact with its file and
 * line. The code reads only the Java and Kotlin files the commit read chose by search (`JVM_SOURCE_PATTERN`), and does
 * not compile them.
 */

/**
 * The expression (ERE for `git grep`) the commit read uses to choose source files to read: mapping annotations, HTTP
 * clients and constants with a path. A file without any of them gives the extractor no facts, so it is not worth reading.
 * `ApiDelegate` brings in the classes implementing a delegate generated from an OpenAPI spec, which handle its operations (ADR-87).
 */
export const JVM_SOURCE_PATTERN =
  '@(RestController|Controller|RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|FeignClient|HttpExchange|GetExchange|PostExchange|PutExchange|PatchExchange|DeleteExchange)|WebClient|RestClient|RestTemplate|ApiDelegate|(final|const val)[[:space:]].*=[[:space:]]*"/';
/** The source file extensions the extractor reads. */
export const JVM_SOURCE_GLOBS = ["*.java", "*.kt"];

/**
 * A Java or Kotlin source file of app code: from `src/main/` at any depth (also a module in the `src/` directory, like
 * `src/orders/src/main/java`), and without `src/main/` only outside `src` directories (no tests).
 */
export function isJvmSource(path: string): boolean {
  if (path.length > 1024 || jvmLanguageOf(path) === null || isTestPath(path)) return false;
  const segments = path.split("/");
  return segments.some((s, i) => s === "src" && segments[i + 1] === "main") || !segments.includes("src");
}

/** The source file's language by extension; `null` for other files. */
export function jvmLanguageOf(path: string): JvmLanguage | null {
  return path.endsWith(".java") ? "java" : path.endsWith(".kt") ? "kotlin" : null;
}

/** Fakty ekstraktora Spring. */
type SpringFacts = Extracted<ProvidedApp | ProvidedEndpoint, ConsumedHttp>;

export function extractSpring(snapshot: RepoSnapshot): SpringFacts {
  const out: SpringFacts = emptyExtracted();
  const configs = readSpringConfigs(snapshot, out);
  // Type files fetched for contracts (ADR-38) do not change the HTTP facts: Spring reads only the files from the search.
  const files = snapshot.paths
    .filter((p) => isJvmSource(p) && !snapshot.typeFiles.has(p))
    .flatMap((path) => {
      const text = snapshot.text(path);
      return text === undefined ? [] : [parseJavaFile(path, text)];
    });
  const constants = new ConstantTable(files);
  const types: TypeIndex = new Map();
  for (const file of files) for (const type of file.types) if (!types.has(type.name)) types.set(type.name, { type, path: file.path });
  const dirs = [...new Set([...configs.keys(), ...files.map((f) => moduleOf(f.path))])].sort();
  for (const dir of dirs) {
    const module = springModule(configs.get(dir) ?? new ModuleConfig(dir, []), types);
    const app = providedApp(module);
    if (app) out.provides.push(app);
    const codeClients: ConsumedHttp[] = [];
    for (const file of files.filter((f) => moduleOf(f.path) === dir)) {
      const lookup = constants.lookupIn(file);
      out.provides.push(...springEndpoints(file, module, lookup));
      codeClients.push(...declarativeClients(file, module, lookup), ...imperativeClients(file, module, lookup));
    }
    // No `push(...list)`: a list from a large repo would exceed the call argument limit.
    for (const client of [...codeClients, ...configClients(module, codeClients, out)]) out.consumes.push(client);
  }
  return out;
}

function springModule(config: ModuleConfig, types: TypeIndex): SpringModule {
  return { config, ...appOf(config), types };
}

/** The module's app name and context path (`server.servlet.context-path`, `spring.webflux.base-path`). */
export function appOf(config: ModuleConfig): Pick<SpringModule, "app" | "contextPath"> {
  const contextPath = config.value("server.servlet.context-path") ?? config.value("spring.webflux.base-path") ?? "";
  return { app: config.value("spring.application.name") || null, contextPath };
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
