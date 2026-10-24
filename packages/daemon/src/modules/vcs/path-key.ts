import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Ścieżka jako klucz porównania: po rozwinięciu dowiązań (`/var` i `/private/var` na macOS), bez wielkości liter tam,
 * gdzie dyski domyślnie jej nie rozróżniają (Windows, macOS). Ścieżka, której nie ma, porównuje się po `resolve`.
 */
export async function pathKey(path: string): Promise<string> {
  const real = await realpath(path).catch(() => resolve(path));
  return process.platform === "linux" ? real : real.toLowerCase();
}
