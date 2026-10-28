import type { RawData } from "ws";

/** A text frame from a client as JSON; `ws` gives it as a `Buffer`, in pieces or as an `ArrayBuffer`. `undefined` for one that is not JSON. */
export function parseJsonFrame(data: RawData): unknown {
  const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(new Uint8Array(data));
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}
