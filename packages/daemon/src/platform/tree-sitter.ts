import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import { runtimeInfo } from "./runtime.ts";

/**
 * The tree-sitter runtime in WASM and the Java and Kotlin grammars (§4.6, ADR-37). Under Bun the `.wasm` files come by an import
 * with the attribute `type: "file"`, so `bun build --compile` embeds them in the binary (a path in `$bunfs`, read through
 * `node:fs`); Node does not know that attribute, so it takes the same files from `node_modules`.
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

// `Parser.init` replaces the WASM module of the whole library, so it may run once per process; a failed load
// is not remembered, so that the next call tries again.
let loading: Promise<JvmGrammars> | undefined;

export function loadJvmGrammars(): Promise<JvmGrammars> {
  loading ??= load().catch((err: unknown) => {
    loading = undefined;
    throw err;
  });
  return loading;
}

/** The WASM files of the current runtime: embedded in a binary (`isInBinary`), from `node_modules` outside it. */
export async function grammarFiles(): Promise<GrammarFiles> {
  return runtimeInfo().name === "bun" ? (await import("./bun-grammar-files.ts")).bunGrammarFiles : nodeGrammarFiles();
}

async function load(): Promise<JvmGrammars> {
  const files = await grammarFiles();
  // The runtime gets bytes instead of a path, because it would look for the file next to its own script, which a binary does not have.
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
