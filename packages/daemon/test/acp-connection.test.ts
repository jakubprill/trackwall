import { describe, expect, test } from "bun:test";
import { AcpClosed, AcpConnection, AcpError } from "../src/modules/agents/acp-connection.ts";

function connection(onRequest: (method: string, params: unknown) => Promise<unknown> = async () => ({})) {
  const sent: unknown[] = [];
  const notifications: [string, unknown][] = [];
  const log: string[] = [];
  const acp = new AcpConnection({
    write: (line) => sent.push(JSON.parse(line)),
    onNotification: (method, params) => notifications.push([method, params]),
    onRequest,
    log: (msg) => log.push(msg),
  });
  return { acp, sent, notifications, log };
}

describe("JSON-RPC with the agent over ACP", () => {
  test("a request resolves with the answer of its id, which may come in pieces and after other lines", async () => {
    const { acp, sent } = connection();
    const answer = acp.request("session/new", { cwd: "/projects" });

    expect(sent).toEqual([{ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/projects" } }]);
    acp.feed('{"jsonrpc":"2.0","method":"session/update","params":{}}\n{"jsonrpc":"2.0","id":1,');
    acp.feed('"result":{"sessionId":"s1"}}\n');
    expect(await answer).toEqual({ sessionId: "s1" });
  });

  test("an error answer rejects the request with its code", async () => {
    const { acp } = connection();
    const answer = acp.request("session/load", { sessionId: "gone" });
    acp.feed('{"jsonrpc":"2.0","id":1,"error":{"code":-32002,"message":"Session gone not found"}}\n');

    const err = await answer.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcpError);
    expect(err).toMatchObject({ code: -32002, message: "session/load: Session gone not found (-32002)" });
  });

  test("notifications go to the session, and the agent's requests get the session's answer under their id", async () => {
    const { acp, sent, notifications } = connection(async (method) => ({ answered: method }));
    acp.feed('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1"}}\n');
    acp.feed('{"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{}}\n');
    await new Promise((r) => setTimeout(r, 0));

    expect(notifications).toEqual([["session/update", { sessionId: "s1" }]]);
    expect(sent).toEqual([{ jsonrpc: "2.0", id: 0, result: { answered: "session/request_permission" } }]);
  });

  test("a request the session refuses gets an error answer", async () => {
    const { acp, sent } = connection(() => Promise.reject(new Error("fs/read_text_file is not offered")));
    acp.feed('{"jsonrpc":"2.0","id":7,"method":"fs/read_text_file","params":{}}\n');
    await new Promise((r) => setTimeout(r, 0));

    expect(sent).toEqual([{ jsonrpc: "2.0", id: 7, error: { code: -32603, message: "Error: fs/read_text_file is not offered" } }]);
  });

  test("a line that is not JSON-RPC is dropped and the next one is read", async () => {
    const { acp, log } = connection();
    const answer = acp.request("initialize", {});
    acp.feed("Starting Copilot…\n");
    acp.feed('{"id":1,"result":"no jsonrpc"}\n');
    acp.feed('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n');

    expect(await answer).toEqual({ protocolVersion: 1 });
    expect(log).toEqual(["ACP: a line that is not JSON is dropped", "ACP: a message that is not JSON-RPC is dropped"]);
  });

  test("a line over 4 MiB is dropped up to its end, without keeping it in memory", async () => {
    const { acp, log } = connection();
    const answer = acp.request("initialize", {});
    acp.feed("x".repeat(4 * 1024 * 1024 + 1));
    acp.feed('more","id":1}\n{"jsonrpc":"2.0","id":1,"result":"ok"}\n');

    expect(await answer).toBe("ok");
    expect(log).toEqual(["ACP: a line over 4194304 characters is dropped"]);
  });

  test("when the agent ends, the requests still waiting fail and nothing more is sent", async () => {
    const { acp, sent } = connection();
    const answer = acp.request("session/prompt", {});
    acp.close();

    expect(await answer.catch((e: unknown) => e)).toBeInstanceOf(AcpClosed);
    await expect(acp.request("session/prompt", {})).rejects.toBeInstanceOf(AcpClosed);
    acp.notify("session/cancel", {});
    expect(sent).toHaveLength(1);
  });
});
