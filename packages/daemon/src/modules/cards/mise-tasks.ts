import type { DeclaredMiseTask, MiseSetup } from "@trackwall/protocol";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { baseName } from "./repo-path.ts";
import { keyLines, type RepoSnapshot } from "./snapshot.ts";
import { MISE_CONFIG_FILES, TOML_KEY } from "./tools.ts";

/**
 * Konfiguracja mise repo z drzewa commita (§4.6, ADR-34): które pliki konfiguracji mise leżą w korzeniu i jakie taski
 * zapisano w ich `[tasks]` oraz w katalogach tasków plikowych. Bez `mise tasks ls`, z tych samych powodów co narzędzia
 * w `tools.ts` (ADR-25): commit zamiast katalogu roboczego i bez zaufania mise.
 */

/** Katalogi tasków plikowych, które mise czyta domyślnie w korzeniu repo. */
const FILE_TASK_DIRS = ["mise-tasks", ".mise-tasks", "mise/tasks", ".mise/tasks", ".config/mise/tasks"];
/** Nagłówek tabeli taska (`[tasks.build]`, `[tasks."test:unit"]`); klasy bez spacji, więc bez cofania na długiej linii. */
const TASK_HEADER = /^\s*\[tasks\.(?:"([^"]*)"|'([^']*)'|([^"'\s\]]+))\s*\]/g;
/** Tylko klucze `[tasks]`; zły wpis w innej tabeli to sprawa `tools.ts`. */
const MiseTasksConfig = z.object({ tasks: z.record(z.string(), z.unknown()).catch({}) });

export function extractMiseSetup(snapshot: RepoSnapshot): MiseSetup {
  const configFiles = MISE_CONFIG_FILES.filter((path) => snapshot.text(path) !== undefined);
  const tasks = [...configFiles.flatMap((path) => tomlTasks(path, snapshot.text(path) ?? "")), ...fileTasks(snapshot.paths)];
  return { configFiles, tasks };
}

/** Klucze `[tasks]`; plik, który nie jest poprawnym TOML-em, nie daje tasków, a problem karty zgłasza już `tools.ts`. */
function tomlTasks(path: string, text: string): DeclaredMiseTask[] {
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch {
    return [];
  }
  const config = MiseTasksConfig.safeParse(parsed);
  if (!config.success) return [];
  const headers = keyLines(text, TASK_HEADER);
  const keys = keyLines(text, TOML_KEY);
  return Object.keys(config.data.tasks).map((name) => ({
    name,
    evidence: { path, line: headers.get(name) ?? keys.get(`tasks.${name}`) ?? keys.get(name) ?? null },
  }));
}

/** Pliki w katalogach tasków; ukryte pliki (`.gitkeep`) to nie taski. */
function fileTasks(paths: readonly string[]): DeclaredMiseTask[] {
  return FILE_TASK_DIRS.flatMap((dir) =>
    paths
      .filter((path) => path.startsWith(`${dir}/`) && !baseName(path).startsWith("."))
      .map((path) => ({ name: path.slice(dir.length + 1).replaceAll("/", ":"), evidence: { path, line: null } })),
  );
}
