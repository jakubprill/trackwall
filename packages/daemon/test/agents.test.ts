import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agents } from "../src/modules/agents/agents.ts";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { isAlive } from "../src/platform/process-group.ts";
import { makeAgents, viewer, waitFor } from "./support/agents.ts";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

describe.skipIf(process.versions.bun === undefined)("sesje Copilot CLI (prawdziwy PTY, atrapa Copilot CLI)", () => {
  test("sesja startuje w katalogu repo z serwerem MCP Trackwall, stan idzie za hookami, a /exit kończy ją jako Done", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents, procs } = makeAgents({ sklep: repoDir });
    cleanups.push(() => procs.stopAll());

    const started = await agents.start("sklep");
    expect(started).toMatchObject({ repo: "sklep", run: { kind: "running" } });

    const waiting = await waitFor(agents, started.id, (s) => s.state?.reason === "hook sessionStart", "sessionStart");
    expect(waiting.state).toMatchObject({ state: "Input", source: "hook" });
    expect(waiting.needsAttention).toBe(true);

    const window = viewer(agents, started.id);
    await waitFor(agents, started.id, () => window.text().includes("Witaj w atrapie"), "obraz ekranu");
    expect(window.unwrappedText()).toContain(repoDir);
    expect(window.text()).toContain("MCP: trackwall");

    window.attachment.input("napraw test\r");
    const approval = await waitFor(agents, started.id, (s) => s.state?.state === "Approval", "prośba o zgodę");
    expect(approval.state).toMatchObject({ source: "hook", reason: "hook notification permission_prompt" });
    expect(approval.windowTitle).toBe("Praca nad: napraw test");
    expect(window.text()).toContain("Zezwolić na bash?");

    window.attachment.input("y\r");
    await waitFor(agents, started.id, (s) => s.state?.reason === "hook agentStop", "koniec tury");

    window.attachment.input("/exit\r");
    const done = await waitFor(agents, started.id, (s) => s.run.kind === "exited", "koniec sesji");
    expect(done.state).toMatchObject({ state: "Done", source: "hook" });
    expect(done.needsAttention).toBe(false);
    window.attachment.detach();
  }, 60_000);

  test("Esc przy prośbie o zgodę kończy czekanie na zgodę, choć Copilot CLI nie wysyła wtedy hooka", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents, procs } = makeAgents({ sklep: repoDir });
    cleanups.push(() => procs.stopAll());
    const started = await agents.start("sklep");
    const window = viewer(agents, started.id);
    await waitFor(agents, started.id, () => window.text().includes("Witaj"), "ekran powitalny");
    window.attachment.input("napraw test\r");
    await waitFor(agents, started.id, (s) => s.state?.state === "Approval", "prośba o zgodę");

    window.attachment.input("\u001b");
    const stopped = await waitFor(agents, started.id, (s) => s.state?.source === "keyboard", "stan z klawisza");
    expect(stopped.state).toMatchObject({ state: "Input", confidence: "medium", reason: "key escape" });
    expect(stopped.needsAttention).toBe(true);
    window.attachment.detach();
    await agents.stop(started.id);
  }, 60_000);

  test("okno podłączone później dostaje obraz ekranu z tym, co sesja już wypisała", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents, procs } = makeAgents({ sklep: repoDir });
    cleanups.push(() => procs.stopAll());
    const started = await agents.start("sklep");
    const first = viewer(agents, started.id);
    await waitFor(agents, started.id, () => first.text().includes("Witaj"), "ekran powitalny");
    first.attachment.input("pierwsza linia\r");
    await waitFor(agents, started.id, (s) => s.state?.state === "Approval", "prośba o zgodę");
    first.attachment.detach();

    const late = viewer(agents, started.id);
    await waitFor(agents, started.id, () => late.text().includes("Zezwolić na bash?"), "obraz ekranu dla nowego okna");
    expect(late.text()).toContain("Witaj w atrapie");
    late.attachment.detach();
    await agents.stop(started.id);
  }, 60_000);

  test("stop zatrzymuje całą grupę z procesem pomocnika, a zamknięcie usuwa sesję, jej pliki i okna", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents, home } = makeAgents({ sklep: repoDir });
    const started = await agents.start("sklep");
    const window = viewer(agents, started.id);
    window.attachment.input("uruchom pomocnika\r");
    await waitFor(agents, started.id, () => /PID pomocnika: \d+/.test(window.text()), "proces pomocnika");
    const helperPid = Number(/PID pomocnika: (\d+)/.exec(window.text())?.[1]);
    expect(isAlive(helperPid)).toBe(true);
    expect(() => agents.dismiss(started.id)).toThrow("the session is still running");

    const stopped = await agents.stop(started.id);
    expect(stopped.run).toMatchObject({ kind: "exited", stoppedByUser: true });
    expect(stopped.state?.state).toBe("Done");
    expect(isAlive(helperPid)).toBe(false);
    expect(existsSync(join(home, "sessions", started.id))).toBe(true);

    expect(window.closed()).toBe(false);
    expect(agents.dismiss(started.id).sessions).toEqual([]);
    expect(window.closed()).toBe(true);
    expect(existsSync(join(home, "sessions", started.id))).toBe(false);
  }, 60_000);

  test("brak Copilot CLI i nieznane repo to błędy z kodem, bez procesu", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents } = makeAgents({ sklep: repoDir });
    await expect(agents.start("inne")).rejects.toMatchObject({ code: "not_found" });

    const missing = new Agents({
      procs: {
        startTerminal: () => Promise.reject(new Error("nie powinien startować")),
        state: () => undefined,
        stop: async () => undefined,
      },
      repos: { repoPath: async () => repoDir },
      vcs: new Vcs(),
      home: mkdtempSync(join(tmpdir(), "trackwall-agents-")),
      copilot: ["copilot-ktorego-nie-ma"],
      env: async () => ({ PATH: repoDir }),
      hookCommand: () => ({ exec: "nieuzywane", args: [] }),
      mcpStdioCommand: ["nieuzywane"],
      openEditor: () => {},
      log: () => {},
    });
    await expect(missing.start("sklep")).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(missing.sessions().sessions).toEqual([]);
  });
});
