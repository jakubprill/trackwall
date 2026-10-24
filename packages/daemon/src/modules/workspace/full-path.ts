import path, { type PlatformPath } from "node:path";

/**
 * Pełna ścieżka na dysku użytkownika (folder z projektami w `workspace.yaml` i w ustawieniach): na Windowsie
 * z literą dysku albo UNC. `\projekty` jest dla `isAbsolute` pełna, ale wskazuje dysk, z którego akurat
 * uruchomiono daemon; `~` nie jest rozwijane, a względna zależy od katalogu daemona.
 */
export function isFullPath(p: string, paths: PlatformPath = path): boolean {
  return paths.isAbsolute(p) && (paths.sep === "/" || paths.parse(p).root.length > 1);
}

export const NOT_FULL_PATH =
  "the projects folder must be a full path: on Windows with a drive letter (C:\\...) or \\\\server\\share, without `~` and not relative";
