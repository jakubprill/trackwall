// Import pliku `.wasm` z atrybutem `type: "file"` daje ścieżkę do pliku, ale tylko pod Bun, więc typy ma wyłącznie
// trzy pliki, które importuje `bun-grammar-files.ts`; każdy inny import `.wasm` to błąd kompilacji.
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
