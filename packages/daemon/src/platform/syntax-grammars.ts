import { fileURLToPath } from "node:url";
import { runtimeInfo } from "./runtime.ts";

/**
 * Pliki WASM tree-sitter (§4.6, ADR-37): runtime parsera i gramatyki Javy i Kotlina. Pod Bun przychodzą importem
 * z atrybutem `type: "file"`, więc `bun build --compile` osadza je w binarce (ścieżka w `$bunfs`, czytana przez
 * `node:fs`); Node tego atrybutu nie zna, więc bierze te same pliki z `node_modules`.
 */
export interface GrammarFiles {
  runtime: string;
  java: string;
  kotlin: string;
}

let files: Promise<GrammarFiles> | undefined;

export function grammarFiles(): Promise<GrammarFiles> {
  files ??=
    runtimeInfo().name === "bun" ? import("./bun-grammar-files.ts").then((m) => m.bunGrammarFiles) : Promise.resolve(nodeGrammarFiles());
  return files;
}

function nodeGrammarFiles(): GrammarFiles {
  const path = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));
  return {
    runtime: path("web-tree-sitter/web-tree-sitter.wasm"),
    java: path("tree-sitter-java/tree-sitter-java.wasm"),
    kotlin: path("@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm"),
  };
}
