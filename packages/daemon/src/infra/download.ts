import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Downloads a file Trackwall pins in its code (the jdtls release, ADR-123) and accepts it only when its SHA-256 matches:
 * a changed file on the server, a proxy that rewrites it or a cut transfer all fail, and the file is deleted.
 */
export async function downloadVerified(
  url: string,
  file: string,
  o: { sha256: string; maxBytes: number; timeoutMs: number },
): Promise<void> {
  const sha256 = await download(url, file, o);
  if (sha256 !== o.sha256) {
    await rm(file, { force: true });
    throw new Error(`${url} has SHA-256 ${sha256}, not the expected ${o.sha256}`);
  }
}

/**
 * Downloads `url` into `file` within a size and a time limit and returns its SHA-256; a failed or cut transfer deletes the
 * file. The caller checks what it got (a pinned hash, a signature, ADR-165). `fetch` follows redirects and, under Bun, the
 * proxy from `HTTPS_PROXY`.
 */
export async function download(url: string, file: string, o: { maxBytes: number; timeoutMs: number }): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(o.timeoutMs) });
    if (!response.ok || response.body === null) throw new Error(`${url} answered ${response.status} ${response.statusText}`);
    const hash = createHash("sha256");
    let size = 0;
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > o.maxBytes) return done(new Error(`${url} is larger than ${o.maxBytes} bytes`));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(chunksOf(response.body), counted, createWriteStream(file));
    return hash.digest("hex");
  } catch (err) {
    await rm(file, { force: true });
    throw err;
  }
}

/** The chunks of a response body; through its reader, since `fetch`'s stream type is not the one `Readable.fromWeb` takes. */
async function* chunksOf(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    // A download stopped early (the size limit, a failed write) ends the transfer too, instead of reading on to the time limit.
    await reader.cancel().catch(() => {});
  }
}
