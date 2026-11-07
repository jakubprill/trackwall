import { connect } from "node:net";

/**
 * One HTTP/1.1 request to the daemon on `127.0.0.1`, written on a plain TCP socket. VS Code routes Node's `http`,
 * `https` and `fetch` through the proxy of its settings or of `HTTP_PROXY`; a socket of its own keeps the request, and
 * the token in it, on this computer whatever proxy is set. With `Connection: close` the client reads the answer until
 * the socket closes, then checks it against its `Content-Length` or decodes its chunks (Bun's `node:http` sends chunks).
 */

const LOOPBACK_HOST = "127.0.0.1";
/** A viewer's answers are a few kilobytes; more is not the daemon. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** The whole request, answer included: a program that took the port and answers a byte at a time does not hold the look. */
const TIMEOUT_MS = 3000;

export interface LoopbackResponse {
  status: number;
  body: string;
}

export function loopbackRequest(
  port: number,
  path: string,
  o: { method: "GET" | "POST"; token?: string; body?: string },
): Promise<LoopbackResponse> {
  const body = Buffer.from(o.body ?? "", "utf8");
  const head = [
    `${o.method} ${path} HTTP/1.1`,
    `Host: ${LOOPBACK_HOST}:${port}`,
    "Connection: close",
    "Accept: application/json",
    ...(o.token === undefined ? [] : [`Authorization: Bearer ${o.token}`]),
    ...(o.method === "POST" ? ["Content-Type: application/json", `Content-Length: ${body.length}`] : []),
  ];
  return new Promise((resolve, reject) => {
    const socket = connect({ host: LOOPBACK_HOST, port });
    const chunks: Buffer[] = [];
    let received = 0;
    const deadline = setTimeout(
      () => socket.destroy(new Error(`no answer from ${LOOPBACK_HOST}:${port} within ${TIMEOUT_MS} ms`)),
      TIMEOUT_MS,
    );
    socket.once("close", () => clearTimeout(deadline));
    // `write`, not `end`: Bun's server drops the answer of a client that half-closes; `Connection: close` ends the socket.
    socket.once("connect", () => socket.write(Buffer.concat([Buffer.from(`${head.join("\r\n")}\r\n\r\n`, "latin1"), body])));
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_RESPONSE_BYTES) return void socket.destroy(new Error("the answer is too large"));
      chunks.push(chunk);
    });
    socket.once("error", reject);
    socket.once("close", (hadError) => {
      if (hadError) return;
      try {
        resolve(parseResponse(Buffer.concat(chunks)));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** The status and body of a whole HTTP/1.1 response read until the socket closed. */
export function parseResponse(raw: Buffer): LoopbackResponse {
  const end = raw.indexOf("\r\n\r\n");
  if (end < 0) throw new Error("the answer has no HTTP header");
  const lines = raw.subarray(0, end).toString("latin1").split("\r\n");
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? "")?.[1];
  if (status === undefined) throw new Error("the answer is not HTTP/1.1");
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error("the answer has a damaged header");
    const name = line.slice(0, colon).trim().toLowerCase();
    if (headers.has(name)) throw new Error(`the answer repeats its ${name} header`);
    headers.set(name, line.slice(colon + 1).trim());
  }
  const rest = raw.subarray(end + 4);
  if (headers.get("transfer-encoding")?.toLowerCase() === "chunked")
    return { status: Number(status), body: dechunk(rest).toString("utf8") };
  const length = headers.get("content-length");
  if (length !== undefined && Number(length) !== rest.length) throw new Error("the answer was cut off");
  return { status: Number(status), body: rest.toString("utf8") };
}

/** The body of a chunked answer; one that ends before its last, empty chunk was cut off. */
function dechunk(raw: Buffer): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = raw.indexOf("\r\n", at);
    if (lineEnd < 0) throw new Error("the answer was cut off");
    const sizeText = raw.subarray(at, lineEnd).toString("latin1").split(";")[0]?.trim() ?? "";
    if (!/^[0-9a-f]{1,8}$/i.test(sizeText)) throw new Error("the answer has a damaged chunk");
    const size = Number.parseInt(sizeText, 16);
    if (size === 0) return Buffer.concat(parts);
    const start = lineEnd + 2;
    if (raw.length < start + size + 2) throw new Error("the answer was cut off");
    parts.push(raw.subarray(start, start + size));
    at = start + size + 2;
  }
}
