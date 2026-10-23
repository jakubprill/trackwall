import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Session, sessionNeedsAttention } from "@trackwall/protocol";
import { DomainError } from "../src/errors.ts";
import { Agents } from "../src/modules/agents/agents.ts";
import { ProcessGroups } from "../src/modules/procs/process-groups.ts";
import { RuntimeFile } from "../src/modules/procs/runtime-file.ts";
import { groupPlatform } from "../src/platform/group-platform.ts";
import { terminalPlatform } from "../src/platform/terminal.ts";

const fakeCopilot = join(import.meta.dir, "fixtures", "fake-copilot-session.ts");
const daemonMain = join(import.meta.dir, "..", "src", "main.ts");

/** Sesje z prawdziwym PTY, grupą procesów i hookami przez podkomendę `copilot-hook` daemona. */
function makeAgents(repoDir: string) {
  const home = mkdtempSync(join(tmpdir(), "trackwall-agents-"));
  const procs = new ProcessGroups({
    runtime: new RuntimeFile(join(home, "runtime.json")),
    platform: groupPlatform(),
    terminals: terminalPlatform(),
    log: () => {},
  });
  const agents = new Agents({
    procs,
    repos: {
      repoPath: async (id) => {
        if (id !== "sklep") throw new DomainError("not_found", `nie ma repo ${id}`);
        return repoDir;
      },
    },
    home,
    copilot: [process.execPath, fakeCopilot],
    env: async () => process.env,
    hookCommand: (event, hooksFile) => ({ exec: process.execPath, args: ["--no-env-file", daemonMain, "copilot-hook", event, hooksFile] }),
    log: () => {},
  });
  return { home, procs, agents };
}

async function waitFor(agents: Agents, id: string, check: (s: Session) => boolean, what: string): Promise<Session> {
  const until = Date.now() + 20_000;
  for (;;) {
    const session = agents.sessions().sessions.find((s) => s.id === id);
    if (session && check(session)) return session;
    if (Date.now() > until) throw new Error(`nie doczekano się: ${what}; ostatni stan ${JSON.stringify(session)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Okno terminala na niby: obraz ekranu i wyjście jako tekst. */
function viewer(agents: Agents, id: string) {
  let screen = "";
  const decoder = new TextDecoder();
  const attachment = agents.attach(
    id,
    (bytes) => {
      screen += decoder.decode(bytes, { stream: true });
    },
    (snapshot) => {
      screen += snapshot;
    },
  );
  return { attachment, text: () => screen };
}

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

describe.skipIf(process.versions.bun === undefined)("sesje Copilot CLI (prawdziwy PTY, atrapa Copilot CLI)", () => {
  test("sesja startuje w katalogu repo, stan idzie za hookami, a /exit kończy ją jako Done", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents, procs } = makeAgents(repoDir);
    cleanups.push(() => procs.stopAll());

    const started = await agents.start("sklep");
    expect(started).toMatchObject({ repo: "sklep", run: { kind: "running" } });

    const waiting = await waitFor(agents, started.id, (s) => s.state?.reason === "hook sessionStart", "sessionStart");
    expect(waiting.state).toMatchObject({ state: "Input", source: "hook" });
    expect(sessionNeedsAttention(waiting)).toBe(true);

    const window = viewer(agents, started.id);
    await waitFor(agents, started.id, () => window.text().includes("Witaj w atrapie"), "obraz ekranu");
    expect(window.text()).toContain(repoDir);

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
    expect(sessionNeedsAttention(done)).toBe(false);
    window.attachment.detach();
  }, 60_000);

  test("okno podłączone później dostaje obraz ekranu z tym, co sesja już wypisała", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents, procs } = makeAgents(repoDir);
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

  test("stop zatrzymuje całą grupę, a zamknięcie usuwa sesję z listy i jej pliki", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents, home } = makeAgents(repoDir);
    const started = await agents.start("sklep");
    await waitFor(agents, started.id, (s) => s.state !== null, "pierwszy sygnał");
    expect(() => agents.dismiss(started.id)).toThrow("sesja jeszcze działa");

    const stopped = await agents.stop(started.id);
    expect(stopped.run).toMatchObject({ kind: "exited", stoppedByUser: true });
    expect(stopped.state?.state).toBe("Done");
    expect(existsSync(join(home, "sessions", started.id))).toBe(true);

    expect(agents.dismiss(started.id).sessions).toEqual([]);
    expect(existsSync(join(home, "sessions", started.id))).toBe(false);
  }, 60_000);

  test("brak Copilot CLI i nieznane repo to błędy z kodem, bez procesu", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents } = makeAgents(repoDir);
    await expect(agents.start("inne")).rejects.toMatchObject({ code: "not_found" });

    const missing = new Agents({
      procs: {
        startTerminal: () => Promise.reject(new Error("nie powinien startować")),
        state: () => undefined,
        stop: async () => undefined,
      },
      repos: { repoPath: async () => repoDir },
      home: mkdtempSync(join(tmpdir(), "trackwall-agents-")),
      copilot: ["copilot-ktorego-nie-ma"],
      env: async () => ({ PATH: repoDir }),
      hookCommand: () => ({ exec: "nieuzywane", args: [] }),
      log: () => {},
    });
    await expect(missing.start("sklep")).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(missing.sessions().sessions).toEqual([]);
  });
});
