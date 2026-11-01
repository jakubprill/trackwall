import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ContentDigest } from "@trackwall/protocol";
import { z } from "zod";
import { writeFileAtomic } from "./atomic-write.ts";
import { DomainError, messageOf } from "./errors.ts";
import { mapLimit } from "./map-limit.ts";
import { readRegularFile } from "./regular-file.ts";
import { readStateFile } from "./state-file.ts";

/**
 * A folder of named Markdown files that an agent may write and that count only in the exact content the user approved
 * (routines, ADR-173; workspace knowledge, ADR-170). The folder lies in the projects folder, where anything with file
 * tools can write, so an approval is the SHA-256 of the file's bytes, kept in the state folder, and every read compares
 * the file with it: a file changed after its approval, by an agent or by hand, is no longer approved. An approval names
 * the digest the user saw, so a file swapped between reading and clicking is refused rather than approved unseen.
 */

/** How one kind of file is named and read; `what` names it in messages ("routine"). */
export interface ApprovedFolderFormat<T> {
  what: string;
  /** A valid name, also the key of its approval: a hand-edited approvals file with another key is set aside. */
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

export interface ApprovedFolderDeps<T> {
  format: ApprovedFolderFormat<T>;
  /** The folder, made where missing; refused when it is a link (`ensureTrackwallDir`). */
  dir: () => Promise<string>;
  /** The approvals file in the state folder. */
  approvalsFile: string;
  log: (msg: string) => void;
}

/** A file read from the folder, with the digest of the bytes it was read from and whether the user approved them. */
export interface ApprovedFile<T> {
  name: string;
  value: T;
  digest: string;
  approved: boolean;
}

export interface FolderProblem {
  file: string;
  message: string;
}

const READ_AT_ONCE = 16;
type StoredApprovals = { approved: Record<string, string> };

export class ApprovedFolder<T> {
  readonly #deps: ApprovedFolderDeps<T>;

  constructor(deps: ApprovedFolderDeps<T>) {
    this.#deps = deps;
  }

  /** Every file by name, each with whether its content is the approved one; a file that holds nothing is a problem. */
  async list(): Promise<{ files: ApprovedFile<T>[]; problems: FolderProblem[] }> {
    const { maxFiles, nameOfFile } = this.#deps.format;
    const dir = await this.#deps.dir();
    const names = (await readdir(dir)).sort().flatMap((file) => {
      const name = nameOfFile(file);
      return name === undefined ? [] : [{ file, name }];
    });
    const approved = this.#approvals().approved;
    const read = await mapLimit(names.slice(0, maxFiles), READ_AT_ONCE, async ({ file, name }) => ({
      file,
      read: await this.#read(dir, name, approved),
    }));
    const files: ApprovedFile<T>[] = [];
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

  /** Writes a file's text; it is approved only when its bytes are the approved ones, or with `approve`. */
  async write(name: string, text: string, { approve }: { approve: boolean }): Promise<{ digest: string; approved: boolean }> {
    const dir = await this.#deps.dir();
    writeFileAtomic(join(dir, this.#fileName(name)), text);
    const digest = digestOf(Buffer.from(text, "utf8"));
    if (approve) this.#setApproval(name, digest);
    return { digest, approved: approve || this.#approvals().approved[name] === digest };
  }

  /** Approves a file's content as the user saw it (`digest`). */
  async approve(name: string, digest: string): Promise<ApprovedFile<T>> {
    const read = await this.seen(name, digest);
    this.#setApproval(name, digest);
    return { ...read, approved: true };
  }

  /** The file as it is now, refused when that is no longer the content the user saw. */
  async seen(name: string, digest: string): Promise<ApprovedFile<T>> {
    const { what } = this.#deps.format;
    const read = await this.#read(await this.#deps.dir(), name, this.#approvals().approved);
    if (read === undefined) throw new DomainError("not_found", `no ${what} ${name}`);
    if ("problem" in read) throw new DomainError("bad_request", `${what} ${name} cannot be read: ${read.problem}`);
    if (read.digest !== digest)
      throw new DomainError("bad_request", `${what} ${name} changed since you read it; check the new version first`);
    return read;
  }

  async remove(name: string): Promise<void> {
    await rm(join(await this.#deps.dir(), this.#fileName(name)), { force: true });
    const { [name]: _, ...approved } = this.#approvals().approved;
    this.#writeApprovals({ approved });
  }

  #fileName(name: string): string {
    return `${name}${this.#deps.format.extension}`;
  }

  #setApproval(name: string, digest: string): void {
    this.#writeApprovals({ approved: { ...this.#approvals().approved, [name]: digest } });
  }

  /** `undefined` when there is no file; a problem for one that holds nothing. */
  async #read(dir: string, name: string, approved: Record<string, string>): Promise<ApprovedFile<T> | { problem: string } | undefined> {
    const { maxFileBytes, read } = this.#deps.format;
    try {
      const bytes = await readRegularFile(join(dir, this.#fileName(name)), maxFileBytes);
      if (bytes === undefined) return undefined;
      const file = read(name, bytes.toString("utf8"));
      if ("problem" in file) return file;
      const digest = digestOf(bytes);
      return { name, value: file.value, digest, approved: approved[name] === digest };
    } catch (err) {
      return { problem: messageOf(err) };
    }
  }

  #approvals(): StoredApprovals {
    const { approvalsFile, format, log } = this.#deps;
    return (
      readStateFile(approvalsFile, z.object({ approved: z.record(format.name, ContentDigest) }), (problem, aside) =>
        log(`${format.what} approvals were unreadable (${problem}), moved to ${aside}; every ${format.what} waits for approval again`),
      ) ?? { approved: {} }
    );
  }

  #writeApprovals(approvals: StoredApprovals): void {
    writeFileAtomic(this.#deps.approvalsFile, `${JSON.stringify(approvals, null, 2)}\n`);
  }
}

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
