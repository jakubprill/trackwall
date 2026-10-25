import { joinHttpPath, type ProvidedEndpoint } from "@trackwall/protocol";
import type { Lookup } from "./java-expr.ts";
import { annotationNamed, type JavaFile, type JavaMethod, type JavaType } from "./java-source.ts";
import { type Mapping, mappingOf, REQUEST_MAPPINGS, type SpringModule } from "./spring-module.ts";

/**
 * HTTP endpoints from Spring controllers (§4.6, ADR-30): a class with `@RestController` or `@Controller`, the prefix from
 * the class's `@RequestMapping` and methods with `@GetMapping`, `@PostMapping`… Mappings from an interface the controller
 * implements (the "API first" style, a generated or shared interface) count as its own, unless the controller maps a
 * method with the same name itself. The full path starts with the app's context path.
 */

/**
 * At most this many paths from one method (the product of class paths, method paths and HTTP methods): an array from
 * the repo does not grow without end.
 */
const MAX_PER_METHOD = 20;

export function springEndpoints(file: JavaFile, module: SpringModule, lookup: Lookup): ProvidedEndpoint[] {
  return file.types.flatMap((type) =>
    annotationNamed(type.annotations, "RestController", "Controller") ? controller(type, file, module, lookup) : [],
  );
}

function controller(type: JavaType, file: JavaFile, module: SpringModule, lookup: Lookup): ProvidedEndpoint[] {
  const parents = type.supertypes.flatMap((name) => {
    const parent = module.types.get(name);
    return parent?.type.keyword === "interface" ? [parent] : [];
  });
  const prefix =
    mappingOf(type.annotations, REQUEST_MAPPINGS, lookup) ??
    parents.map((p) => mappingOf(p.type.annotations, REQUEST_MAPPINGS, lookup)).find((m) => m);
  const own = type.methods.map((method) => ({ method, path: file.path, mapping: mappingOf(method.annotations, REQUEST_MAPPINGS, lookup) }));
  const mapped = new Set(own.filter((m) => m.mapping).map((m) => m.method.name));
  const inherited = parents.flatMap((p) =>
    p.type.methods
      .filter((method) => !mapped.has(method.name))
      .map((method) => ({ method, path: p.path, mapping: mappingOf(method.annotations, REQUEST_MAPPINGS, lookup) })),
  );
  return [...own, ...inherited].flatMap(({ method, path, mapping }) =>
    mapping ? endpointsOf(type, method, { prefix, mapping, path }, module) : [],
  );
}

interface MethodMapping {
  prefix: Mapping | undefined;
  mapping: Mapping;
  /** The method's file: the controller's or that of the interface it inherits the method from. */
  path: string;
}

function endpointsOf(type: JavaType, method: JavaMethod, m: MethodMapping, module: SpringModule): ProvidedEndpoint[] {
  const prefixes = m.prefix?.paths ?? [""];
  // `/items` and `/items/` are the same path once joined: one endpoint, not two.
  const found = new Map<string, ProvidedEndpoint>();
  for (const prefix of prefixes)
    for (const path of m.mapping.paths)
      for (const httpMethod of m.mapping.methods) {
        const full = joinHttpPath(module.contextPath, prefix, path);
        found.set(`${httpMethod} ${full}`, {
          kind: "endpoint",
          method: httpMethod,
          path: full,
          app: module.app,
          handler: `${type.name}.${method.name}`,
          // `endpoint-contracts.ts` adds the contract types from the syntax tree (ADR-38); the tokens do not know them.
          request: null,
          response: null,
          evidence: { path: m.path, line: m.mapping.line },
        });
      }
  return [...found.values()].slice(0, MAX_PER_METHOD);
}
