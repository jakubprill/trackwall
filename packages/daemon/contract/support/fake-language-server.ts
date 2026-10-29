/**
 * A stand-in language server for the contract tests (ADR-124): it answers LSP's `initialize` with no capabilities and
 * writes the request's `initializationOptions` as JSON to the file named by its first argument, so a test sees what
 * Copilot CLI passed on from an `lspServers` entry. LSP frames each message with a `Content-Length` header; it needs
 * nothing but the runtime.
 */
import { writeFileSync } from "node:fs";
import { z } from "zod";

const argument = process.argv[2];
if (argument === undefined) throw new Error("fake language server: no file for initializationOptions");
const optionsFile: string = argument;

const Message = z.looseObject({
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().optional(),
  params: z.looseObject({ initializationOptions: z.unknown().optional() }).optional(),
});

function send(message: object): void {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function handle(message: z.infer<typeof Message>): void {
  if (message.method === "initialize") {
    writeFileSync(optionsFile, JSON.stringify(message.params?.initializationOptions ?? null));
    send({ id: message.id, result: { capabilities: {}, serverInfo: { name: "fake-language-server" } } });
  } else if (message.method === "shutdown") send({ id: message.id, result: null });
  else if (message.method === "exit") process.exit(0);
  else if (message.id !== undefined && message.method !== undefined) send({ id: message.id, result: null });
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString("ascii"))?.[1]);
    if (!Number.isInteger(length) || buffer.length < headerEnd + 4 + length) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
    buffer = buffer.subarray(headerEnd + 4 + length);
    const parsed = Message.safeParse(JSON.parse(body));
    if (parsed.success) handle(parsed.data);
  }
});
