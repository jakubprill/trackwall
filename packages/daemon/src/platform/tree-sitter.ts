import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import { runtimeInfo } from "./runtime.ts";

/**
 * Runtime tree-sitter w WASM i gramatyki Javy i Kotlina (§4.6, ADR-37). Pod Bun pliki `.wasm` przychodzą importem
 * z atrybutem `type: "file"`, więc `bun build --compile` osadza je w binarce (ścieżka w `$bunfs`, czytana przez
 * `node:fs`); Node tego atrybutu nie zna, więc bierze te same pliki z `node_modules`.
 */
export interface GrammarFiles {
  runtime: string;
  java: string;
  kotlin: string;
}

export interface JvmGrammars {
  java: Language;
  kotlin: Language;
}

// `Parser.init` podmienia moduł WASM całej biblioteki, więc może się wykonać raz na proces; nieudane ładowanie
// nie zostaje zapamiętane, żeby następne pytanie spróbowało od nowa.
let loading: Promise<JvmGrammars> | undefined;

export function loadJvmGrammars(): Promise<JvmGrammars> {
  loading ??= load().catch((err: unknown) => {
    loading = undefined;
    throw err;
  });
  return loading;
}

/** Pliki WASM bieżącego runtime'u: w binarce osadzone (`isInBinary`), poza nią z `node_modules`. */
export async function grammarFiles(): Promise<GrammarFiles> {
  return runtimeInfo().name === "bun" ? (await import("./bun-grammar-files.ts")).bunGrammarFiles : nodeGrammarFiles();
}

async function load(): Promise<JvmGrammars> {
  const files = await grammarFiles();
  // Runtime dostaje bajty zamiast ścieżki, bo sam szukałby pliku obok swojego skryptu, którego w binarce nie ma.
  await Parser.init({ wasmBinary: await readFile(files.runtime) });
  const language = async (path: string) => Language.load(new Uint8Array(await readFile(path)));
  return { java: await language(files.java), kotlin: await language(files.kotlin) };
}

function nodeGrammarFiles(): GrammarFiles {
  const path = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));
  return {
    runtime: path("web-tree-sitter/web-tree-sitter.wasm"),
    java: path("tree-sitter-java/tree-sitter-java.wasm"),
    kotlin: path("@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm"),
  };
}
