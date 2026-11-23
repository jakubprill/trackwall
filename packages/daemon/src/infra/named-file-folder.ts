import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { writeFileAtomic } from "./atomic-write.ts";
import { messageOf } from "./errors.ts";
import { mapLimit } from "./map-limit.ts";
import { readRegularFile } from "./regular-file.ts";

/**
 * A folder of named files in `.trackwall` of the projects folder that the user reads and edits in any editor (routines,
 * ADR-173; workspace knowledge, ADR-170; task templates, ADR-251). The folder lies where anything with file tools can
 * write, so every read goes through the kind's schema, a file that holds nothing is a problem of the list rather than a
 * value, and the files read and their size are bounded. Whether a file also needs the user's approval is the caller's
 * concern (`ApprovedFolder`).
 */

/** How one kind of file is named and read; `what` names it in messages ("routine"). */
export interface FolderFormat<T> {
  what: string;
  /** A valid name, also the key of an approval where the kind has one. */
  name: z.ZodString;
  extension: string;
  /** The name a file name gives, `undefined` for a file the folder does not read. */
  nameOfFile: (file: string) => string | undefined;
  /** The value a file holds, or why it holds none. */
  read: (name: string, text: string) => { value: T } | { problem: string };
  maxFileBytes: number;
  /** Files read at most; more is a sign of something else in the folder, and the rest is a problem. */
  maxFiles: number;
}

/** A file read from the folder, with the bytes it was read from. */
export interface FolderFile<T> {
  name: string;
  value: T;
  bytes: Buffer;
}

/** A file as the workspace store keeps it (ADR-298): its file name in the folder and its bytes. */
export interface FileCopy {
  file: string;
  bytes: Buffer;
}

/**
 * A folder as the workspace store keeps it (ADR-298): the files to copy, and the files there whose current bytes must not
 * go (a version waiting for approval, a file that cannot be read now), which the store keeps as it has them.
 */
export interface FolderCopies {
  copies: FileCopy[];
  held: string[];
}

export interface FolderProblem {
  file: string;
  message: string;
}

const READ_AT_ONCE = 16;

export class NamedFileFolder<T> {
  readonly #format: FolderFormat<T>;
  readonly #dir: () => Promise<string>;

  /** `dir` is the folder, made where missing and refused when it is a link (`ensureTrackwallDir`). */
  constructor(format: FolderFormat<T>, dir: () => Promise<string>) {
    this.#format = format;
    this.#dir = dir;
  }

  /** Every file by name; a file that holds nothing is a problem. */
  async list(): Promise<{ files: FolderFile<T>[]; problems: FolderProblem[] }> {
    const { maxFiles, nameOfFile } = this.#format;
    const dir = await this.#dir();
    const names = (await readdir(dir)).sort().flatMap((file) => {
      const name = nameOfFile(file);
      return name === undefined ? [] : [{ file, name }];
    });
    const read = await mapLimit(names.slice(0, maxFiles), READ_AT_ONCE, async ({ file, name }) => ({
      file,
      read: await this.#readIn(dir, name),
    }));
    const files: FolderFile<T>[] = [];
    const problems: FolderProblem[] = [];
    for (const { file, read: one } of read) {
      // A file removed between the folder's listing and its read is simply gone.
      if (one === undefined) continue;
      if ("problem" in one) problems.push({ file, message: one.problem });
      else files.push(one);
    }
    if (names.length > maxFiles) problems.push({ file: names[maxFiles]?.file ?? "", message: `the list reads at most ${maxFiles} files` });
    return { files, problems };
  }

  /**
   * The files that hold a value and pass `keep`, as they are on disk, for the workspace store (ADR-298); the rest, and a
   * file that holds nothing, are held.
   */
  async copies(keep: (file: FolderFile<T>) => boolean = () => true): Promise<FolderCopies> {
    const { files, problems } = await this.list();
    const copies = files.filter(keep).map(({ name, bytes }) => ({ file: this.#fileName(name), bytes }));
    const held = [...files.filter((file) => !keep(file)).map((file) => this.#fileName(file.name)), ...problems.map((p) => p.file)];
    return { copies, held };
  }

  /** `undefined` when there is no file; a problem for one that holds nothing. */
  async read(name: string): Promise<FolderFile<T> | { problem: string } | undefined> {
    return this.#readIn(await this.#dir(), name);
  }

  async write(name: string, text: string): Promise<void> {
    writeFileAtomic(join(await this.#dir(), this.#fileName(name)), text);
  }

  async remove(name: string): Promise<void> {
    await rm(join(await this.#dir(), this.#fileName(name)), { force: true });
  }

  async #readIn(dir: string, name: string): Promise<FolderFile<T> | { problem: string } | undefined> {
    const { maxFileBytes, read } = this.#format;
    try {
      const bytes = await readRegularFile(join(dir, this.#fileName(name)), maxFileBytes);
      if (bytes === undefined) return undefined;
      const file = read(name, bytes.toString("utf8"));
      return "problem" in file ? file : { name, value: file.value, bytes };
    } catch (err) {
      return { problem: messageOf(err) };
    }
  }

  #fileName(name: string): string {
    return `${name}${this.#format.extension}`;
  }
}
