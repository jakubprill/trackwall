/**
 * An HTTP hook's POST for the fake Copilot CLI (`support/plugin-hooks.ts`): the payload from stdin to the URL in the first
 * argument with the headers (JSON) in the second, through `loopbackRequest`, since Bun's `fetch` would send it through
 * `HTTP_PROXY`.
 */
import { z } from "zod";
import { loopbackRequest } from "../../src/infra/loopback.ts";

const [url, headers] = process.argv.slice(2);
if (url === undefined || headers === undefined) throw new Error("usage: post-hook.ts <url> <headers JSON>");
const target = new URL(url);
await loopbackRequest(Number(target.port), target.pathname, {
  method: "POST",
  headers: z.record(z.string(), z.string()).parse(JSON.parse(headers)),
  body: await Bun.stdin.text(),
  timeoutMs: 5000,
});
