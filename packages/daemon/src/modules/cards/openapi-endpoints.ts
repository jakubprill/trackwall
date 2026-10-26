import {
  type CardProblem,
  httpPathSegments,
  joinHttpPath,
  type OpenApiOperation,
  type Provided,
  type ProvidedEndpoint,
} from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import { push } from "./call-types.ts";
import { ConstantTable } from "./java-expr.ts";
import { annotationNamed, parseJavaFile } from "./java-source.ts";
import { generates, type SpecGeneration, specGenerations } from "./openapi-generators.ts";
import { isSpecCandidate, mayBeSpec, type OpenApiSpec, readOpenApiSpec, type SpecOperation } from "./openapi-spec.ts";
import { baseName } from "./repo-path.ts";
import type { RepoSnapshot } from "./snapshot.ts";
import { appOf, isJvmSource } from "./spring.ts";
import { ModuleConfig, moduleOf, readSpringConfigs } from "./spring-config.ts";
import { mappingOf, REQUEST_MAPPINGS } from "./spring-module.ts";

/**
 * Endpoints from the OpenAPI specs in the repo (§4.6, ADR-87). A spec describes the repo's own API unless the build
 * generates a client from it (`openapi-generators.ts`). An operation that a mapping in the code matches (same method and
 * path, or a handler named like its `operationId`) adds its `operationId` and summary to that endpoint; any other
 * operation becomes an endpoint with source `openapi`: the usual case is a controller implementing an interface the
 * build generates from the spec into `target/`, which is not in the repo. Such an endpoint gets the controller method
 * named like the `operationId` as its handler, so its reach is traced like a mapped one (ADR-82).
 */

export interface OpenApiEndpoints {
  /** The `provides` facts in the same order, endpoints with the operations describing them, then the endpoints from specs only. */
  provides: Provided[];
  problems: CardProblem[];
}

/** Where a spec's operations run: the app, its context path and its configuration (for `${…}` in base paths). */
interface SpecTarget {
  app: string | null;
  contextPath: string;
  config: ModuleConfig;
}

interface ReadSpec {
  path: string;
  spec: OpenApiSpec;
  module: string;
  /** The server generation the build runs from this spec; `undefined` for a spec the build does not generate from. */
  generation: SpecGeneration | undefined;
}

export function withOpenApi(snapshot: RepoSnapshot, provides: readonly Provided[]): OpenApiEndpoints {
  const problems: CardProblem[] = [];
  const specs = ownSpecs(snapshot, problems);
  if (specs.length === 0) return { provides: [...provides], problems };
  // The Spring extractor reports problems of the configuration; here it only gives the app and the context path.
  const configs = readSpringConfigs(snapshot, { problems: [] });
  const handlers = new HandlerIndex(snapshot);
  const code = provides.filter((p): p is ProvidedEndpoint => p.kind === "endpoint");
  const described = new Map<ProvidedEndpoint, OpenApiOperation>();
  const added = new Map<string, ProvidedEndpoint>();
  for (const read of specs) {
    const target = specTarget(read.module, configs);
    const ofApp = code.filter((e) => e.app === target.app);
    for (const op of read.spec.operations) {
      const placed = placeOperation(read, target, op, ofApp, handlers);
      if (placed.kind === "mapped") {
        if (!described.has(placed.mapped)) described.set(placed.mapped, placed.operation);
        continue;
      }
      const key = `${target.app} ${op.method} ${placed.endpoint.path}`;
      if (!added.has(key)) added.set(key, placed.endpoint);
    }
  }
  const withOperations = provides.map((p) => (p.kind === "endpoint" ? { ...p, operation: described.get(p) ?? p.operation } : p));
  return { provides: [...withOperations, ...added.values()], problems };
}

/** The mapped endpoint an operation describes, or the endpoint it becomes when the code maps none. */
type Placed = { kind: "mapped"; mapped: ProvidedEndpoint; operation: OpenApiOperation } | { kind: "added"; endpoint: ProvidedEndpoint };

