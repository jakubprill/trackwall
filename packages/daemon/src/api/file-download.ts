import type { ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { PlaceFile } from "@trackwall/protocol";
import { z } from "zod";
import type { FileDownload } from "../facade.ts";
import { DomainError } from "../infra/errors.ts";

/**
 * `POST /api/terminals/download` (ADR-188, §5.2): one file of a place's folder as its bytes, the one action whose answer
 * is not `{ ok, data }`. The body names the file like the list does; the file is opened by `folderFiles` before any
 * header goes out, so a refusal is still the usual JSON error.
 */

export function downloadRequest(body: unknown): PlaceFile {
  const parsed = PlaceFile.safeParse(body);
  if (!parsed.success) throw new DomainError("bad_request", z.prettifyError(parsed.error));
  return parsed.data;
}

/** Streams the opened file and closes it; a file that grew meanwhile is cut at the size its headers announced. */
export async function sendDownload(res: ServerResponse, file: FileDownload): Promise<void> {
  try {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(file.size),
      // The page names the saved file itself; this is for a client that saves the answer as it comes.
      "content-disposition": `attachment; filename*=UTF-8''${headerFileName(file.name)}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    if (file.size === 0) return void res.end();
    await pipeline(file.handle.createReadStream({ start: 0, end: file.size - 1, autoClose: false }), res);
  } catch {
    // Once the headers are out, the only way to say it failed is to cut the answer short of its length.
    res.destroy();
  } finally {
    await file.handle.close().catch(() => {});
  }
}

/** Half of a UTF-16 pair without its other half. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * A file name as RFC 5987 spells it in `filename*`: UTF-8 percent-encoded, `'()*` too, which `encodeURIComponent`
 * leaves. A name with a lone surrogate (possible on Windows) gets U+FFFD in its place, since encoding it would throw.
 */
export function headerFileName(name: string): string {
  const wellFormed = name.replace(LONE_SURROGATE, "\uFFFD");
  return encodeURIComponent(wellFormed).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
