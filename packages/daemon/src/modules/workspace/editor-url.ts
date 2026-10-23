/**
 * Adres, który otwiera katalog w VS Code przez systemowy mechanizm otwierania URL-i, bez uruchamiania `code`
 * przez powłokę: `vscode://file/C:/repo` na Windowsie, `vscode://file/Users/me/repo` na macOS.
 */
export function vscodeUrl(dir: string): string {
  const segments = dir.replaceAll("\\", "/").split("/");
  // `#`, `?` i `%` w nazwie katalogu muszą być zakodowane; dwukropek litery dysku zostaje.
  const encoded = segments.map((s) => encodeURIComponent(s).replaceAll("%3A", ":")).join("/");
  return `vscode://file${encoded.startsWith("/") ? encoded : `/${encoded}`}`;
}
