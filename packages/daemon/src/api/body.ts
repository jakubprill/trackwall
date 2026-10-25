import type { IncomingMessage } from "node:http";
import { DomainError } from "../infra/errors.ts";

/**
 * The whole request body, at most `maxBytes`: a larger one is rejected before it is held in memory in full.
 * Shared by the API routes and the MCP server.
 */
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new DomainError("bad_request", `request body larger than ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
