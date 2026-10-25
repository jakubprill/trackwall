import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import {
  agentsApi,
  GetSessionResult,
  ListSessionsResult,
  ProposeTaskResult,
  ReportResultResult,
  WaitForSessionResult,
} from "@trackwall/protocol";
import { loopbackRequest } from "../src/infra/loopback.ts";
import { MCP_PATH, SESSION_TOKEN_HEADER } from "../src/mcp/endpoint.ts";
import { viewer, waitFor } from "./support/agents.ts";
import { connectHttpClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "c".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
/** Agent spoza Trackwall: tylko token daemona, bez tokenu sesji. */
let outside: Client;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
  outside = await connectHttpClient(daemon.api.port, TOKEN);
  clients.push(outside);
});

// Limit zamiast domyślnego braku: zawieszone sprzątanie na Windowsie ma być błędem tego pliku, a nie godziną joba.
afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
}, 30_000);

/** Klient MCP tak, jak widzi go most stdio sesji: z tokenem z pliku w katalogu sesji. */
async function clientOfSession(session: string): Promise<Client> {
  const token = readFileSync(join(daemon.home, "sessions", session, "session-token"), "utf8");
  const client = await connectHttpClient(daemon.api.port, TOKEN, undefined, { [SESSION_TOKEN_HEADER]: token });
  clients.push(client);
  return client;
}

/**
 * Zatrzymanie sesji dopiero po jej `sessionStart`: zabicie procesu w ConPTY w trakcie startu potrafiło na Windowsie
 * zawiesić albo wysypać Bun (segfault w `bun test`).
 */
