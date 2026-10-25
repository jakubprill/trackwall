/**
 * A probe of the tree-sitter parser (ADR-37) run by `syntax-tree.test.ts` under Bun, under Node and as a binary
 * from `bun build --compile`: `<java|kotlin> <code>` prints JSON with the code's syntax tree and whether the WASM files
 * are inside the binary.
 */
import { loadSyntaxParsers } from "../../src/modules/cards/syntax-tree.ts";
import { isInBinary } from "../../src/platform/runtime.ts";
import { grammarFiles } from "../../src/platform/tree-sitter.ts";

const [language, source] = process.argv.slice(2);
if ((language !== "java" && language !== "kotlin") || source === undefined) throw new Error("usage: <java|kotlin> <code>");
const result = (await loadSyntaxParsers()).read(language, source, (root) => root.toString());
const tree = result.kind === "parsed" ? result.value : result.kind;
const embedded = Object.values(await grammarFiles()).every(isInBinary);
console.log(JSON.stringify({ tree, embedded }));
