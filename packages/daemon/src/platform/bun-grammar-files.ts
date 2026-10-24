import kotlin from "@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm" with { type: "file" };
import java from "tree-sitter-java/tree-sitter-java.wasm" with { type: "file" };
import runtime from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };
import type { GrammarFiles } from "./tree-sitter.ts";

/** Pliki WASM tree-sitter pod Bun: w binarce z `bun build --compile` osadzone, w trybie deweloperskim z `node_modules`. */
export const bunGrammarFiles: GrammarFiles = { runtime, java, kotlin };
