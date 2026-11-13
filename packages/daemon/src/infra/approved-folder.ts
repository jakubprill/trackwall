import { createHash } from "node:crypto";
import { ContentDigest } from "@trackwall/protocol";
import { z } from "zod";
import { DomainError } from "./errors.ts";
import { type FolderFile, type FolderFormat, type FolderProblem, NamedFileFolder } from "./named-file-folder.ts";
import { readStateFile, type StateFormat, stateFormat, writeStateFile } from "./state-file.ts";

/**
 * A folder of named Markdown files that an agent may write and that count only in the exact content the user approved
 * (routines, ADR-173; workspace knowledge, ADR-170). The folder lies in the projects folder, where anything with file
 * tools can write, so an approval is the SHA-256 of the file's bytes, kept in the state folder, and every read compares
 * the file with it: a file changed after its approval, by an agent or by hand, is no longer approved. An approval names
 * the digest the user saw, so a file swapped between reading and clicking is refused rather than approved unseen.
 */

export interface ApprovedFolderDeps<T> {
  format: FolderFormat<T>;
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

type StoredApprovals = { approved: Record<string, string> };

/** The approvals file of one kind of file (ADR-170, ADR-173, ADR-223): the digest the user approved, by name. */
export function approvalsFormat(name: z.ZodString): StateFormat<StoredApprovals> {
  return stateFormat(z.object({ approved: z.record(name, ContentDigest) }));
}

export class ApprovedFolder<T> {
  readonly #deps: ApprovedFolderDeps<T>;
  readonly #folder: NamedFileFolder<T>;
  readonly #approvalsFormat: StateFormat<StoredApprovals>;

  constructor(deps: ApprovedFolderDeps<T>) {
    this.#deps = deps;
    this.#folder = new NamedFileFolder(deps.format, deps.dir);
    this.#approvalsFormat = approvalsFormat(deps.format.name);
  }

  /** Every file by name, each with whether its content is the approved one; a file that holds nothing is a problem. */
  async list(): Promise<{ files: ApprovedFile<T>[]; problems: FolderProblem[] }> {
    const { files, problems } = await this.#folder.list();
    const approved = this.#approvals().approved;
    return { files: files.map((file) => withApproval(file, approved)), problems };
  }

  /** Writes a file's text; it is approved only when its bytes are the approved ones, or with `approve`. */
  async write(name: string, text: string, { approve }: { approve: boolean }): Promise<{ digest: string; approved: boolean }> {
    await this.#folder.write(name, text);
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
    const read = await this.#folder.read(name);
    if (read === undefined) throw new DomainError("not_found", `no ${what} ${name}`);
    if ("problem" in read) throw new DomainError("bad_request", `${what} ${name} cannot be read: ${read.problem}`);
    const file = withApproval(read, this.#approvals().approved);
    if (file.digest !== digest)
      throw new DomainError("bad_request", `${what} ${name} changed since you read it; check the new version first`);
    return file;
  }

  async remove(name: string): Promise<void> {
    await this.#folder.remove(name);
    const { [name]: _, ...approved } = this.#approvals().approved;
    this.#writeApprovals({ approved });
  }

  #setApproval(name: string, digest: string): void {
    this.#writeApprovals({ approved: { ...this.#approvals().approved, [name]: digest } });
  }

  #approvals(): StoredApprovals {
    const { approvalsFile, format, log } = this.#deps;
    return (
      readStateFile(approvalsFile, this.#approvalsFormat, (problem, aside) =>
        log(`${format.what} approvals were unreadable (${problem}), moved to ${aside}; every ${format.what} waits for approval again`),
      ) ?? { approved: {} }
    );
  }

  #writeApprovals(approvals: StoredApprovals): void {
    writeStateFile(this.#deps.approvalsFile, this.#approvalsFormat, approvals);
  }
}

function withApproval<T>({ name, value, bytes }: FolderFile<T>, approved: Record<string, string>): ApprovedFile<T> {
  const digest = digestOf(bytes);
  return { name, value, digest, approved: approved[name] === digest };
}

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
