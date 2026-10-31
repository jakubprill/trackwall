import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { CardProblem } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import { isInside } from "../../infra/path-inside.ts";
import { readRegularFile } from "../../infra/regular-file.ts";
import { readsSpringConfigFile, springLoadOrder } from "./spring-config.ts";

/**
 * The Spring configuration files of a working directory (ADR-153), for `get_app_config`: unlike the card (ADR-14), what
 * a run there reads now, with uncommitted changes and the files git ignores (`application-local.yml`). The resource
 * folders are those of the configuration files git tracks, and each is listed on disk, so an ignored file next to a
 * tracked one is found without walking `node_modules` or `target`. Every file is read as one a repo may have planted:
 * a regular file within the size limit, never a link, in a folder that resolves inside the read directory.
 */

/** What reading needs from `vcs`: the tracked paths matching globs. */
export interface WorkingConfigVcs {
  trackedFiles(dir: string, globs: readonly string[], maxBytes: number): Promise<{ paths: string[]; truncated: boolean }>;
}

export interface WorkingConfig {
  /** The files read, relative to the directory, with `/`, in the order Spring reads them. */
  paths: string[];
  text(path: string): string | undefined;
  problems: CardProblem[];
}

const CONFIG_GLOBS = ["**/src/main/resources/application*", "**/src/main/resources/bootstrap*"];
/** The name list of a repo with a few hundred modules is a few KB. */
const MAX_LIST_BYTES = 1024 * 1024;
/** A Spring configuration file larger than this is not hand-written configuration. */
const MAX_FILE_BYTES = 1024 * 1024;
/** Resource folders and files read at most: a monorepo has dozens of modules, each with a few profiles. */
const MAX_FOLDERS = 200;
const MAX_FILES = 500;
const RESOURCES = "src/main/resources";

export async function readWorkingConfig(vcs: WorkingConfigVcs, dir: string): Promise<WorkingConfig> {
  const problems: CardProblem[] = [];
  const tracked = await vcs.trackedFiles(dir, CONFIG_GLOBS, MAX_LIST_BYTES);
  const folders = [...new Set(tracked.paths.filter(readsSpringConfigFile).map(folderOf))].sort();
  if (tracked.truncated || folders.length > MAX_FOLDERS)
    problems.push({
      code: "files-not-read",
      path: "",
      message: `more resource folders than the limit of ${MAX_FOLDERS}; the rest were not read`,
    });
  const root = await realpath(dir);
  const listed = (await Promise.all(folders.slice(0, MAX_FOLDERS).map((f) => configFilesIn(root, f, problems)))).flat();
  const paths = listed.sort(springLoadOrder);
  if (paths.length > MAX_FILES)
    problems.push({
      code: "files-not-read",
      path: "",
      message: `more configuration files than the limit of ${MAX_FILES}; the rest were not read`,
    });
  const texts = new Map<string, string>();
  for (const path of paths.slice(0, MAX_FILES)) {
    const text = await readConfigFile(root, path, problems);
    if (text !== undefined) texts.set(path, text);
  }
  return { paths: [...texts.keys()], text: (path) => texts.get(path), problems };
}

/** `orders/src/main/resources` for `orders/src/main/resources/application.yml`. */
function folderOf(path: string): string {
  return path.slice(0, path.lastIndexOf(RESOURCES) + RESOURCES.length);
}

/** The configuration files in a resource folder on disk, also those git ignores; none when the folder is gone or leaves the root. */
async function configFilesIn(root: string, folder: string, problems: CardProblem[]): Promise<string[]> {
  const real = await realpath(join(root, ...folder.split("/"))).catch(() => undefined);
  if (real === undefined) return [];
  if (!isInside(root, real)) {
    problems.push({ code: "files-not-read", path: folder, message: "the folder leads outside the repo through a link" });
    return [];
  }
  const names = await readdir(real).catch(() => []);
  return names.map((name) => `${folder}/${name}`).filter(readsSpringConfigFile);
}

async function readConfigFile(root: string, path: string, problems: CardProblem[]): Promise<string | undefined> {
  try {
    return (await readRegularFile(join(root, ...path.split("/")), MAX_FILE_BYTES))?.toString("utf8");
  } catch (err) {
    problems.push({ code: "files-not-read", path, message: messageOf(err) });
    return undefined;
  }
}
