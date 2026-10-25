import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { agentsApi } from "@trackwall/protocol";
import { loopbackRequest } from "../src/infra/loopback.ts";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "d".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
});

afterAll(() => daemon.stop());

function answerDialog(body: unknown) {
  return loopbackRequest(daemon.api.port, agentsApi.answerDialog.path, {
    method: "POST",
    token: TOKEN,
    body: JSON.stringify(body),
    timeoutMs: 10_000,
  });
}

describe.skipIf(process.versions.bun === undefined)("answering an agent dialog over the API (ADR-66)", () => {
  test("an answer to a dialog the session does not show is 409 dialog_changed, and an answer that is no key is 400", async () => {
    const session = await daemon.post(agentsApi.start, { repo: "shop" });

    const stale = await answerDialog({ session: session.id, dialog: "0123456789abcdef", answer: "1" });
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.body)).toMatchObject({ ok: false, error: { code: "dialog_changed" } });

    const typed = await answerDialog({ session: session.id, dialog: "0123456789abcdef", answer: "yes\r" });
    expect(typed.status).toBe(400);

    await daemon.post(agentsApi.stop, { session: session.id });
  }, 60_000);
});