async function stopStarted(session: string): Promise<void> {
  await waitFor(daemon.facade.agents, session, (s) => s.state !== null, "sessionStart");
  await daemon.facade.agents.stop(session);
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

describe.skipIf(process.versions.bun === undefined)("sesja główna przez MCP (prawdziwy PTY i git, atrapa Copilot CLI)", () => {
  test("propozycja agenta spoza Trackwall czeka na decyzję, a po odrzuceniu czekanie kończy się od razu", async () => {
    const proposed = ProposeTaskResult.parse(
      (await call(outside, "propose_task", { repo: "sklep", title: "Dodaj README", prompt: "Opisz uruchomienie w README" }))
        .structuredContent,
    ).proposal;
    expect(proposed).toMatchObject({
      repo: "sklep",
      title: "Dodaj README",
      prompt: "Opisz uruchomienie w README",
      proposedBy: { session: null, supervisor: false },
    });
    expect(daemon.facade.agents.sessions().proposals).toEqual([proposed]);

    const pending = WaitForSessionResult.parse(
      (await call(outside, "wait_for_session", { task: proposed.id, timeoutSeconds: 1 })).structuredContent,
    );
    expect(pending).toEqual({ status: "proposal_pending", proposal: proposed, task: null, session: null, rejectionReason: null });

    await daemon.post(agentsApi.rejectProposal, { proposal: proposed.id, reason: "  The README is in the wiki  " });
    expect(daemon.facade.agents.sessions().proposals).toEqual([]);
    const started = Date.now();
    const rejected = WaitForSessionResult.parse(
      (await call(outside, "wait_for_session", { task: proposed.id, timeoutSeconds: 30 })).structuredContent,
    );
    expect(rejected).toMatchObject({ status: "proposal_rejected", rejectionReason: "The README is in the wiki" });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 30_000);

  test("sesja proponuje zadanie, użytkownik je zatwierdza z poprawionym poleceniem, a sesja zadania zgłasza podsumowanie", async () => {
    const main = await daemon.facade.agents.start("sklep");
    const mainClient = await clientOfSession(main.id);
    const listed = ListSessionsResult.parse((await call(mainClient, "list_sessions", {})).structuredContent);
    expect(listed.caller).toBe(main.id);

    const { proposal } = ProposeTaskResult.parse(
      (await call(mainClient, "propose_task", { repo: "sklep", title: "Napraw logowanie", prompt: "napraw logowanie" })).structuredContent,
    );
    expect(proposal.proposedBy).toEqual({ session: main.id, supervisor: false });

    const task = await daemon.post(agentsApi.approveProposal, { proposal: proposal.id, prompt: "napraw logowanie i dodaj test" });
    expect(task).toMatchObject({
      id: proposal.id,
      title: "Napraw logowanie",
      prompt: "napraw logowanie i dodaj test",
      proposedBy: { session: main.id, supervisor: false },
      summary: null,
    });
    expect(task.branch).toMatch(/^trackwall\/napraw-logowanie-[0-9a-f]{6}$/);
    expect(daemon.facade.agents.sessions().proposals).toEqual([]);

    // Sesja zadania startuje z poleceniem, więc czeka się na jej pracę, a nie wraca od razu z „czeka na Ciebie”.
    const working = WaitForSessionResult.parse(
      (await call(mainClient, "wait_for_session", { task: task.id, timeoutSeconds: 2 })).structuredContent,
    );
    expect(working).toMatchObject({ status: "working", task: { id: task.id }, session: { task: task.id } });
    if (!working.session) throw new Error("czekanie na zadanie w pracy nie zwróciło jego sesji");
    const taskSession = working.session.id;

    // Agent zadania kończy turę prośbą o zgodę: czekanie wraca, bo sesja potrzebuje człowieka.
    const window = viewer(daemon.facade.agents, taskSession);
    window.attachment.input("napraw logowanie\r");
    const needsYou = WaitForSessionResult.parse(
      (await call(mainClient, "wait_for_session", { task: task.id, timeoutSeconds: 10 })).structuredContent,
    );
    expect(needsYou).toMatchObject({ status: "needs_attention", task: { id: task.id }, session: { id: taskSession } });
    window.attachment.input("y\r");
    window.attachment.detach();

    const reported = ReportResultResult.parse(
      (await call(await clientOfSession(taskSession), "report_result", { summary: "Logowanie naprawione, test w login.test.ts." }))
        .structuredContent,
    );
    expect(reported.task.summary).toEqual({ text: "Logowanie naprawione, test w login.test.ts.", reportedAt: expect.any(String) });
    const detail = GetSessionResult.parse((await call(mainClient, "get_session", { session: taskSession })).structuredContent);
    expect(detail.task?.summary?.text).toBe("Logowanie naprawione, test w login.test.ts.");

    await daemon.facade.agents.stop(taskSession);
    const exited = WaitForSessionResult.parse(
      (await call(mainClient, "wait_for_session", { session: taskSession, timeoutSeconds: 10 })).structuredContent,
    );
    expect(exited).toMatchObject({ status: "exited", session: { id: taskSession, run: { kind: "exited" } } });
    expect(exited.session?.run).not.toHaveProperty("lastLines");

    // Zadanie bez sesji (zamkniętej w UI albo po restarcie daemona) nie ma na co czekać.
    daemon.facade.agents.dismiss(taskSession);
    const orphan = WaitForSessionResult.parse(
      (await call(mainClient, "wait_for_session", { task: task.id, timeoutSeconds: 10 })).structuredContent,
    );
    expect(orphan).toMatchObject({ status: "no_session", task: { id: task.id }, session: null });
    await daemon.facade.agents.stop(main.id);
  }, 60_000);

  test("report_result działa tylko w sesji zadania: agent spoza Trackwall i sesja w korzeniu repo dostają bad_request", async () => {
    const root = await daemon.facade.agents.start("sklep");
    for (const client of [outside, await clientOfSession(root.id)]) {
      const result = await call(client, "report_result", { summary: "gotowe" });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "bad_request: only a session that runs a task in Trackwall can report a result" },
      ]);
    }
    await stopStarted(root.id);
  }, 30_000);

  test("sesja nie może czekać na samą siebie, a czekanie na nieznane zadanie to not_found", async () => {
    const session = await daemon.facade.agents.start("sklep");
    const own = await call(await clientOfSession(session.id), "wait_for_session", { session: session.id, timeoutSeconds: 1 });
    expect(own.content).toEqual([{ type: "text", text: "bad_request: a session cannot wait for itself" }]);

    const unknown = await call(outside, "wait_for_session", { task: "00000000-0000-4000-8000-000000000000", timeoutSeconds: 1 });
    expect(unknown.content).toEqual([{ type: "text", text: "not_found: no task or task proposal 00000000-0000-4000-8000-000000000000" }]);

    const both = await call(outside, "wait_for_session", { session: session.id, task: session.id });
    expect(both.isError).toBe(true);
    await stopStarted(session.id);
  }, 30_000);

  test("propozycja w nieznanym repo to not_found, a zatwierdzenie propozycji, której już nie ma, też", async () => {
    const result = await call(outside, "propose_task", { repo: "skelp", title: "x", prompt: "y" });
    expect(JSON.stringify(result.content)).toContain('"text":"not_found:');
    await expect(daemon.post(agentsApi.approveProposal, { proposal: "00000000-0000-4000-8000-000000000000", prompt: "y" })).rejects.toThrow(
      "no task proposal",
    );
  });

  test("żądanie z nieznanym tokenem sesji daemon odrzuca, zamiast traktować sesję jak agenta spoza Trackwall", async () => {
    const res = await loopbackRequest(daemon.api.port, MCP_PATH, {
      method: "POST",
      token: TOKEN,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      timeoutMs: 5000,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", [SESSION_TOKEN_HEADER]: "nieznany" },
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });
});
