/**
 * Sonda parsera tree-sitter (ADR-37) uruchamiana przez `syntax-tree.test.ts` pod Bun, pod Node i jako binarka
 * z `bun build --compile`: `<java|kotlin> <kod>` wypisuje JSON z drzewem składni kodu i tym, czy pliki WASM leżą
 * w binarce.
 */
import { loadSyntaxParsers } from "../../src/modules/cards/syntax-tree.ts";
import { isInBinary } from "../../src/platform/runtime.ts";
import { loadJvmGrammars } from "../../src/platform/tree-sitter.ts";

const [language, source] = process.argv.slice(2);
if ((language !== "java" && language !== "kotlin") || source === undefined) throw new Error("użycie: <java|kotlin> <kod>");
const tree = (await loadSyntaxParsers()).read(language, source, (root) => root.toString());
const embedded = Object.values((await loadJvmGrammars()).files).every(isInBinary);
console.log(JSON.stringify({ tree, embedded }));
