import { request } from "node:http";

export interface LoopbackResponse {
  status: number;
  body: string;
}

/**
 * Żądanie HTTP do procesu na 127.0.0.1 przez `node:http`, nie `fetch`.
 * `fetch` w Bun kieruje także adresy loopback przez `HTTP_PROXY`, jeśli `NO_PROXY` nie wymienia 127.0.0.1,
 * co na firmowym komputerze z proxy wyglądałoby jak „daemon nie działa”.
 */
export function loopbackRequest(
  port: number,
  path: string,
  opts: { method?: string; token?: string; timeoutMs?: number } = {},
): Promise<LoopbackResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "content-length": "0" };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.setTimeout(opts.timeoutMs ?? 1500, () => req.destroy(new Error(`timeout ${path}`)));
    req.on("error", reject);
    req.end();
  });
}
