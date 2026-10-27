/**
 * Which sessions the daemon's MCP server has answered `tools/list` (a JSON body or server-sent events with the answer in a
 * `data:` line), so that a test can wait until a session has the Trackwall tools.
 */
import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { McpEndpoint } from "../../src/mcp/endpoint.ts";

/** A JSON-RPC answer to `tools/list`; other answers do not match. */
const ToolList = z.object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) });

function listsTools(body: string): boolean {
  const messages = body.trimStart().startsWith("{") ? [body] : body.split("\n").flatMap((l) => (l.startsWith("data:") ? [l.slice(5)] : []));
  return messages.some((m) => {
    try {
      return ToolList.safeParse(JSON.parse(m)).success;
    } catch {
      return false;
    }
  });
}

/** `endpoint` that also notes each calling session it answered `tools/list`. */
export function recordingToolLists(endpoint: McpEndpoint) {
  const listed = new Set<string>();
  const handle: McpEndpoint["handle"] = async (req, res, caller) => {
    const body = captureBody(res);
    await endpoint.handle(req, res, caller);
    if (caller !== null && listsTools(body())) listed.add(caller);
  };
  return {
    endpoint: { ...endpoint, handle },
    hasListedTools: (id: string): boolean => listed.has(id),
  };
}

/** What is written to `res`, as text once the response has ended (`send` in `mcp/endpoint.ts` writes it all with `write`). */
function captureBody(res: ServerResponse): () => string {
  const chunks: Buffer[] = [];
  const write = res.write.bind(res);
  // Only the chunk is taken; `write` itself gets every argument, so its overloads stay as they are.
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string" || chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as ServerResponse["write"];
  return () => Buffer.concat(chunks).toString("utf8");
}
