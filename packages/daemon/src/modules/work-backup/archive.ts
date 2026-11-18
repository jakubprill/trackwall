import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

/**
 * The work backup's file (ADR-275): a gzipped tar in the ustar format, which `tar` on every system lists and unpacks,
 * written by hand because Node has no tar and the entries are few, regular files with short names Trackwall chose
 * (`manifest.json`, `repos/<n>.bundle`, `state/<n>`), so no other name from a repo or a file ever lands in a header.
 */

const BLOCK = 512;
/** ustar keeps a name in 100 bytes; Trackwall's own names are far shorter. */
const MAX_NAME_BYTES = 100;
/** A size in the header is 11 octal digits: up to 8 GiB per entry. */
const MAX_ENTRY_BYTES = 8 * 1024 ** 3 - 1;

/**
 * Where an entry of the archive (`repos/<n>.bundle`, `state/<n>`) sits as a file in `dir`, while a backup is made or
 * after one is unpacked: a name made from Trackwall's own entry name, flat in `dir`.
 */
export function entryFile(dir: string, entry: string): string {
  return join(dir, entry.replace("/", "-"));
}

/** One file of the archive: its name in it, and either the bytes or a file on disk to copy. */
export type ArchiveEntry = { name: string; data: Buffer } | { name: string; file: string };

/** Writes `entries` in order into the gzipped tar `out`, a new file. */
export async function writeArchive(out: string, entries: readonly ArchiveEntry[], mtime: Date): Promise<void> {
  const tar = new PassThrough();
  const written = pipeline(tar, createGzip(), createWriteStream(out, { flags: "wx" }));
  try {
    for (const entry of entries) await writeEntry(tar, entry, mtime);
    // Two empty blocks end a tar.
    tar.end(Buffer.alloc(2 * BLOCK));
  } catch (err) {
    tar.destroy(err as Error);
  }
  await written;
}

async function writeEntry(tar: PassThrough, entry: ArchiveEntry, mtime: Date): Promise<void> {
  const size = "data" in entry ? entry.data.length : (await stat(entry.file)).size;
  await write(tar, header(entry.name, size, mtime));
  if ("data" in entry) await write(tar, entry.data);
  else await copy(createReadStream(entry.file, { start: 0, end: Math.max(0, size - 1) }), tar, size);
  const padding = (BLOCK - (size % BLOCK)) % BLOCK;
  if (padding > 0) await write(tar, Buffer.alloc(padding));
}

/** Copies exactly `size` bytes: a file that grew while it was copied would break every entry after it. */
async function copy(from: Readable, to: PassThrough, size: number): Promise<void> {
  let copied = 0;
  for await (const chunk of from) {
    const bytes = chunk as Buffer;
    const part = bytes.subarray(0, Math.max(0, size - copied));
    copied += part.length;
    await write(to, part);
  }
  if (copied < size) throw new Error(`a file of the backup shrank while it was copied (${copied} of ${size} bytes)`);
}

function write(stream: PassThrough, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (bytes.length === 0) return resolve();
    stream.write(bytes, (err) => (err ? reject(err) : resolve()));
  });
}

/** A ustar header of a regular file, mode 0600, owned by nobody in particular. */
function header(name: string, size: number, mtime: Date): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  if (nameBytes.length > MAX_NAME_BYTES || name.includes("..") || name.startsWith("/"))
    throw new Error(`not a name for the backup archive: ${name}`);
  if (size > MAX_ENTRY_BYTES) throw new Error(`${name} is larger than a tar entry can hold`);
  const block = Buffer.alloc(BLOCK);
  nameBytes.copy(block, 0);
  block.write(octal(0o600, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(Math.floor(mtime.getTime() / 1000), 12), 136, "ascii");
  // The checksum is summed with its own field as spaces.
  block.write("        ", 148, "ascii");
  block.write("0", 156, "ascii");
  block.write("ustar\u000000", 257, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, "ascii");
  return block;
}

/** A number as `width - 1` octal digits and a NUL, as ustar spells it. */
function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\u0000`;
}
