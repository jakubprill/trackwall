import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, CopyToClipboardResult, ListSessionsResult } from "@trackwall/protocol";
import { OscParser } from "../src/modules/agents/osc-parser.ts";
import { viewer, waitFor } from "./support/agents.ts";
import { connectHttpClient, connectSessionClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "c".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
}, 30_000);

async function clientOf(session: string | null): Promise<Client> {
  const client =
    session === null ? await connectHttpClient(daemon.api.port, TOKEN) : await connectSessionClient(daemon.api.port, daemon.home, session);
  clients.push(client);
  return client;
}

/** A running main session in the repo root and its MCP client. */
async function mainSession() {
  const main = await daemon.facade.agents.start("shop");
  await waitFor(daemon.facade.agents, main.id, (s) => s.state !== null, "the input box");
  return { id: main.id, client: await clientOf(main.id) };
}

const copyRequestOf = (id: string) => daemon.facade.agents.session(id).copyRequest;

describe.skipIf(process.versions.bun === undefined)("copy_to_clipboard (real PTY, fake Copilot CLI)", () => {
  test("the text waits in the session for the user's click, and copying it clears it, but not a newer one", async () => {
    const main = await mainSession();
    const command = "mvn -pl orders verify\n\tthen: git push";

    const result = await main.client.callTool({ name: "copy_to_clipboard", arguments: { text: command } });

    expect(CopyToClipboardResult.parse(result.structuredContent)).toEqual({ waitsFor: "user_click" });
    const first = copyRequestOf(main.id);
    expect(first).toEqual({ id: expect.any(String), text: command, at: expect.any(String) });

    await main.client.callTool({ name: "copy_to_clipboard", arguments: { text: "mvn verify" } });
    const second = copyRequestOf(main.id);
    expect(second?.text).toBe("mvn verify");
    // The user's click on the first one, which a newer one replaced in the meantime, leaves the newer one.
    await daemon.post(agentsApi.clearCopyRequest, { session: main.id, request: first?.id ?? "" });
    expect(copyRequestOf(main.id)).toEqual(second);

    const cleared = await daemon.post(agentsApi.clearCopyRequest, { session: main.id, request: second?.id ?? "" });

    expect(cleared.copyRequest).toBeNull();
    await daemon.facade.agents.stop(main.id);
  });

  test("another session does not see what a session asked to copy", async () => {
    const main = await mainSession();
    await main.client.callTool({ name: "copy_to_clipboard", arguments: { text: "a token the user asked for" } });
    const other = await mainSession();

    const listed = ListSessionsResult.parse((await other.client.callTool({ name: "list_sessions", arguments: {} })).structuredContent);

    expect(JSON.stringify(listed)).not.toContain("a token the user asked for");
    expect(listed.sessions.find((s) => s.id === main.id)).not.toHaveProperty("copyRequest");
    await daemon.facade.agents.stop(main.id);
    await daemon.facade.agents.stop(other.id);
  });

  test("an ended session drops its copy request, and an agent outside Trackwall cannot ask", async () => {
    const main = await mainSession();
    await main.client.callTool({ name: "copy_to_clipboard", arguments: { text: "echo hi" } });

    await daemon.facade.agents.stop(main.id);

    expect(copyRequestOf(main.id)).toBeNull();
    const outside = await clientOf(null);
    expect((await outside.callTool({ name: "copy_to_clipboard", arguments: { text: "echo hi" } })).content).toEqual([
      {
        type: "text",
        text: "bad_request: only a running session in Trackwall can ask to copy; give the user the text in your answer",
      },
    ]);
  });

  test("text with an escape sequence or an invisible character is refused, so a paste carries only what the user read", async () => {
    const main = await mainSession();

    // ESC [ 2 0 1 ~ ends a bracketed paste in a terminal, and the rest would run as typed keys.
    const withEscape = await main.client.callTool({ name: "copy_to_clipboard", arguments: { text: "ls\u001b[201~rm -rf ~\r" } });
    // U+202E turns the text around on the screen: the strip would show another command than the paste.
    const hidden = await main.client.callTool({ name: "copy_to_clipboard", arguments: { text: `ls${String.fromCodePoint(0x202e)}rm` } });

    expect(withEscape.isError).toBe(true);
    expect(JSON.stringify(withEscape.content)).toContain("control characters other than line breaks and tabs, nor invisible characters");
    expect(hidden.isError).toBe(true);
    expect(copyRequestOf(main.id)).toBeNull();
    await daemon.facade.agents.stop(main.id);
  });
});

describe.skipIf(process.versions.bun === undefined)("/copy in the session terminal (real PTY, fake Copilot CLI)", () => {
  test("Enter on /copy sends the last answer as OSC 52 to the terminal, which copies it", async () => {
    const main = await mainSession();
    const window = viewer(daemon.facade.agents, main.id);
    window.attachment.input("what is in this repo?\r");
    await waitFor(daemon.facade.agents, main.id, (s) => s.state?.state === "Approval", "the approval request");
    window.attachment.input("1");
    await waitFor(daemon.facade.agents, main.id, (s) => s.state?.reason === "hook agentStop", "the end of the turn");
    await new Promise((resolve) => setTimeout(resolve, 500));

    // The fake keeps Copilot CLI's /copy (the contract test); the screen the session terminal reads on Enter
    // (`entersCopyCommand`) is the contract test's, since the fake echoes keys under its input box, not in it.
    window.attachment.input("/copy\r");
    const copies = () => new OscParser().feed(window.text()).filter((osc) => osc.code === "52");
    await waitFor(daemon.facade.agents, main.id, () => copies().length > 0, "the OSC 52 copy");

    expect(copies().map((osc) => osc.data)).toEqual([`c;${Buffer.from("Thinking about: what is in this repo?").toString("base64")}`]);
    window.attachment.detach();
    await daemon.facade.agents.stop(main.id);
  });
});
