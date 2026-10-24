import type { Dto } from "@trackwall/protocol";
import type { Node } from "web-tree-sitter";

/**
 * Co plik Javy albo Kotlina mówi o kontraktach endpointów (ADR-38), odczytane z drzewa składni (`dto-java.ts`,
 * `dto-kotlin.ts`): deklaracje typów, które mogą być DTO, i typy ciała żądania i odpowiedzi metod. Same wartości,
 * bez węzłów, bo drzewo jest zwalniane po odczycie (`syntax-tree.ts`).
 */
export interface SourceSyntax {
  types: TypeDeclaration[];
  /** Metody po nazwie; z kilku metod o tej samej nazwie (przeciążenia) pierwsza. */
  methods: Map<string, MethodContract>;
}

export type TypeDeclaration = Omit<Dto, "evidence"> & { line: number };

export interface MethodContract {
  /** Typ parametru z `@RequestBody`. */
  request: string | null;
  /** Typ zwracany tak, jak w kodzie, z opakowaniami (`ResponseEntity<OrderDto>`). */
  returns: string | null;
}

/** Linia (od 1), w której zaczyna się węzeł. */
export function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

/** Ostatni człon nazwy adnotacji (`RequestBody` z `@org.springframework...RequestBody`). */
export function simpleName(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1);
}

/** Pierwsza metoda o nazwie wygrywa, jak w `TypeIndex` (§4.6). */
export function addMethod(methods: Map<string, MethodContract>, name: string | undefined, contract: MethodContract): void {
  if (name !== undefined && !methods.has(name)) methods.set(name, contract);
}
