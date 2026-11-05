import { afterEach, describe, expect, test } from "bun:test";
import type { Session } from "@trackwall/protocol";
import { restartOnModel, restartOnModelNote } from "../src/lib/model-change.ts";

const conn = { baseUrl: "http://127.0.0.1:7700", token: "secret" };

const repoSession: Session = {
  id: "11111111-1111-4111-8111-111111111111",
  repo: "shop",
  supervisor: false,
  startedAt: "2026-11-05T10:00:00Z",
  run: { kind: "running", runId: "r", startedAt: "2026-11-05T10:00:00Z", pid: 10 },
  state: null,
  windowTitle: null,
  needsAttention: false,
  stuck: null,
  task: null,
  dialog: null,
  environment: { variables: [], secrets: [], agentSecrets: [], profile: null, problem: null },
  view: "terminal",
  readRequest: null,
  copyRequest: null,
  usage: null,
  model: "claude-sonnet-5.5",
};

describe("restarting a session on another model (ADR-206)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** A daemon that answers each request with `answer(path)` and records the paths and bodies it was asked. */
  function daemon(answer: (path: string) => unknown): { path: string; body: unknown }[] {
    const asked: { path: string; body: unknown }[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        asked.push({ path, body: JSON.parse(String(init?.body)) });
        return Response.json(answer(path));
      },
      { preconnect: realFetch.preconnect },
    );
    return asked;
  }

  test("a repo session restarts with the model in the request", async () => {
    const asked = daemon(() => ({ ok: true, data: repoSession }));

    await restartOnModel(conn, repoSession, "claude-sonnet-5.5");

    expect(asked).toEqual([{ path: "/api/agents/restart", body: { session: repoSession.id, model: "claude-sonnet-5.5" } }]);
  });

  test("the supervisor's model is saved in Settings first, and a refused save restarts nothing", async () => {
    const asked = daemon(() => ({ ok: false, error: { code: "invalid_config", message: "workspace.yaml cannot be written" } }));

    await expect(restartOnModel(conn, { id: repoSession.id, supervisor: true }, "gpt-5-mini")).rejects.toThrow(
      "workspace.yaml cannot be written",
    );

    expect(asked).toEqual([{ path: "/api/workspace/set-supervisor-model", body: { model: "gpt-5-mini" } }]);
  });

  test("the note says who keeps the model: the task, the session or the supervisor's Settings", () => {
    expect(restartOnModelNote({ supervisor: false, task: "t1" })).toBe(
      "The session stops and starts again on this model with the same conversation. The task keeps it for its later resumes.",
    );
    expect(restartOnModelNote({ supervisor: false, task: null })).toEndWith("The session keeps it for its later restarts.");
    expect(restartOnModelNote({ supervisor: true, task: null })).toEndWith("It becomes the supervisor model in Settings.");
  });
});
