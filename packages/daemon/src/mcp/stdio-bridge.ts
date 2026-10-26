import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { readDaemonFile } from "../infra/discovery.ts";
import { type LoopbackResponse, loopbackRequest } from "../infra/loopback.ts";
import { MCP_PATH } from "./endpoint.ts";

/**
 * The stdio bridge (`trackwall-daemon mcp-stdio`, §5.3, ADR-24): an agent CLI starts it as a local MCP server, and the bridge
 * passes every JSON-RPC message from stdin to `/mcp` of the running daemon and the replies to stdout. It reads the port and
 * token from `daemon.json` on every message, so a daemon restart does not require changing the agent's configuration, and the token
 * never goes into it. It is for an agent outside Trackwall; the daemon's own sessions reach `/mcp` over HTTP with their session
 * token (ADR-39, ADR-89). It knows nothing about the tools itself and does not start the daemon.
 */

/**
 * The longest tools wait for git and mise (15 s each) or for a session (`wait_for_session`, up to 55 s); with headroom for a slow
 * network drive holding the projects folder.
 */
const REQUEST_TIMEOUT_MS = 120_000;
/** The JSON-RPC code for a server-side error (the range -32000…-32099 is for implementations). */
const DAEMON_UNAVAILABLE = -32000;
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
/**
 * The probe of revision 2026-07-28 that a client (e.g. Copilot CLI) starts with before it tries `initialize`. In this revision an HTTP
 * request must repeat fields from the body in its headers (the version, method, tool name, chosen arguments), and over stdio
 * there are no headers; so the bridge answers like a server without this method and the client falls back to `initialize`, which
 * the bridge always speaks. HTTP clients talk to `/mcp` in both revisions.
 */
const DISCOVER_METHOD = "server/discover";

/** The message fields the bridge needs: the identifier for an error reply and the method for `initialize`. */
const Incoming = z.looseObject({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional() });
/** A message from the daemon: passed on only when it is JSON-RPC. */
const Outgoing = z.looseObject({ jsonrpc: z.literal("2.0") });
const Reply = z.looseObject({ id: z.union([z.string(), z.number(), z.null()]).optional() });
const TransportError = z.looseObject({ id: z.null(), error: z.looseObject({}) });
const InitializeResult = z.looseObject({ result: z.looseObject({ protocolVersion: z.string() }) });
const ApiErrorBody = z.object({ error: z.object({ message: z.string() }) });

export interface StdioBridgeOptions {
  /** The daemon's state directory with `daemon.json`. */
  home: string;
  input: Readable;
  output: Writable;
  log: (msg: string) => void;
}

/** Runs until the end of stdin, then waits for the replies to the messages already sent. */
export async function runStdioBridge(o: StdioBridgeOptions): Promise<void> {
  const write = (message: unknown) => o.output.write(`${JSON.stringify(message)}\n`);
  const session: Session = {};
  const pending = new Set<Promise<void>>();
  for await (const line of createInterface({ input: o.input, crlfDelay: Number.POSITIVE_INFINITY })) {
    if (line.trim() === "") continue;
    // Messages go in parallel: the agent may call several tools at once, and JSON-RPC pairs replies by `id`.
    const forwarded = forward(line, o, session, write).catch((err: unknown) => o.log(`forwarding a message: ${String(err)}`));
    pending.add(forwarded);
    void forwarded.finally(() => pending.delete(forwarded));
  }
  await Promise.all(pending);
}

/**
 * The protocol version agreed in `initialize`: over HTTP the client gives it in the header of every later request,
 * and over stdio there are no headers, so the bridge adds it.
 */
interface Session {
  protocolVersion?: string;
}

