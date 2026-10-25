import kotlin from "@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm" with { type: "file" };
import java from "tree-sitter-java/tree-sitter-java.wasm" with { type: "file" };
import runtime from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };
import type { GrammarFiles } from "./tree-sitter.ts";

/** tree-sitter WASM files under Bun: embedded in a binary from `bun build --compile`, from `node_modules` in development mode. */
export const bunGrammarFiles: GrammarFiles = { runtime, java, kotlin };
