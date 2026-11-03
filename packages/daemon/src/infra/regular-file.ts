import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";

/**
 * Reading a small file a repo or an agent may have planted (`local-config` and `cards`, ADR-86): only a regular file,
 * never through a link (`O_NOFOLLOW` where the system has it, and on Windows the identity of the opened file against the
 * `lstat` before it, so a link swapped in between is refused), never a FIFO that would block a thread (`O_NONBLOCK`), and
 * never more than `maxBytes`, checked on the opened file, so `/dev/zero` cannot fill the memory.
 */

/** `O_NOFOLLOW` and `O_NONBLOCK` are 0 where the system lacks them (Windows), which leaves the flags as they were. */
const FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** The file is over the caller's limit; a class of its own so a caller can say what to do instead. */
export class FileTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(path: string, maxBytes: number) {
    super(`${path} is larger than ${sizeLabel(maxBytes)}`);
    this.maxBytes = maxBytes;
  }
}

/** The path is a link, a folder, a FIFO or a device, or became one while it was opened. */
export class NotRegularFileError extends Error {}

/** The file's content; `undefined` when nothing is at `path`, and an error for a link, a non-regular file or one over the limit. */
export async function readRegularFile(path: string, maxBytes: number): Promise<Buffer | undefined> {
  const opened = await openRegularFile(path, maxBytes);
  if (!opened) return undefined;
  const { handle } = opened;
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new FileTooLargeError(path, maxBytes);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * The file opened for reading, with its size, under the same rules; the caller closes the handle. Also for a file
 * streamed out rather than read whole (a download from a place's folder, ADR-187).
 */
export async function openRegularFile(path: string, maxBytes: number): Promise<{ handle: FileHandle; size: number } | undefined> {
  const before = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  if (!before) return undefined;
  if (!before.isFile()) throw new NotRegularFileError(`${path} is not a regular file (a link or a folder)`);
  const handle = await open(path, FLAGS).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ELOOP") throw new NotRegularFileError(`${path} is not a regular file (a link or a folder)`);
    throw err;
  });
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev)
      throw new NotRegularFileError(`${path} changed into something other than a regular file while it was read`);
    if (opened.size > maxBytes) throw new FileTooLargeError(path, maxBytes);
    return { handle, size: opened.size };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

/** A limit as people read it: KB up to a megabyte, MB above. */
function sizeLabel(bytes: number): string {
  return bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}
