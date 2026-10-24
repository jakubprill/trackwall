import { readFile } from "node:fs/promises";
import { Language, type Node, Parser } from "web-tree-sitter";
import { grammarFiles } from "../../platform/syntax-grammars.ts";

/**
 * Drzewa składni Javy i Kotlina z tree-sitter (§4.6, ADR-37) dla ekstraktorów, którym nie wystarczają tokeny
 * (`java-tokens.ts`): typy parametrów i pól, rekordy, `data class`. Parser działa w WASM w procesie daemona, bez
 * kompilacji repo i bez natywnego addonu. Kod niepoprawny składniowo daje drzewo z węzłami `ERROR`, nie wyjątek.
 */
export type JvmLanguage = "java" | "kotlin";

let parsers: Promise<Record<JvmLanguage, Parser>> | undefined;

/**
 * Daje `read` korzeń drzewa pliku i zwraca jego wynik. Drzewo żyje w pamięci WASM, której nie sprząta GC, więc jest
 * zwalniane zaraz po `read`: węzły nie mogą z niego wyjść, tylko wartości z nich odczytane.
 */
export async function readSyntaxTree<T>(language: JvmLanguage, text: string, read: (root: Node) => T): Promise<T> {
  const parser = (await loadParsers())[language];
  const tree = parser.parse(text);
  if (!tree) throw new Error(`tree-sitter nie zwrócił drzewa pliku (${language})`);
  try {
    return read(tree.rootNode);
  } finally {
    tree.delete();
  }
}

function loadParsers(): Promise<Record<JvmLanguage, Parser>> {
  parsers ??= createParsers();
  return parsers;
}

async function createParsers(): Promise<Record<JvmLanguage, Parser>> {
  const files = await grammarFiles();
  // Runtime dostaje bajty zamiast ścieżki, bo sam szukałby pliku obok swojego skryptu, którego w binarce nie ma.
  await Parser.init({ wasmBinary: await readFile(files.runtime) });
  const parserFor = async (path: string) => {
    const parser = new Parser();
    parser.setLanguage(await Language.load(new Uint8Array(await readFile(path))));
    return parser;
  };
  return { java: await parserFor(files.java), kotlin: await parserFor(files.kotlin) };
}
