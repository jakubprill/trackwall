import { createReadStream } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { DomainError } from "../../infra/errors.ts";

/**
 * Reads a work backup's file back (ADR-275, §4.29), the other half of `archive.ts`. The file comes from the user, who
 * may have been handed it by anyone, so it is read as hostile: only regular files, only the names `archive.ts` writes
 * (`manifest.json`, `repos/<n>.bundle`, `state/<n>`), each once, each written to a path `place` makes from the name
 * alone, so no name in the file ever becomes a path; and the unpacked bytes stop at a limit, so a small file that
 * unpacks to a huge one fills no disk.
 */

const BLOCK = 512;
const ENTRY_NAME = /^(?:manifest\.json|repos\/\d{1,6}\.bundle|state\/\d{1,6})$/;

const NOT_A_BACKUP = "this is not a Trackwall work backup";

/**
 * Unpacks the gzipped tar `file`, writing each entry to `place(name)`, a new file, and returns the names it unpacked.
 * Refuses the whole file on a header that is not a regular file with one of the backup's names, a name twice, a broken
 * header or more than `maxBytes` unpacked.
 */
export async function readArchive(file: string, place: (name: string) => string, maxBytes: number): Promise<string[]> {
  const reader = new TarReader(place, maxBytes);
  try {
    await pipeline(createReadStream(file), createGunzip(), async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) await reader.take(chunk);
    });
    return reader.finish();
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw new DomainError("bad_request", `${NOT_A_BACKUP}: ${(err as Error).message}`);
  } finally {
    await reader.close();
  }
}

/** The tar's blocks as they come, a header, then its file's bytes and their padding, then the next header. */
class TarReader {
  readonly #place: (name: string) => string;
  readonly #maxBytes: number;
  readonly #names: string[] = [];
  #pending = Buffer.alloc(0);
  #file: { out: FileHandle; left: number; padding: number } | null = null;
  #unpacked = 0;
  #ended = false;

  constructor(place: (name: string) => string, maxBytes: number) {
    this.#place = place;
    this.#maxBytes = maxBytes;
  }

  async take(chunk: Buffer): Promise<void> {
    let rest = chunk;
    while (rest.length > 0) {
      if (this.#ended) return;
      rest = this.#file === null ? await this.#header(rest) : await this.#body(rest);
    }
  }

  finish(): string[] {
    if (!this.#ended || this.#file !== null) throw new DomainError("bad_request", `${NOT_A_BACKUP}: the file ends too early`);
    return this.#names;
  }

  /** Closes a file left open by a refusal. */
  async close(): Promise<void> {
    await this.#file?.out.close().catch(() => undefined);
    this.#file = null;
  }

  async #header(chunk: Buffer): Promise<Buffer> {
    const wanted = BLOCK - this.#pending.length;
    this.#pending = Buffer.concat([this.#pending, chunk.subarray(0, wanted)]);
    const rest = chunk.subarray(wanted);
    if (this.#pending.length < BLOCK) return rest;
    const block = this.#pending;
    this.#pending = Buffer.alloc(0);
    // An empty block ends a tar; what may follow (the second empty block, gzip's padding) is not read.
    if (block.every((byte) => byte === 0)) {
      this.#ended = true;
      return Buffer.alloc(0);
    }
    const { name, size } = parseHeader(block);
    if (this.#names.includes(name)) throw new DomainError("bad_request", `${NOT_A_BACKUP}: ${name} is in it twice`);
    this.#unpacked += size;
    if (this.#unpacked > this.#maxBytes)
      throw new DomainError("bad_request", `the backup unpacks to more than ${this.#maxBytes} bytes, more than a work backup holds`);
    this.#names.push(name);
    const out = await open(this.#place(name), "wx", 0o600);
    this.#file = { out, left: size, padding: (BLOCK - (size % BLOCK)) % BLOCK };
    if (size === 0) await this.#closeFile();
    return rest;
  }

  /** The file's bytes, then the padding to the next block; the file is closed when both are through. */
  async #body(chunk: Buffer): Promise<Buffer> {
    const file = this.#file;
    if (file === null) return chunk;
    const taken = Math.min(chunk.length, file.left + file.padding);
    const data = chunk.subarray(0, Math.min(file.left, taken));
    if (data.length > 0) await file.out.write(data);
    file.left -= data.length;
    file.padding -= taken - data.length;
    if (file.left === 0 && file.padding === 0) await this.#closeFile();
    return chunk.subarray(taken);
  }

  async #closeFile(): Promise<void> {
    const file = this.#file;
    this.#file = null;
    await file?.out.close();
  }
}

/** The name and size of a regular file's ustar header with a right checksum; anything else refuses the file. */
function parseHeader(block: Buffer): { name: string; size: number } {
  const stored = Number.parseInt(field(block, 148, 8).trim(), 8);
  let sum = 0;
  for (const [i, byte] of block.entries()) sum += i >= 148 && i < 156 ? 32 : byte;
  if (stored !== sum) throw new DomainError("bad_request", `${NOT_A_BACKUP}: a header's checksum is wrong`);
  const type = block[156];
  // `0`, or NUL in tars from before ustar: a regular file. Links, folders and devices are never in a backup.
  if (type !== 0x30 && type !== 0) throw new DomainError("bad_request", `${NOT_A_BACKUP}: it holds something other than files`);
  const prefix = field(block, 345, 155);
  const name = field(block, 0, 100);
  if (prefix !== "" || !ENTRY_NAME.test(name)) throw new DomainError("bad_request", `${NOT_A_BACKUP}: it holds ${JSON.stringify(name)}`);
  const size = Number.parseInt(field(block, 124, 12).trim(), 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new DomainError("bad_request", `${NOT_A_BACKUP}: ${name} has no size`);
  return { name, size };
}

/** A NUL-ended text field of the header. */
function field(block: Buffer, start: number, length: number): string {
  const bytes = block.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}
