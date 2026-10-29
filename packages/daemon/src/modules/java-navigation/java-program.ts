import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The `java` program in a Java installation folder (`mise where java@…`): `bin/java` on Linux and Windows (`java.exe`),
 * and on macOS inside the bundle, `Contents/Home/bin/java`, unless the folder is laid out flat.
 */
export function javaProgramIn(home: string, platform: NodeJS.Platform = process.platform): string {
  const name = platform === "win32" ? "java.exe" : "java";
  const candidates = [join(home, "bin", name), join(home, "Contents", "Home", "bin", name)];
  const found = candidates.find((path) => existsSync(path));
  if (found === undefined) throw new Error(`no ${name} in ${home} (looked in ${candidates.join(" and ")})`);
  return found;
}
