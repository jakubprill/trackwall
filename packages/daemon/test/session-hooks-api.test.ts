import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentsApi } from "@trackwall/protocol";
import { loopbackRequest } from "../src/infra/loopback.ts";
import { sessionHooksFile } from "../src/modules/agents/session-launcher.ts";
import { startSessionApi } from "./support/session-api.ts";
import { sessionToken as tokenOf } from "./support/session-token.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "h".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(() => daemon.stop());

function postHook(path: string, headers: Record<string, string>, payload: unknown) {
  return loopbackRequest(daemon.api.port, path, { method: "POST", headers, body: JSON.stringify(payload), timeoutMs: 10_000 });
}

describe.skipIf(process.versions.bun === undefined)("session plugin hooks and the session token over HTTP (ADR-88, ADR-138)", () => {
  test("the plugin registers every hook as a POST to the daemon's hook route with the session token alone", async () => {
    const session = await daemon.post(agentsApi.start, { repo: "shop" });
    const sessionToken = tokenOf(daemon.home, session.id);

    const hooksJson = JSON.parse(readFileSync(join(daemon.home, "sessions", session.id, "plugin", "hooks.json"), "utf8"));

    expect(Object.keys(hooksJson.hooks)).toEqual([
      "sessionStart",
      "userPromptSubmitted",
      "postToolUse",
      "notification",
      "agentStop",
      "errorOccurred",
      "sessionEnd",
    ]);
    expect(hooksJson.hooks.agentStop).toEqual([
      {
        type: "http",
        url: `http://127.0.0.1:${daemon.api.port}/hooks/agentStop`,
        headers: { "x-trackwall-session-token": sessionToken },
        timeoutSec: 5,
      },
    ]);
    await daemon.post(agentsApi.stop, { session: session.id });
  }, 60_000);

  test("a hook with the session token appends its record to the session's hooks.jsonl and answers with an empty hook output", async () => {
    const session = await daemon.post(agentsApi.start, { repo: "shop" });
    const sessionToken = tokenOf(daemon.home, session.id);

    const res = await postHook(
      "/hooks/agentStop",
      { "x-trackwall-session-token": sessionToken },
      { sessionId: "s1", timestamp: 1, cwd: "/repo", stopReason: "end_turn", transcriptPath: "/x/events.jsonl" },
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe("{}");
    const records = readFileSync(sessionHooksFile(daemon.home, session.id), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toMatchObject([
      { event: "agentStop", payload: { sessionId: "s1", timestamp: 1, stopReason: "end_turn" }, omitted: ["cwd", "transcriptPath"] },
    ]);
    await daemon.post(agentsApi.stop, { session: session.id });
  }, 60_000);

  test("a hook without a session token, with an unknown one or for an unknown event is refused and leaves no record", async () => {
    const session = await daemon.post(agentsApi.start, { repo: "shop" });
    const sessionToken = tokenOf(daemon.home, session.id);
    const payload = { sessionId: "s1", timestamp: 1, stopReason: "end_turn" };

    const noToken = await postHook("/hooks/agentStop", {}, payload);
    const daemonTokenOnly = await postHook("/hooks/agentStop", { authorization: `Bearer ${TOKEN}` }, payload);
    const unknownSession = await postHook("/hooks/agentStop", { "x-trackwall-session-token": "made-up" }, payload);
    const unknownNextToDaemonToken = await postHook(
      "/hooks/agentStop",
      { authorization: `Bearer ${TOKEN}`, "x-trackwall-session-token": "made-up" },
      payload,
    );
    const unknownEvent = await postHook("/hooks/preToolUse", { "x-trackwall-session-token": sessionToken }, payload);

    expect([noToken.status, daemonTokenOnly.status, unknownSession.status, unknownNextToDaemonToken.status, unknownEvent.status]).toEqual([
      401, 401, 401, 401, 404,
    ]);
    expect(readFileSync(sessionHooksFile(daemon.home, session.id), "utf8")).toBe("");
    await daemon.post(agentsApi.stop, { session: session.id });
  }, 60_000);

  test("a session token does not open the API, in its header, as the bearer or through a path that leaves the hook route", async () => {
    const session = await daemon.post(agentsApi.start, { repo: "shop" });
    const sessionToken = tokenOf(daemon.home, session.id);
    const post = (path: string, headers: Record<string, string>) =>
      loopbackRequest(daemon.api.port, path, { method: "POST", headers, body: "{}", timeoutMs: 10_000 });

    const statuses = [
      (await post(agentsApi.sessions.path, { "x-trackwall-session-token": sessionToken })).status,
      (await post(agentsApi.sessions.path, { authorization: `Bearer ${sessionToken}` })).status,
      (await post(`/hooks/../${agentsApi.sessions.path.slice(1)}`, { "x-trackwall-session-token": sessionToken })).status,
      (await post(`/hooks/%2e%2e/${agentsApi.sessions.path.slice(1)}`, { "x-trackwall-session-token": sessionToken })).status,
    ];

    expect(statuses).toEqual([401, 401, 401, 401]);
    await daemon.post(agentsApi.stop, { session: session.id });
  }, 60_000);

  test("the token of a closed session is refused on MCP, also next to the daemon token", async () => {
    const session = await daemon.post(agentsApi.start, { repo: "shop" });
    const sessionToken = tokenOf(daemon.home, session.id);
    await daemon.post(agentsApi.stop, { session: session.id });
    await daemon.post(agentsApi.dismiss, { session: session.id });

    const alone = await postHook("/mcp", { "x-trackwall-session-token": sessionToken }, {});
    const withDaemonToken = await postHook("/mcp", { authorization: `Bearer ${TOKEN}`, "x-trackwall-session-token": sessionToken }, {});

    expect([alone.status, withDaemonToken.status]).toEqual([401, 401]);
    expect(JSON.parse(alone.body).error.message).toBe("unknown session token: this Trackwall session has ended");
  }, 60_000);

  test("a hook of a session closed while its body arrived is refused and writes nothing", async () => {
    const session = await daemon.post(agentsApi.start, { repo: "shop" });
    await daemon.post(agentsApi.stop, { session: session.id });
    await daemon.post(agentsApi.dismiss, { session: session.id });

    expect(() => daemon.facade.agents.receiveHook(session.id, "agentStop", "{}")).toThrow(
      expect.objectContaining({ code: "unauthorized" }),
    );
    expect(existsSync(sessionHooksFile(daemon.home, session.id))).toBe(false);
  }, 60_000);
});
