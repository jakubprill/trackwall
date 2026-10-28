import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentsApi } from "@trackwall/protocol";
import { loopbackRequest } from "../src/infra/loopback.ts";
import { sessionHooksFile } from "../src/modules/agents/agents.ts";
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

describe.skipIf(process.versions.bun === undefined)("session plugin hooks over HTTP (ADR-88)", () => {
  test("the plugin registers every hook as a POST to the daemon's hook route with the daemon token and the session token", async () => {
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
        headers: { authorization: `Bearer ${TOKEN}`, "x-trackwall-session-token": sessionToken },
        timeoutSec: 5,
      },
    ]);
    await daemon.post(agentsApi.stop, { session: session.id });
  }, 60_000);

  test("a hook with both tokens appends its record to the session's hooks.jsonl and answers with an empty hook output", async () => {
    const session = await daemon.post(agentsApi.start, { repo: "shop" });
    const sessionToken = tokenOf(daemon.home, session.id);

    const res = await postHook(
      "/hooks/agentStop",
      { authorization: `Bearer ${TOKEN}`, "x-trackwall-session-token": sessionToken },
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

  test("a hook without the daemon token, with an unknown session token or for an unknown event is refused and leaves no record", async () => {
    const session = await daemon.post(agentsApi.start, { repo: "shop" });
    const sessionToken = tokenOf(daemon.home, session.id);
    const payload = { sessionId: "s1", timestamp: 1, stopReason: "end_turn" };

    const noDaemonToken = await postHook("/hooks/agentStop", { "x-trackwall-session-token": sessionToken }, payload);
    const unknownSession = await postHook(
      "/hooks/agentStop",
      { authorization: `Bearer ${TOKEN}`, "x-trackwall-session-token": "made-up" },
      payload,
    );
    const unknownEvent = await postHook(
      "/hooks/preToolUse",
      { authorization: `Bearer ${TOKEN}`, "x-trackwall-session-token": sessionToken },
      payload,
    );

    expect([noDaemonToken.status, unknownSession.status, unknownEvent.status]).toEqual([401, 401, 404]);
    expect(readFileSync(sessionHooksFile(daemon.home, session.id), "utf8")).toBe("");
    await daemon.post(agentsApi.stop, { session: session.id });
  }, 60_000);
});
