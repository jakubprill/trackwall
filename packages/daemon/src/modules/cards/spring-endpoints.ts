import { joinHttpPath, type ProvidedEndpoint } from "@trackwall/protocol";
import type { Lookup } from "./java-expr.ts";
import { annotationNamed, type JavaFile, type JavaMethod, type JavaType } from "./java-source.ts";
import { type Mapping, mappingOf, REQUEST_MAPPINGS, type SpringModule } from "./spring-module.ts";

/**
 * Endpointy HTTP z kontrolerów Spring (§4.6, ADR-30): klasa z `@RestController` albo `@Controller`, prefiks
 * z `@RequestMapping` klasy i metody z `@GetMapping`, `@PostMapping`… Mapowania z interfejsu, który kontroler
 * implementuje (styl „API first”, interfejs wygenerowany albo wspólny), liczą się jak własne, chyba że kontroler
 * mapuje metodę o tej samej nazwie sam. Pełna ścieżka zaczyna się od ścieżki kontekstu aplikacji.
 */

/** Najwięcej ścieżek z jednej metody (iloczyn ścieżek klasy, metody i metod HTTP): tablica z repo nie urośnie bez końca. */
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
  /** Plik metody: kontrolera albo interfejsu, z którego ją dziedziczy. */
  path: string;
}

function endpointsOf(type: JavaType, method: JavaMethod, m: MethodMapping, module: SpringModule): ProvidedEndpoint[] {
  const prefixes = m.prefix?.paths ?? [""];
  // `/items` i `/items/` to po złączeniu ta sama ścieżka: jeden endpoint, nie dwa.
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
          evidence: { path: m.path, line: m.mapping.line },
        });
      }
  return [...found.values()].slice(0, MAX_PER_METHOD);
}
