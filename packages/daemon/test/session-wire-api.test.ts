import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type AutoReview, agentsApi, autoReviewApi } from "@trackwall/protocol";
import { viewer, waitFor } from "./support/agents.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "w".repeat(43);
const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
const FAKE_COPILOT = [process.execPath, join(import.meta.dir, "fixtures", "fake-copilot-session.ts")];

/**
 * A provider like a gateway that serves two model families under one address: `gpt-6.1-sol` answers only in the
 * Responses API, `claude-opus-5.5` only in Chat Completions, as such a gateway refuses the other format with a 400.
 */
const RESPONSES_ONLY = new Set(["gpt-6.1-sol"]);
const requests: string[] = [];
/** The model the environment names; a test of a review, which runs on it, changes it. */
let envModel = "claude-opus-5.5";
let provider: ReturnType<typeof createServer>;
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  provider = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => {
      const { model } = JSON.parse(text || "{}") as { model?: string };
      requests.push(`${req.method} ${req.url} ${model}`);
      const responses = req.url === "/v1/responses";
      const answers = responses === RESPONSES_ONLY.has(model ?? "");
      res.writeHead(answers ? 200 : 400, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          answers
            ? { id: "x" }
            : { error: { message: `this model ${responses ? "does not support" : "only supports"} the Responses API` } },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const { port } = provider.address() as AddressInfo;
  daemon = await startSessionApi(TOKEN, {
    repos: { shop: { "README.md": "# shop\n", "fake-mise.json": JSON.stringify({ tasks: [], env: {} }) } },
    miseCommand: FAKE_MISE,
    copilot: {
      command: FAKE_COPILOT,
      env: () => ({
        ...process.env,
        COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${port}/v1`,
        COPILOT_PROVIDER_API_KEY: "sk-test",
        COPILOT_PROVIDER_WIRE_API: "completions",
        COPILOT_MODEL: envModel,
        FAKE_COPILOT_SHOW_ENV: "COPILOT_PROVIDER_WIRE_API",
      }),
    },
  });
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await daemon.stop();
  provider.close();
});

/** Starts a session in `shop` on `model` and gives the format its Copilot CLI got. */
async function wireApiOfSession(model: string | null): Promise<string> {
  const started = await daemon.facade.agents.start("shop", undefined, { model });
  const window = viewer(daemon.facade.agents, started.id);
  await waitFor(
    daemon.facade.agents,
    started.id,
    () => window.text().includes("Env COPILOT_PROVIDER_WIRE_API="),
    "the format on the screen",
  );
  const shown = /Env COPILOT_PROVIDER_WIRE_API=(\w+)/.exec(window.text())?.[1] ?? "";
  window.attachment.detach();
  await daemon.facade.agents.stop(started.id);
  return shown;
}

describe("the format of a session's model with a custom provider (ADR-197; real PTY, fake Copilot CLI)", () => {
  test("a model that answers only in the Responses API gets it, though the environment names Chat Completions, and is asked once", async () => {
    expect(await wireApiOfSession("gpt-6.1-sol")).toBe("responses");
    expect(await wireApiOfSession("gpt-6.1-sol")).toBe("responses");

    expect(requests.filter((r) => r.endsWith(" gpt-6.1-sol")).sort()).toEqual([
      "POST /v1/chat/completions gpt-6.1-sol",
      "POST /v1/responses gpt-6.1-sol",
    ]);
  }, 60_000);

  test("without --model the session's COPILOT_MODEL is probed, and a model of Chat Completions keeps it", async () => {
    expect(await wireApiOfSession(null)).toBe("completions");
    expect(requests).toContain("POST /v1/responses claude-opus-5.5");
  }, 60_000);

  test("a task's review on the environment's model gets that model's format too", async () => {
    envModel = "gpt-6.1-sol";
    try {
      const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "add a cart", approvals: "ask" });
      mkdirSync(join(task.worktree, "src"), { recursive: true });
      writeFileSync(join(task.worktree, "src", "cart.ts"), "export const total = 1;\n");

      await daemon.post(autoReviewApi.start, { task: task.id });
      let review: AutoReview | null = null;
      const until = Date.now() + 20_000;
      while (review?.state !== "done" && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 50));
        review = await daemon.post(autoReviewApi.get, { task: task.id });
      }
      expect(review?.text).toContain("Env COPILOT_PROVIDER_WIRE_API=responses");
    } finally {
      envModel = "claude-opus-5.5";
    }
  }, 60_000);
});
