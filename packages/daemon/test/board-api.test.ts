import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { boardApi, DaemonEvent, EVENTS_SOCKET } from "@trackwall/protocol";
import WebSocket from "ws";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "d".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(() => daemon.stop());

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(process.versions.bun === undefined)("the board from the Plan view (ADR-133, HTTP and /ws)", () => {
  test("the user files an idea into a project, splits it and reorders it, and every change reaches /ws", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.api.port}/ws`, [EVENTS_SOCKET.subprotocol, `bearer.${TOKEN}`]);
    const revisions: number[] = [];
    ws.on("message", (data: Buffer) => {
      const event = DaemonEvent.parse(JSON.parse(data.toString("utf8")));
      if (event.type === "board.changed") revisions.push(event.payload.revision);
    });
    await until(() => revisions.length > 0, "the board's snapshot");

    const project = await daemon.post(boardApi.create, { kind: "project", title: "Order history", column: "ready" });
    const idea = await daemon.post(boardApi.create, { kind: "item", title: "History endpoint in the BFF" });
    const filed = await daemon.post(boardApi.move, { item: idea.id, parent: project.id, before: null });
    const first = await daemon.post(boardApi.create, { kind: "item", title: "Paging like invoices", parent: project.id });
    await daemon.post(boardApi.move, { item: first.id, parent: project.id, before: idea.id });
    const split = await daemon.post(boardApi.create, { kind: "item", title: "Query in orders-api", parent: idea.id });
    const ready = await daemon.post(boardApi.update, { item: idea.id, column: "ready", body: "GET /orders/history" });

    expect(filed.parent).toBe(project.id);
    expect(ready).toMatchObject({ column: "ready", body: "GET /orders/history", createdBy: { kind: "user" } });
    const { items } = await daemon.post(boardApi.board, {});
    const under = (parent: string) => items.filter((it) => it.parent === parent).sort((a, b) => a.order - b.order);
    expect(under(project.id).map((it) => it.title)).toEqual(["Paging like invoices", "History endpoint in the BFF"]);
    expect(under(idea.id).map((it) => it.id)).toEqual([split.id]);
    expect(readdirSync(join(daemon.projects, ".trackwall", "board")).sort()).toEqual(
      [project, idea, first, split].map((it) => `${it.id}.md`).sort(),
    );
    await until(() => (revisions.at(-1) ?? 0) >= 7, "the revision of the seventh change");
    ws.close();
  });

  test("an item with items under it is not removed, and a project does not move", async () => {
    const project = await daemon.post(boardApi.create, { kind: "project", title: "Checkout", column: "ready" });
    const parent = await daemon.post(boardApi.create, { kind: "item", title: "Pay later", parent: project.id });
    const child = await daemon.post(boardApi.create, { kind: "item", title: "Provider contract", parent: parent.id });

    await expect(daemon.post(boardApi.remove, { item: parent.id })).rejects.toThrow("move or remove them first");
    await expect(daemon.post(boardApi.move, { item: project.id, parent: null, before: null })).rejects.toThrow("a project does not move");
    await expect(daemon.post(boardApi.move, { item: parent.id, parent: child.id, before: null })).rejects.toThrow("under itself");

    await daemon.post(boardApi.remove, { item: child.id });
    await daemon.post(boardApi.remove, { item: parent.id });
    expect((await daemon.post(boardApi.board, {})).items.some((it) => it.id === parent.id)).toBe(false);
  });
});
