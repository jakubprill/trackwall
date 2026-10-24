import type { Dto } from "@trackwall/protocol";
import type { Node } from "web-tree-sitter";

/**
 * Co plik Javy albo Kotlina mówi o kontraktach endpointów (ADR-38), odczytane z drzewa składni (`contract-java.ts`,
 * `contract-kotlin.ts`): deklaracje typów, które mogą być DTO, i typy ciała żądania i odpowiedzi metod. Same wartości,
 * bez węzłów, bo drzewo jest zwalniane po odczycie (`syntax-tree.ts`).
 */
export interface SourceSyntax {
  types: TypeDeclaration[];
  /** Metody i funkcje pliku w kolejności w kodzie, także z typów zagnieżdżonych. */
  methods: MethodContract[];
}

type WithoutEvidence<T> = T extends unknown ? Omit<T, "evidence"> : never;

/** DTO bez dowodu (ścieżkę zna dopiero karta) z linią nazwy typu. */
export type TypeDeclaration = WithoutEvidence<Dto> & { line: number };

export interface MethodContract {
  name: string;
  /** Linie (od 1) od pierwszej adnotacji do końca ciała: w nich leży linia mapowania endpointu. */
  startLine: number;
  endLine: number;
  /** Typ parametru z `@RequestBody` w zapisie typu (`typeText`). */
  request: string | null;
  /** Typ zwracany w zapisie typu, z opakowaniami (`ResponseEntity<OrderDto>`). */
  returns: string | null;
}

/** Linia (od 1), w której zaczyna się węzeł. */
export function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

/** Linie metody `node` dla `MethodContract`. */
export function linesOf(node: Node): Pick<MethodContract, "startLine" | "endLine"> {
  return { startLine: lineOf(node), endLine: node.endPosition.row + 1 };
}

/** Ostatni człon nazwy kwalifikowanej (`RequestBody` z `org.springframework...RequestBody`). */
export function simpleName(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1);
}

/** Węzły adnotacji obu gramatyk: w zapisie typu (`List<@Valid Line>`) nie są częścią typu. */
const ANNOTATIONS = new Set(["annotation", "marker_annotation"]);
/** Słowo przed liściem albo `?` wildcardu Javy (`? extends Line`). */
const WORD_END = /[\w$?]$/;
const WORD_START = /^[\w$]/;

/**
 * Zapis typu z węzła: tekst liści bez adnotacji i komentarzy, ze spacją tylko przed słowem po słowie albo `?`
 * (`List<? extends Line>`, `Map<String,Line>`), więc ten sam typ ma ten sam zapis niezależnie od formatowania kodu.
 */
export function typeText(node: Node): string {
  let text = "";
  // Stos zamiast rekurencji: typ z repo może być zagnieżdżony głębiej, niż sięga stos wywołań.
  const stack = [node];
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    if (ANNOTATIONS.has(n.type) || n.type.includes("comment")) continue;
    if (n.childCount > 0) {
      stack.push(...n.children.toReversed());
      continue;
    }
    if (WORD_END.test(text) && WORD_START.test(n.text)) text += " ";
    text += n.text;
  }
  return text;
}
