import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loopbackRequest } from "../src/infra/loopback.ts";

describe("loopback request deadline", () => {
  test("a stream that keeps sending is cut at the deadline, not kept open by its keepalives", async () => {
    const stream: Server = createServer((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const timer = setInterval(() => res.write(": ping\n"), 100);
      res.on("close", () => clearInterval(timer));
    });
    await new Promise<void>((resolve) => stream.listen(0, "127.0.0.1", resolve));
    const { port } = stream.address() as AddressInfo;
    const began = Date.now();

    await expect(loopbackRequest(port, "/events", { timeoutMs: 500 })).rejects.toThrow("no response within 500 ms");

    expect(Date.now() - began).toBeLessThan(2000);
    stream.closeAllConnections();
    await new Promise((resolve) => stream.close(resolve));
  });
});
