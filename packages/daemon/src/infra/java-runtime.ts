import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Java installations for Java navigation (ADR-167): read by `agents` for jdtls's settings and by `java-navigation` for the install. */

/**
 * A Java installation jdtls may use for a project (ADR-167): its folder and the name of the Java SE version it provides,
 * as jdtls's `java.configuration.runtimes` names them (`JavaSE-1.8`, `JavaSE-17`).
 */
export interface JavaRuntime {
  name: string;
  path: string;
}

/**
 * The runtime in the Java installation folder `home`, from the `release` file every JDK has at its root since Java 8
 * (`JAVA_VERSION="17.0.12"`, `"1.8.0_422"`); `null` when there is none, so a wrong folder is a problem before a start.
 */
export function javaRuntimeOf(home: string): JavaRuntime | null {
  const release = join(home, "release");
  if (!isFile(release)) return null;
  const version = /^JAVA_VERSION="(?:1\.(?=\d))?(\d+)/m.exec(readFileSync(release, "utf8"))?.[1];
  if (version === undefined) return null;
  return { name: version === "8" ? "JavaSE-1.8" : `JavaSE-${version}`, path: home };
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}