function placeOperation(
  read: ReadSpec,
  target: SpecTarget,
  op: SpecOperation,
  ofApp: readonly ProvidedEndpoint[],
  handlers: HandlerIndex,
): Placed {
  // With `interfaceOnly` the path depends on the handler's class mapping; otherwise the handler is needed only unmapped.
  const pathHandler = read.generation?.interfaceOnly ? handlers.handler(op.id, read.module) : undefined;
  const path = operationPath(read, target, op, pathHandler);
  const operation: OpenApiOperation = { id: op.id, summary: op.summary, evidence: { path: read.path, line: op.line } };
  const mapped = mappedEndpoint(op, path, ofApp);
  if (mapped) return { kind: "mapped", mapped, operation };
  const handler = pathHandler ?? handlers.handler(op.id, read.module);
  return { kind: "added", endpoint: specEndpoint(op, path, target, operation, handler?.handler ?? null) };
}

/**
 * The specs that describe this repo's API, each with the module whose app runs it. Only in a Java build: a frontend
 * keeps the specs of the backends it calls.
 */
function ownSpecs(snapshot: RepoSnapshot, problems: CardProblem[]): ReadSpec[] {
  if (!snapshot.paths.some(isJvmBuildFile)) return [];
  const files = snapshot.paths.filter((p) => isSpecCandidate(p) && mayBeSpec(snapshot.text(p) ?? ""));
  if (files.length === 0) return [];
  const generations = specGenerations(snapshot);
  return files.flatMap((path) => {
    const own = generations.filter((g) => generates(g, path));
    const generation = own.find((g) => g.server);
    if (own.length > 0 && generation === undefined) return [];
    const spec = readSpec(snapshot, path, problems);
    return spec ? [{ path, spec, module: generation?.module ?? moduleOf(path), generation }] : [];
  });
}

function isJvmBuildFile(path: string): boolean {
  const name = baseName(path);
  return name === "pom.xml" || name.startsWith("build.gradle");
}

function readSpec(snapshot: RepoSnapshot, path: string, problems: CardProblem[]): OpenApiSpec | undefined {
  const text = snapshot.text(path);
  if (text === undefined) return undefined;
  try {
    const spec = readOpenApiSpec(text);
    if (spec?.truncated)
      problems.push({
        code: "truncated",
        path,
        message: `the spec has more operations than the card keeps; the first ${spec.operations.length} are on it`,
      });
    return spec;
  } catch (err) {
    problems.push({ code: "file-invalid", path, message: messageOf(err) });
    return undefined;
  }
}

/**
 * The app of the spec's module; a spec outside any module with an app (`api/orders.yaml` in the root) belongs to the
 * repo's only app, when it has exactly one.
 */
function specTarget(module: string, configs: ReadonlyMap<string, ModuleConfig>): SpecTarget {
  const withApp = [...configs.values()].filter((c) => appOf(c).app !== null);
  // Without a configuration, as in the Spring extractor, an empty one: `${key:default}` still gives the default.
  const config = configs.get(module) ?? (withApp.length === 1 ? withApp[0] : undefined) ?? new ModuleConfig(module, []);
  return { ...appOf(config), config };
}

/**
 * Where the app serves an operation, checked on real builds of the OpenAPI generator (ADR-87): with `interfaceOnly` the
 * generated interface maps the bare path from `paths`, under the mapping of the controller implementing it; otherwise
 * the generated controller puts `${openapi.<title>.base-path:<server path>}` in front. A spec the build does not generate
 * from documents the API, so its server path counts, and the context path goes in front unless that path already has it.
 */
function operationPath(read: ReadSpec, target: SpecTarget, op: SpecOperation, handler: Handler | undefined): string {
  const { generation, spec } = read;
  const resolve = (text: string) => target.config.resolve(text).value;
  if (generation?.interfaceOnly) return joinHttpPath(target.contextPath, resolve(handler?.prefix ?? ""), op.path);
  if (generation === undefined) return withContextPath(target.contextPath, joinHttpPath(spec.basePath, op.path));
  const base = spec.title === null ? spec.basePath : resolve(`\${openapi.${methodName(spec.title)}.base-path:${spec.basePath}}`);
  return joinHttpPath(target.contextPath, base, op.path);
}

/** The operation path with the app's context path in front, unless the spec's server address already has it. */
function withContextPath(contextPath: string, path: string): string {
  const context = joinHttpPath(contextPath);
  return context === "/" || path === context || path.startsWith(`${context}/`) ? path : joinHttpPath(context, path);
}

/**
 * The endpoint mapped in the code that the operation describes: the one with the same method and path (variable names
 * aside), else the only one whose handler is named like the `operationId` (the spec's base path may differ from the
 * code's); `undefined` when none is, or several share a name (`list`, `get`), since a name alone cannot tell them apart.
 */
