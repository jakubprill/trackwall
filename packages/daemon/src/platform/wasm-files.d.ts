// Importing a `.wasm` file with the attribute `type: "file"` gives a path to the file, but only under Bun, so only the
// three files `bun-grammar-files.ts` imports have types; any other `.wasm` import is a compile error.
declare module "web-tree-sitter/web-tree-sitter.wasm" {
  const path: string;
  export default path;
}
declare module "tree-sitter-java/tree-sitter-java.wasm" {
  const path: string;
  export default path;
}
declare module "@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm" {
  const path: string;
  export default path;
}
