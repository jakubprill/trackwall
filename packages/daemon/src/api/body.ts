import type { IncomingMessage } from "node:http";
import { DomainError } from "../errors.ts";

/**
 * Całe ciało żądania, najwyżej `maxBytes`: większe jest odrzucane, zanim trafi do pamięci w całości.
 * Wspólne dla tras API i serwera MCP.
 */
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new DomainError("bad_request", `ciało żądania większe niż ${maxBytes} bajtów`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
