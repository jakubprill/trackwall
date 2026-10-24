import { type IncomingHttpHeaders, request } from "node:http";

/** Loopback addresses, as URL hosts, in the order a probe prefers them (ADR-45). */
export const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;
export type LoopbackHost = (typeof LOOPBACK_HOSTS)[number];

export interface LoopbackResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  /** The body was longer than `maxBodyBytes` and was cut there. */
  truncated: boolean;
}

export interface LoopbackOptions {
  /** `127.0.0.1` by default. */
  host?: LoopbackHost;
  method?: string;
  token?: string;
  headers?: Record<string, string>;
  /** Deadline for the whole request, response body included (1.5 s by default). */
  timeoutMs?: number;
  body?: string;
  /** Read at most this many bytes of the body; the rest is dropped and `truncated` set. */
  maxBodyBytes?: number;
}

/**
 * An HTTP request to a process on loopback through `node:http`, not `fetch`. Bun's `fetch` sends loopback addresses
 * through `HTTP_PROXY` too unless `NO_PROXY` lists 127.0.0.1, which on a computer behind a proxy would look like
 * "the daemon is not running".
 */
export function loopbackRequest(port: number, path: string, opts: LoopbackOptions = {}): Promise<LoopbackResponse> {
  const max = opts.maxBodyBytes ?? Number.POSITIVE_INFINITY;
  const timeoutMs = opts.timeoutMs ?? 1500;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "content-length": String(Buffer.byteLength(opts.body ?? "")), ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const req = request({ host: opts.host ?? "127.0.0.1", port, path, method: opts.method ?? "GET", headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const finish = () => {
        clearTimeout(deadline);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), truncated });
      };
      res.on("data", (c: Buffer) => {
        if (truncated) return;
        chunks.push(c.subarray(0, Math.max(0, max - size)));
        size += c.length;
        if (size <= max) return;
        // Without reading the rest: a response without an end (an event stream) does not hold the caller.
        truncated = true;
        finish();
        req.destroy();
      });
      res.on("end", finish);
      res.on("error", reject);
    });
    // A deadline, not the socket's idle timeout: a stream that sends a keepalive now and then would reset that forever.
    const deadline = setTimeout(() => req.destroy(new Error(`no response within ${timeoutMs} ms`)), timeoutMs);
    req.on("error", (err) => {
      clearTimeout(deadline);
      reject(err);
    });
    req.end(opts.body);
  });
}
