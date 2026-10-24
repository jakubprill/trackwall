import { type Language, Node, Parser } from "web-tree-sitter";
import { type JvmGrammars, loadJvmGrammars } from "../../platform/tree-sitter.ts";

/**
 * Drzewa składni Javy i Kotlina z tree-sitter (§4.6, ADR-37) dla ekstraktorów, którym nie wystarczają tokeny
 * (`java-tokens.ts`): typy parametrów i pól, rekordy, `data class`. Parser działa w WASM w procesie daemona, bez
 * kompilacji repo i bez natywnego addonu. Kod niepoprawny składniowo daje drzewo z węzłami `ERROR`, nie wyjątek.
 */
type JvmLanguage = "java" | "kotlin";

/**
 * Najdłuższe parsowanie jednego pliku. Parser działa synchronicznie w wątku daemona, a gramatyka Kotlina na
 * złośliwym wejściu rośnie w czasie szybciej niż liniowo (plik 96 KB to kilka sekund), więc plik z repo (§8)
 * nie może zatrzymać API dłużej niż na tyle.
 */
export const PARSE_TIME_LIMIT_MS = 1000;

/** Wynik odczytu drzewa; `timeout`, gdy parsowanie pliku przekroczyło `PARSE_TIME_LIMIT_MS` i drzewa nie ma. */
type SyntaxRead<T> = { kind: "parsed"; value: T } | { kind: "timeout" };

export interface SyntaxParsers {
  /**
   * Daje `read` korzeń drzewa pliku i zwraca jego wynik. Drzewo żyje w pamięci WASM, której nie sprząta GC, i jest
   * zwalniane zaraz po `read`, więc `read` jest synchroniczne i zwraca wartości odczytane z węzłów, nie węzły.
   */
  read<T>(language: JvmLanguage, text: string, read: (root: Node) => T): SyntaxRead<T>;
}

/** Parsery obu języków; ładowanie gramatyk to jedyna asynchroniczna część, więc ekstraktory zostają synchroniczne. */
export async function loadSyntaxParsers(): Promise<SyntaxParsers> {
  return syntaxParsers(await loadJvmGrammars());
}

function syntaxParsers(grammars: JvmGrammars): SyntaxParsers {
  const parsers = { java: parserFor(grammars.java), kotlin: parserFor(grammars.kotlin) };
  return {
    read(language, text, read) {
      const parser = parsers[language];
      const deadline = performance.now() + PARSE_TIME_LIMIT_MS;
      const tree = parser.parse(text, null, { progressCallback: () => performance.now() > deadline });
      if (!tree) {
        // Bez `reset` następne `parse` wznowiłoby przerwany plik.
        parser.reset();
        return { kind: "timeout" };
      }
      try {
        return { kind: "parsed", value: checkedResult(read(tree.rootNode)) };
      } finally {
        tree.delete();
      }
    },
  };
}

function parserFor(language: Language): Parser {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

/**
 * Węzeł albo obietnica sięgnęłyby do drzewa po `delete`, a WASM oddałby wtedy cudze dane zamiast błędu. Sprawdzany
 * jest tylko sam wynik: węzeł w tablicy albo w polu obiektu (`root.children`) przechodzi, więc tego pilnuje przegląd.
 */
function checkedResult<T>(result: T): T {
  if (result instanceof Node || result instanceof Promise) {
    throw new Error("syntax tree reader must return plain values, not a tree node or a promise");
  }
  return result;
}
