import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { JavaNavigationSettings, JavaNavigationState } from "@trackwall/protocol";
import { configOrProblem } from "../../infra/errors.ts";
import type { LspServer } from "./copilot-plugin.ts";

/**
 * Java navigation (§4.4, ADR-99): Eclipse JDT Language Server (jdtls) for the `lsp` tool of a task's sessions, given to
 * Copilot CLI as an `lspServers` entry of the session plugin. jdtls starts with `java` directly, not with its
 * `jdtls`/`jdtls.bat` script, which needs Python. Each task has its own data folder (`-data`): two jdtls instances
 * must not share one, and it lives in the projects folder, the one folder an antivirus may leave alone.
 */

/** The key of the jdtls entry in `lspServers`. */
export const JAVA_LSP_SERVER = "java";

const LAUNCHER_JAR = /^org\.eclipse\.equinox\.launcher_.+\.jar$/;

/** Enough for a Spring Boot service of a few hundred classes (measured: ~1 GB at the peak of the first import). */
const MAX_HEAP = "-Xmx2G";

/**
 * Whether a task can get jdtls now, read before every start: the settings when it can, otherwise why not. A bad
 * `javaNavigation` key (`invalid_config`) is such a reason too, so it greys the option out and a resume starts without
 * the server instead of failing.
 */
export type JavaNavigationReadiness = { settings: JavaNavigationSettings; problem: null } | { settings: null; problem: string };

export function javaNavigationReadiness(read: () => JavaNavigationSettings | null): JavaNavigationReadiness {
  const { value: settings, problem: invalid } = configOrProblem(read, null);
  if (invalid !== null) return { settings: null, problem: invalid };
  if (settings === null) return { settings: null, problem: NOT_SET };
  const problem = javaNavigationProblem(settings);
  return problem === null ? { settings, problem } : { settings: null, problem };
}

/** Readiness as the New session form gets it (`start-options`): `null` while the key is not in `workspace.yaml`. */
export function javaNavigationState(readiness: JavaNavigationReadiness): JavaNavigationState {
  return readiness.problem === NOT_SET ? null : { problem: readiness.problem };
}

const NOT_SET = "javaNavigation is not set in workspace.yaml";

/** Why `settings` cannot start jdtls on this system, or `null` when it can. */
export function javaNavigationProblem(settings: JavaNavigationSettings, platform = process.platform, arch = process.arch): string | null {
  if (!isFile(settings.java)) return `no Java program at ${settings.java}`;
  if (settings.lombok !== null && !isFile(settings.lombok)) return `no Lombok jar at ${settings.lombok}`;
  if (launcherJar(settings.jdtls) === null) return `no jdtls launcher jar in ${join(settings.jdtls, "plugins")}`;
  const config = join(settings.jdtls, configFolder(platform, arch));
  if (!isDirectory(config)) return `no jdtls configuration for this system at ${config}`;
  return null;
}

/** The jdtls entry for a session whose data folder is `dataDir`, for settings `javaNavigationProblem` found no problem in. */
export function javaLanguageServer(
  settings: JavaNavigationSettings,
  dataDir: string,
  platform = process.platform,
  arch = process.arch,
): LspServer {
  const launcher = launcherJar(settings.jdtls);
  if (launcher === null) throw new Error(`no jdtls launcher jar in ${join(settings.jdtls, "plugins")}`);
  return {
    command: settings.java,
    args: [
      "-Declipse.application=org.eclipse.jdt.ls.core.id1",
      "-Dosgi.bundles.defaultStartLevel=4",
      "-Declipse.product=org.eclipse.jdt.ls.core.product",
      // jdtls's own configuration stays read-only and shared; what it writes goes into the task's data folder.
      "-Dosgi.checkConfiguration=true",
      `-Dosgi.sharedConfiguration.area=${join(settings.jdtls, configFolder(platform, arch))}`,
      "-Dosgi.sharedConfiguration.area.readOnly=true",
      "-Dosgi.configuration.cascaded=true",
      MAX_HEAP,
      "--add-modules=ALL-SYSTEM",
      "--add-opens",
      "java.base/java.util=ALL-UNNAMED",
      "--add-opens",
      "java.base/java.lang=ALL-UNNAMED",
      ...(settings.lombok === null ? [] : [`-javaagent:${settings.lombok}`]),
      "-jar",
      launcher,
      "-configuration",
      join(dataDir, "configuration"),
      "-data",
      join(dataDir, "workspace"),
    ],
    fileExtensions: { ".java": "java" },
  };
}

/** jdtls ships one configuration folder per system. */
function configFolder(platform: NodeJS.Platform, arch: string): string {
  const arm = arch === "arm64" ? "_arm" : "";
  if (platform === "win32") return "config_win";
  if (platform === "darwin") return `config_mac${arm}`;
  return `config_linux${arm}`;
}

function launcherJar(jdtls: string): string | null {
  const plugins = join(jdtls, "plugins");
  if (!isDirectory(plugins)) return null;
  const jar = readdirSync(plugins).find((name) => LAUNCHER_JAR.test(name));
  return jar === undefined ? null : join(plugins, jar);
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}
