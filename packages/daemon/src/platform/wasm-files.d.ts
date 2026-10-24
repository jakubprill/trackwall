/** Import pliku `.wasm` z atrybutem `type: "file"` (tylko Bun, `bun-grammar-files.ts`) daje ścieżkę do pliku. */
declare module "*.wasm" {
  const path: string;
  export default path;
}
