import { type IncomingHttpHeaders, request } from "node:http";

export interface LoopbackResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  /** The body was longer than `maxBodyBytes` and was cut there. */
  truncated: boolean;
}

export interface LoopbackOptions {
  /** `127.0.0.1` (default) or `::1`. */
  host?: "127.0.0.1" | "::1";
  method?: string;
  token?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  body?: string;
  /** Read at most this many bytes of the body; the rest is dropped and `truncated` set. */
  maxBodyBytes?: number;
}

/**
 * Żądanie HTTP do procesu na loopbacku przez `node:http`, nie `fetch`.
 * `fetch` w Bun kieruje także adresy loopback przez `HTTP_PROXY`, jeśli `NO_PROXY` nie wymienia 127.0.0.1,
 * co na komputerze z proxy wyglądałoby jak „daemon nie działa”.
 */
export function loopbackRequest(port: number, path: string, opts: LoopbackOptions = {}): Promise<LoopbackResponse> {
  const max = opts.maxBodyBytes ?? Number.POSITIVE_INFINITY;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "content-length": String(Buffer.byteLength(opts.body ?? "")), ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const host = opts.host ?? "127.0.0.1";
    const req = request({ host, port, path, method: opts.method ?? "GET", headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const finish = () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), truncated });
      res.on("data", (c: Buffer) => {
        if (truncated) return;
        chunks.push(c.subarray(0, Math.max(0, max - size)));
        size += c.length;
        if (size <= max) return;
        // Bez czytania reszty: odpowiedź bez końca (strumień zdarzeń) nie trzyma wołającego.
        truncated = true;
        finish();
        req.destroy();
      });
      res.on("end", finish);
      res.on("error", reject);
    });
    req.setTimeout(opts.timeoutMs ?? 1500, () => req.destroy(new Error(`no response within ${opts.timeoutMs ?? 1500} ms`)));
    req.on("error", reject);
    req.end(opts.body);
  });
}