async function forward(line: string, o: StdioBridgeOptions, session: Session, write: (message: unknown) => void): Promise<void> {
  const incoming = parseIncoming(line);
  if (!incoming.ok) return write(incoming.reply);
  const { id, method } = incoming.message;
  if (method === DISCOVER_METHOD && id !== undefined) {
    return write(errorResponse(id, METHOD_NOT_FOUND, `the Trackwall stdio bridge does not support ${DISCOVER_METHOD}; use initialize`));
  }
  try {
    const replies = (await postToDaemon(line, o, session)).map((reply) => withRequestId(reply, id));
    if (method === "initialize") rememberProtocolVersion(replies, session);
    for (const reply of replies) write(reply);
    // A stream broken midway (e.g. a daemon exit) would leave the request without a reply until the client's time limit.
    const answered = replies.some((r) => Reply.safeParse(r).data?.id === id);
    if (method !== undefined && id !== undefined && !answered) throw new DaemonUnavailable("Trackwall did not answer the request");
  } catch (err) {
    if (!(err instanceof DaemonUnavailable)) throw err;
    o.log(err.message);
    // JSON-RPC expects no reply to a notification (without `id`), so the error stays only in the log.
    if (id !== undefined) write(errorResponse(id, DAEMON_UNAVAILABLE, err.message));
  }
}

/** The message fields the bridge needs, or an error reply for a line that is not a JSON-RPC object. */
function parseIncoming(
  line: string,
): { ok: true; message: z.infer<typeof Incoming> } | { ok: false; reply: ReturnType<typeof errorResponse> } {
  const json = parseJson(line);
  if (json === undefined) return { ok: false, reply: errorResponse(null, PARSE_ERROR, "the message is not valid JSON") };
  // Batches (arrays) are not in MCP since revision 2025-06-18, and Copilot CLI does not send them.
  const incoming = Incoming.safeParse(json);
  if (!incoming.success) return { ok: false, reply: errorResponse(null, INVALID_REQUEST, "the message is not a JSON-RPC object") };
  return { ok: true, message: incoming.data };
}

/**
 * The daemon returns a transport-level error (e.g. a header rejected by the SDK) with `id: null`, because HTTP does not tie it
 * to a request; over stdio the client pairs replies by `id`, so the bridge fills in the identifier of the request it answers.
 */
function withRequestId(reply: unknown, id: string | number | undefined): unknown {
  const transportError = TransportError.safeParse(reply);
  return transportError.success && id !== undefined ? { ...transportError.data, id } : reply;
}

function rememberProtocolVersion(replies: unknown[], session: Session): void {
  for (const reply of replies) {
    const init = InitializeResult.safeParse(reply);
    if (init.success) session.protocolVersion = init.data.result.protocolVersion;
  }
}

/** The daemon is not running, does not answer or rejected the request; `message` tells the user what to do. */
class DaemonUnavailable extends Error {}

/** The JSON-RPC messages the daemon answered `line` with (none for a notification). */
async function postToDaemon(line: string, o: StdioBridgeOptions, session: Session): Promise<unknown[]> {
  const daemon = readDaemonFile(o.home);
  if (!daemon) throw new DaemonUnavailable(`Trackwall is not running: no daemon.json in ${o.home}. Start the Trackwall app.`);
  let res: LoopbackResponse;
  try {
    res = await loopbackRequest(daemon.port, MCP_PATH, {
      method: "POST",
      token: daemon.token,
      body: line,
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session.protocolVersion && { "mcp-protocol-version": session.protocolVersion }),
      },
    });
  } catch (err) {
    throw new DaemonUnavailable(`Trackwall is not responding on port ${daemon.port} (${String(err)}). Start the Trackwall app.`);
  }
  const replies = res.headers["content-type"]?.startsWith("text/event-stream") ? sseData(res.body) : [parseJson(res.body)];
  const messages = replies.filter((m) => Outgoing.safeParse(m).success);
  if (res.status >= 400 && messages.length === 0) {
    const api = ApiErrorBody.safeParse(parseJson(res.body));
    throw new DaemonUnavailable(
      `Trackwall rejected the request (HTTP ${res.status}): ${api.success ? api.data.error.message : "no message"}`,
    );
  }
  return messages;
}

/** The contents of the `data:` fields of every SSE stream event as JSON; events without data (keepalive) are skipped. */
function sseData(body: string): unknown[] {
  return body
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice("data:".length).replace(/^ /, ""))
        .join("\n"),
    )
    .filter((data) => data !== "")
    .map(parseJson);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorResponse(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
