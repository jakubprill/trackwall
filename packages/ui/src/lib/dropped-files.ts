import { dropTooLarge, MAX_DROP_BYTES } from "@trackwall/protocol";

/**
 * Files dropped on a terminal whose daemon runs on another computer, such as in a container (ADR-226): a path of this
 * computer means nothing there, so the window sends each file's bytes to the daemon, which keeps a copy in the projects
 * folder, and the terminal gets the copies' paths instead. The desktop app reads a dropped file through the shell's
 * `read_dropped_file`, which reads only a file just dropped on that window; a browser hands the page the files themselves.
 */

/** The shell's command (`dropped_files.rs`). */
export const READ_COMMAND = "read_dropped_file";

/** A dropped file to send: its name and how to get its bytes. */
export interface DropSource {
  name: string;
  /** The size when it is known before reading (a browser's `File`); the shell checks it itself. */
  size?: number;
  /** A browser hands a dropped folder over as a `File` too; the shell refuses one itself. */
  folder?: boolean;
  read: () => Promise<Blob | ArrayBuffer>;
}

/** The last part of a path of this computer, after `/` or `\`. */
export function droppedFileName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
}

/** Whether a drag carries files from the system rather than text or a link (`DataTransfer.types`). */
export function carriesFiles(types: readonly string[]): boolean {
  return types.includes("Files");
}

/** The line above the terminal while the files are sent. */
export function copyingNotice(sources: readonly Pick<DropSource, "name">[]): string {
  const [only] = sources;
  return sources.length === 1 && only ? `Copying ${only.name} to Trackwall…` : `Copying ${sources.length} files to Trackwall…`;
}

/** Why a file cannot be sent before any of it is read, or `undefined`; the daemon makes any name safe itself. */
export function dropRefusal(source: Pick<DropSource, "name" | "size" | "folder">): string | undefined {
  if (source.folder) return `${source.name} is a folder; only files can be dropped on a terminal in a container`;
  if (source.size !== undefined && source.size > MAX_DROP_BYTES) return dropTooLarge(source.name);
  return undefined;
}

/** The bytes the shell's `read_dropped_file` answers, which reach the page as an `ArrayBuffer`. */
export function droppedBytes(answer: unknown): ArrayBuffer {
  if (answer instanceof ArrayBuffer) return answer;
  throw new Error(`${READ_COMMAND} did not answer with the file's bytes`);
}

/**
 * Sends the files one after another and returns the daemon's paths of the copies, in the order dropped. The first
 * refusal or failure stops the rest, so the terminal never gets some of the paths without being told.
 */
export async function sendDropped(
  sources: readonly DropSource[],
  upload: (name: string, body: Blob | ArrayBuffer) => Promise<string>,
): Promise<string[]> {
  for (const source of sources) {
    const refused = dropRefusal(source);
    if (refused) throw new Error(refused);
  }
  const paths: string[] = [];
  for (const source of sources) paths.push(await upload(source.name, await source.read()));
  return paths;
}
