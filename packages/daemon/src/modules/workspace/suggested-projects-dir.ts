import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * The usual places for a folder of repos in the home folder, the most likely first: `Dev` (the one an antivirus is most
 * often told to skip), `Projects`, `Code`, and `source/repos` from Visual Studio. Each part is a folder name.
 */
const CANDIDATES: readonly (readonly string[])[] = [["Dev"], ["Projects"], ["Code"], ["source", "repos"]];

/**
 * A projects folder to offer while none is set: the first of `CANDIDATES` that is a folder in `home`, under the spelling
 * it has on disk (`dev` on Linux is found for `Dev`). Only an offer: the user saves it.
 */
export async function suggestedProjectsDir(home: string): Promise<string | null> {
  for (const parts of CANDIDATES) {
    const found = await findFolder(home, parts);
    if (found !== null) return found;
  }
  return null;
}

async function findFolder(dir: string, parts: readonly string[]): Promise<string | null> {
  const [first, ...rest] = parts;
  if (first === undefined) return dir;
  const names = await readdir(dir).catch(() => []);
  const name = names.find((n) => n.toLowerCase() === first.toLowerCase());
  if (name === undefined) return null;
  // `stat` follows a link, so `Dev` as a symbolic link or a Windows junction to another disk is offered too.
  const isFolder = (await stat(join(dir, name)).catch(() => null))?.isDirectory() === true;
  return isFolder ? findFolder(join(dir, name), rest) : null;
}