function mappedEndpoint(op: SpecOperation, path: string, endpoints: readonly ProvidedEndpoint[]): ProvidedEndpoint | undefined {
  const candidates = endpoints.filter((e) => e.method === null || e.method === op.method);
  const segments = httpPathSegments(path);
  const byPath = candidates.find((e) => samePath(segments, httpPathSegments(e.path)));
  if (byPath || op.id === null) return byPath;
  const name = `.${methodName(op.id)}`;
  const named = candidates.filter((e) => e.handler?.endsWith(name));
  return named.length === 1 ? named[0] : undefined;
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i] || (isVariable(s) && isVariable(b[i] ?? "")));
}

function isVariable(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

function specEndpoint(
  op: SpecOperation,
  path: string,
  target: SpecTarget,
  operation: OpenApiOperation,
  handler: string | null,
): ProvidedEndpoint {
  return {
    kind: "endpoint",
    source: "openapi",
    method: op.method,
    path,
    app: target.app,
    handler,
    request: op.request,
    response: op.response,
    // `endpoint-reach.ts` adds the calls the handler reaches (ADR-82).
    reaches: null,
    operation,
    evidence: operation.evidence,
  };
}

/**
 * The method name the OpenAPI generator gives an operation: the `operationId` in camelCase, with characters other than
 * letters and digits separating words (`get-order` and `get_order` → `getOrder`, `GetOrder` → `getOrder`).
 */
export function methodName(operationId: string): string {
  const words = operationId.split(/[^A-Za-z0-9]+/).filter((w) => w !== "");
  return words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() : w.charAt(0).toUpperCase()) + w.slice(1)).join("");
}

/**
 * Controller methods without a mapping of their own, by name: a controller implementing a generated interface (the
 * mappings are in the interface) or a class implementing a generated `…ApiDelegate`. Read only when a spec needs a
 * handler: an operation without a mapping in the code, or an `interfaceOnly` spec whose paths start with its controller's.
 */
class HandlerIndex {
  private readonly snapshot: RepoSnapshot;
  private byName: Map<string, Handler[]> | undefined;

  constructor(snapshot: RepoSnapshot) {
    this.snapshot = snapshot;
  }

  /**
   * The handler of the operation in the spec's module; `undefined` without an id, without such a method, or with several.
   * Another module's method would be another app's handler, and its reach would be looked up by the wrong class.
   */
  handler(operationId: string | null, module: string): Handler | undefined {
    if (operationId === null) return undefined;
    const inModule = (this.index().get(methodName(operationId)) ?? []).filter((h) => h.module === module);
    return inModule.length === 1 ? inModule[0] : undefined;
  }

  private index(): Map<string, Handler[]> {
    if (this.byName) return this.byName;
    const byName = new Map<string, Handler[]>();
    for (const path of this.snapshot.paths) {
      const text = isJvmSource(path) && !this.snapshot.typeFiles.has(path) ? this.snapshot.text(path) : undefined;
      if (text === undefined || !/Controller|ApiDelegate/.test(text)) continue;
      for (const [name, handler] of unmappedHandlers(path, text)) push(byName, name, handler);
    }
    this.byName = byName;
    return byName;
  }
}

/** A controller method that can handle an operation (`Class.method`), the module of its file and its class's mapping path. */
interface Handler {
  handler: string;
  module: string;
  /** The first path of the class's own `@RequestMapping`, as written (`${…}` not expanded yet); `""` without one. */
  prefix: string;
}

/** The methods without a mapping of the file's controllers and `…ApiDelegate` implementations, by method name. */
function unmappedHandlers(path: string, text: string): [string, Handler][] {
  const file = parseJavaFile(path, text);
  const lookup = new ConstantTable([file]).lookupIn(file);
  return file.types
    .filter((t) => annotationNamed(t.annotations, "RestController", "Controller") || t.supertypes.some((s) => s.endsWith("ApiDelegate")))
    .flatMap((type) => {
      const prefix = mappingOf(type.annotations, REQUEST_MAPPINGS, lookup)?.paths[0] ?? "";
      return type.methods
        .filter((m) => !m.annotations.some((a) => Object.hasOwn(REQUEST_MAPPINGS, a.name)))
        .map((m): [string, Handler] => [m.name, { handler: `${type.name}.${m.name}`, module: moduleOf(path), prefix }]);
    });
}
