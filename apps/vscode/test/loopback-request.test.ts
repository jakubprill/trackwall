import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loopbackRequest, parseResponse } from "../src/loopback-request.ts";

let server: Server;
let port: number;
const seen: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8");
    });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, data: "zażółć" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("a request to the daemon on 127.0.0.1", () => {
  test("goes straight to the port with the token in the header, even with a proxy set for the process", async () => {
    process.env.HTTP_PROXY = "http://127.0.0.1:9";
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    try {
      const res = await loopbackRequest(port, "/api/viewer/sessions", { method: "POST", token: "secret-token", body: "{}" });
      expect(res).toEqual({ status: 200, body: JSON.stringify({ ok: true, data: "zażółć" }) });
    } finally {
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
    }
    expect(seen.at(-1)).toMatchObject({
      method: "POST",
      url: "/api/viewer/sessions",
      headers: { host: `127.0.0.1:${port}`, authorization: "Bearer secret-token", "content-type": "application/json" },
      body: "{}",
    });
  });

  test("a GET sends no token when it has none", async () => {
    await loopbackRequest(port, "/api/health", { method: "GET" });
    expect(seen.at(-1)?.headers.authorization).toBeUndefined();
  });

  test("a closed port fails instead of hanging", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const free = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(loopbackRequest(free, "/api/health", { method: "GET" })).rejects.toThrow();
  });
});

describe("reading the daemon's answer", () => {
  test("a body shorter than its Content-Length is an error, not a short answer", () => {
    expect(() => parseResponse(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n{}"))).toThrow("cut off");
  });

  test("a chunked answer, as Bun's server sends it, is put together", () => {
    const raw = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{"ok"\r\n6\r\n:true}\r\n0\r\n\r\n';
    expect(parseResponse(Buffer.from(raw))).toEqual({ status: 200, body: '{"ok":true}' });
  });

  test("a chunked answer without its last chunk is an error", () => {
    expect(() => parseResponse(Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{"ok"\r\n'))).toThrow("cut off");
  });

  test("something that is not HTTP is refused", () => {
    expect(() => parseResponse(Buffer.from("SSH-2.0-OpenSSH_9.6\r\n\r\n"))).toThrow("not HTTP");
  });
});
