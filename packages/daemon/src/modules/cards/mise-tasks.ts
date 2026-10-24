import type { DeclaredMiseTask, MiseSetup } from "@trackwall/protocol";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { baseName, dirOf } from "./repo-path.ts";
import { keyLines, type RepoSnapshot } from "./snapshot.ts";
import { MISE_CONFIG_FILES, TOML_KEY } from "./tools.ts";

/**
 * Konfiguracja mise repo z drzewa commita (§4.6, ADR-34): które pliki konfiguracji mise leżą w repo i jakie taski
 * zapisano w ich `[tasks]` oraz w katalogach tasków plikowych. Bez `mise tasks ls`, z tych samych powodów co narzędzia
 * w `tools.ts` (ADR-25): commit zamiast katalogu roboczego i bez zaufania mise. Plik konfiguracji parsuje się tu drugi
 * raz (pierwszy dla `[tools]`), bo to kilka małych plików na commit, a karta liczy się raz.
 */

/** Pliki konfiguracji z korzenia (te z `tools.ts` i `.config/mise/mise.toml`) i katalogi `conf.d` z dowolnym `*.toml`. */
const ROOT_CONFIG_FILES = [...MISE_CONFIG_FILES, ".config/mise/mise.toml"];
const CONF_D_DIRS = ["mise/conf.d", ".mise/conf.d", ".config/mise/conf.d"];
/** Katalogi tasków plikowych, które mise czyta domyślnie w korzeniu repo. */
const FILE_TASK_DIRS = ["mise-tasks", ".mise-tasks", "mise/tasks", ".mise/tasks", ".config/mise/tasks"];
/** Nagłówek tabeli taska (`[tasks.build]`, `[tasks."test:unit"]`); klasy bez spacji, więc bez cofania na długiej linii. */
const TASK_HEADER = /^\s*\[tasks\.(?:"([^"]*)"|'([^']*)'|([^"'\s\]]+))\s*\]/g;
const TASKS_TABLE = /^\s*\[tasks\]\s*$/;
const ANY_TABLE = /^\s*\[/;
/** Tylko klucze `[tasks]`; zły wpis w innej tabeli to sprawa `tools.ts`. */
const MiseTasksConfig = z.object({ tasks: z.record(z.string(), z.unknown()).catch({}) });

export function isMiseConfigFile(path: string): boolean {
  return ROOT_CONFIG_FILES.includes(path) || (CONF_D_DIRS.includes(dirOf(path)) && path.endsWith(".toml"));
}

export function extractMiseSetup(snapshot: RepoSnapshot): MiseSetup {
  const configFiles = snapshot.paths.filter(isMiseConfigFile);
  const read = configFiles.flatMap((path) => {
    const text = snapshot.text(path);
    return text === undefined ? [] : [{ path, text }];
  });
  const tasks = [...read.flatMap((f) => tomlTasks(f.path, f.text)), ...fileTasks(snapshot.paths)];
  return { configFiles, tasks, complete: read.length === configFiles.length };
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
  const inTable = tasksTableLines(text);
  const dotted = keyLines(text, TOML_KEY);
  return Object.keys(config.data.tasks).map((name) => ({
    name,
    evidence: { path, line: headers.get(name) ?? inTable.get(name) ?? dotted.get(`tasks.${name}`) ?? null },
  }));
}

/** Linie kluczy wewnątrz tabeli `[tasks]` (`build = "make"`), żeby klucz o tej samej nazwie w `[tools]` nie był dowodem. */
function tasksTableLines(text: string): Map<string, number> {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => TASKS_TABLE.test(line));
  if (start < 0) return new Map();
  const end = lines.findIndex((line, i) => i > start && ANY_TABLE.test(line));
  const table = lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
  return new Map([...keyLines(table, TOML_KEY)].map(([name, line]) => [name, line + start + 1]));
}

/** Pliki w katalogach tasków; ukryte pliki (`.gitkeep`) to nie taski, a `_default` to task o nazwie katalogu. */
function fileTasks(paths: readonly string[]): DeclaredMiseTask[] {
  return FILE_TASK_DIRS.flatMap((dir) =>
    paths
      .filter((path) => path.startsWith(`${dir}/`) && !baseName(path).startsWith("."))
      .map((path) => ({ name: taskName(path.slice(dir.length + 1)), evidence: { path, line: null } })),
  );
}

function taskName(relative: string): string {
  const parts = relative.split("/");
  if (parts.at(-1) === "_default" && parts.length > 1) parts.pop();
  return parts.join(":");
}
