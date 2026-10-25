import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
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
    const { agents, procs, home } = makeAgents({ sklep: repoDir });
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
    // Session instructions with the session's role come from the session directory, not from the repo (ADR-46).
    expect(window.text()).toContain("Instructions: trackwall.instructions.md");
    const instructions = readFileSync(join(home, "sessions", started.id, "instructions", "trackwall.instructions.md"), "utf8");
    expect(instructions).toContain("You are a main session in the root of the repo `sklep`");
    expect(readdirSync(repoDir)).toEqual([]);
    // Most stdio sesji dostaje plik z tokenem tej sesji, po którym serwer MCP wie, kto woła (ADR-39).
    const tokenFile = join(home, "sessions", started.id, "session-token");
    const mcpConfig = readFileSync(join(home, "sessions", started.id, "mcp-config.json"), "utf8");
    expect(JSON.parse(mcpConfig).mcpServers.trackwall.args).toEqual(["mcp-stdio", "--session-token-file", tokenFile]);
    expect(agents.callerSession(readFileSync(tokenFile, "utf8"))).toBe(started.id);
    expect(agents.callerSession("inny token")).toBeUndefined();

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
    // The Esc the user typed means they see the session, so it is idle, not waiting for you (ADR-47).
    expect(stopped.needsAttention).toBe(false);
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

  test("the supervisor starts in the projects folder, with no repo and the supervisor's instructions", async () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
    const { agents, procs, home } = makeAgents({}, undefined, projectsDir);
    cleanups.push(() => procs.stopAll());

    const supervisor = await agents.startSupervisor();
    expect(supervisor).toMatchObject({ repo: null, task: null, run: { kind: "running" } });
    const window = viewer(agents, supervisor.id);
    await waitFor(
      agents,
      supervisor.id,
      () => window.unwrappedText().includes(projectsDir),
      "the projects folder as the working directory",
    );
    const instructions = readFileSync(join(home, "sessions", supervisor.id, "instructions", "trackwall.instructions.md"), "utf8");
    expect(instructions).toContain("You are the supervisor");
    window.attachment.detach();
    await agents.stop(supervisor.id);
  }, 60_000);

  test("two starts at once, and a start while one runs, give the same supervisor", async () => {
    const { agents, procs } = makeAgents({}, undefined, mkdtempSync(join(tmpdir(), "trackwall-projects-")));
    cleanups.push(() => procs.stopAll());

    const [first, second] = await Promise.all([agents.startSupervisor(), agents.startSupervisor()]);
    expect(second.id).toBe(first.id);
    expect((await agents.startSupervisor()).id).toBe(first.id);
    expect(agents.sessions().sessions.map((s) => s.id)).toEqual([first.id]);
    await agents.stop(first.id);
  }, 60_000);

  test("what the supervisor proposes is marked as the supervisor's, and what another session proposes is not", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents, procs } = makeAgents({ sklep: repoDir }, undefined, mkdtempSync(join(tmpdir(), "trackwall-projects-")));
    cleanups.push(() => procs.stopAll());
    const supervisor = await agents.startSupervisor();
    const session = await agents.start("sklep");

    const fromSupervisor = await agents.propose(supervisor.id, { repo: "sklep", title: "Fix the cart", prompt: "Fix the cart total" });
    const fromSession = await agents.propose(session.id, { repo: "sklep", title: "Add a test", prompt: "Add a cart test" });
    expect(fromSupervisor.proposedBy).toEqual({ session: supervisor.id, supervisor: true });
    expect(fromSession.proposedBy).toEqual({ session: session.id, supervisor: false });
    await agents.stop(supervisor.id);
    await agents.stop(session.id);
  }, 60_000);

  test("a new supervisor replaces the ended one: the ended one is closed with its files, its proposals stay", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents, procs, home } = makeAgents({ sklep: repoDir }, undefined, mkdtempSync(join(tmpdir(), "trackwall-projects-")));
    cleanups.push(() => procs.stopAll());
    const first = await agents.startSupervisor();
    const proposal = await agents.propose(first.id, { repo: "sklep", title: "Fix the cart", prompt: "Fix the cart total" });
    await agents.stop(first.id);

    const next = await agents.startSupervisor();
    expect(next.id).not.toBe(first.id);
    expect(agents.sessions().sessions.map((s) => s.id)).toEqual([next.id]);
    expect(existsSync(join(home, "sessions", first.id))).toBe(false);
    expect(agents.sessions().proposals.map((p) => p.id)).toEqual([proposal.id]);
    await agents.stop(next.id);
  }, 60_000);

  test("a supervisor start succeeds even when the ended supervisor is dismissed while it starts", async () => {
    const { agents, procs } = makeAgents({}, undefined, mkdtempSync(join(tmpdir(), "trackwall-projects-")));
    cleanups.push(() => procs.stopAll());
    const first = await agents.startSupervisor();
    await agents.stop(first.id);

    const starting = agents.startSupervisor();
    agents.dismiss(first.id);
    const next = await starting;
    expect(agents.sessions().sessions.map((s) => s.id)).toEqual([next.id]);
    await agents.stop(next.id);
  }, 60_000);

  test("the supervisor needs the projects folder to be set", async () => {
    const { agents } = makeAgents({});
    await expect(agents.startSupervisor()).rejects.toMatchObject({ code: "bad_request", message: "set the projects folder first" });
    expect(agents.sessions().sessions).toEqual([]);
  });

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
      repos: { repoPath: async () => repoDir, projectsDir: async () => repoDir },
      vcs: new Vcs(),
      home: mkdtempSync(join(tmpdir(), "trackwall-agents-")),
      copilot: ["copilot-ktorego-nie-ma"],
      version: "0.0.0-test",
      env: async () => ({ PATH: repoDir }),
      hookCommand: () => ({ exec: "nieuzywane", args: [] }),
      sessionMcpCommand: () => ["nieuzywane"],
      openEditor: () => {},
      log: () => {},
    });
    await expect(missing.start("sklep")).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(missing.sessions().sessions).toEqual([]);
  });
});
