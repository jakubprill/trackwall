import { type IncomingHttpHeaders, request } from "node:http";

export interface LoopbackResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface LoopbackOptions {
  method?: string;
  token?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Żądanie HTTP do procesu na 127.0.0.1 przez `node:http`, nie `fetch`.
 * `fetch` w Bun kieruje także adresy loopback przez `HTTP_PROXY`, jeśli `NO_PROXY` nie wymienia 127.0.0.1,
 * co na komputerze z proxy wyglądałoby jak „daemon nie działa”.
 */
export function loopbackRequest(port: number, path: string, opts: LoopbackOptions = {}): Promise<LoopbackResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "content-length": "0", ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.setTimeout(opts.timeoutMs ?? 1500, () => req.destroy(new Error(`timeout ${path}`)));
    req.on("error", reject);
    req.end();
  });
}
