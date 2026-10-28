import { z } from "zod";

/**
 * JSON-RPC 2.0 over newline-delimited JSON (§4.4, ADR-107): how the daemon speaks the Agent Client Protocol with
 * `copilot --acp` on its stdin and stdout. The daemon is the ACP client: it sends requests (`session/prompt`) and
 * notifications (`session/cancel`), and answers the agent's requests (`session/request_permission`). What the agent
 * sends is untrusted, so every line is parsed with a schema, and a line that is not JSON-RPC is dropped.
 */

/** A line longer than this is not a message the daemon reads; the rest of it is dropped up to the next newline. */
const MAX_LINE_CHARS = 4 * 1024 * 1024;

const RequestId = z.union([z.number(), z.string()]);

const Incoming = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: RequestId, method: z.string(), params: z.unknown().optional() }),
  z.object({ jsonrpc: z.literal("2.0"), method: z.string(), params: z.unknown().optional() }),
  z.object({ jsonrpc: z.literal("2.0"), id: RequestId, result: z.unknown() }),
  z.object({
    jsonrpc: z.literal("2.0"),
    id: RequestId.nullable(),
    error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }),
  }),
]);

/** An error answer to a request the daemon sent. */
export class AcpError extends Error {
  readonly code: number;

  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message} (${code})`);
    this.code = code;
  }
}

/** The connection ended (the process exited) before the agent answered. */
export class AcpClosed extends Error {}

export interface AcpConnectionDeps {
  /** Writes one line to the agent's stdin. */
  write: (line: string) => void;
  /** A notification from the agent (`session/update`). */
  onNotification: (method: string, params: unknown) => void;
  /** A request from the agent; the result is its answer, a rejection an error answer. */
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  log: (msg: string) => void;
}

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export class AcpConnection {
  readonly #deps: AcpConnectionDeps;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #buffer = "";
  /** Where the search for the next newline goes on, so a long line is not searched again with every chunk. */
  #scanned = 0;
  #skipping = false;
  #closed = false;

  constructor(deps: AcpConnectionDeps) {
    this.#deps = deps;
  }

  /** Sends a request and resolves with its result once the agent answers. */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new AcpClosed(`${method}: the agent has ended`));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.#closed) this.#send({ jsonrpc: "2.0", method, params });
  }

  /** A chunk of the agent's stdout. */
  feed(chunk: string): void {
    this.#buffer += chunk;
    for (let end = this.#buffer.indexOf("\n", this.#scanned); end >= 0; end = this.#buffer.indexOf("\n")) {
      const line = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 1);
      this.#scanned = 0;
      if (this.#skipping) this.#skipping = false;
      else this.#line(line);
    }
    this.#scanned = this.#buffer.length;
    if (this.#buffer.length > MAX_LINE_CHARS) {
      this.#deps.log(`ACP: a line over ${MAX_LINE_CHARS} characters is dropped`);
      this.#buffer = "";
      this.#scanned = 0;
      this.#skipping = true;
    }
  }

  /** The agent's process ended, or it did not answer in time: every request still waiting fails. */
  close(): void {
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.reject(new AcpClosed(`${pending.method}: the agent ended before it answered`));
    }
  }

  #line(line: string): void {
    if (line.trim() === "") return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      this.#deps.log("ACP: a line that is not JSON is dropped");
      return;
    }
    const parsed = Incoming.safeParse(json);
    if (!parsed.success) {
      this.#deps.log("ACP: a message that is not JSON-RPC is dropped");
      return;
    }
    const message = parsed.data;
    if ("method" in message) {
      if ("id" in message) this.#answer(message.id, message.method, message.params);
      else this.#deps.onNotification(message.method, message.params);
      return;
    }
    this.#settle(message);
  }

  #settle(message: { id: string | number | null; result?: unknown; error?: { code: number; message: string } }): void {
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) pending.reject(new AcpError(pending.method, message.error.code, message.error.message));
    else pending.resolve(message.result);
  }

  #answer(id: string | number, method: string, params: unknown): void {
    this.#deps.onRequest(method, params).then(
      (result) => this.#reply({ jsonrpc: "2.0", id, result }),
      (err: unknown) => this.#reply({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err) } }),
    );
  }

  #reply(message: unknown): void {
    if (!this.#closed) this.#send(message);
  }

  #send(message: unknown): void {
    this.#deps.write(`${JSON.stringify(message)}\n`);
  }
}
