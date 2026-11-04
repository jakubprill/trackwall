import { describe, expect, test } from "bun:test";
import { MAX_FOLDER_TERMINALS, type RunState } from "@trackwall/protocol";
import { DomainError, SpawnFailure } from "../src/infra/errors.ts";
import { FolderTerminals, type TerminalProcs } from "../src/modules/terminals/folder-terminals.ts";

const STARTED: RunState = { kind: "running", runId: "r1", startedAt: "2026-11-03T10:00:00.000Z", pid: 7 };

/** `procs` that start a group at once, or fail the way `fail` says; what it started stays running until stopped. */
function fakeProcs(fail?: () => Error) {
  const groups = new Map<string, RunState>();
  const started: { owner: string; command: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const procs: TerminalProcs = {
    startTerminal: async (spec) => {
      if (fail) throw fail();
      started.push(spec);
      groups.set(spec.owner, STARTED);
      return { run: STARTED, terminal: { write: () => {}, resize: () => {} } };
    },
    state: (owner) => groups.get(owner),
    stop: async (owner) => {
      groups.delete(owner);
      return undefined;
    },
  };
  return { procs, started };
}

function terminals(procs: TerminalProcs, folder = async () => "/projects/shop") {
  return new FolderTerminals({ procs, folder, env: async () => ({ PATH: "/bin" }), shell: () => ["/bin/bash"], log: () => {} });
}

describe("folder terminals", () => {
  test("the shell gets the place's folder, the user's environment with a colour terminal, and an owner of its own", async () => {
    const { procs, started } = fakeProcs();

    const terminal = await terminals(procs).start({ repo: "shop", task: null });

    expect(started).toEqual([
      {
        owner: `terminal:${terminal.id}`,
        command: ["/bin/bash"],
        cwd: "/projects/shop",
        env: { PATH: "/bin", TERM: "xterm-256color", COLORTERM: "truecolor" },
        cols: 120,
        rows: 30,
        onData: expect.any(Function),
      } as never,
    ]);
  });

  test(`at ${MAX_FOLDER_TERMINALS} open terminals a new place is refused, while a place that has one still gets it`, async () => {
    const { procs } = fakeProcs();
    const open = terminals(procs);
    const first = await open.start({ repo: "repo-0", task: null });
    for (let i = 1; i < MAX_FOLDER_TERMINALS; i++) await open.start({ repo: `repo-${i}`, task: null });

    await expect(open.start({ repo: "one-more", task: null })).rejects.toMatchObject({ code: "bad_request" });
    expect((await open.start({ repo: "repo-0", task: null })).id).toBe(first.id);
  });

  test("a runtime without a PTY or a folder that went away is an error the user can act on, and leaves nothing listed", async () => {
    const noPty = terminals(fakeProcs(() => new SpawnFailure("terminal_unavailable", "no PTY")).procs);
    const gone = terminals(fakeProcs(() => new SpawnFailure("cwd_invalid", "no folder")).procs);

    await expect(noPty.start({ repo: "shop", task: null })).rejects.toMatchObject({ code: "terminal_unavailable" });
    await expect(gone.start({ repo: "shop", task: null })).rejects.toMatchObject({ code: "repo_unavailable" });
    expect(noPty.list()).toEqual([]);
  });

  test("the projects folder's shell is started again in the new folder once the projects folder changed", async () => {
    const { procs, started } = fakeProcs();
    let projects = "/projects";
    const open = terminals(procs, async () => projects);
    const first = await open.start({ repo: null, task: null });
    expect((await open.start({ repo: null, task: null })).id).toBe(first.id);

    projects = "/elsewhere";
    const again = await open.start({ repo: null, task: null });

    expect(again.id).not.toBe(first.id);
    expect(started.map((s) => s.cwd)).toEqual(["/projects", "/elsewhere"]);
    expect(open.list().map((t) => t.id)).toEqual([again.id]);
  });

  test("a place the daemon cannot find starts nothing", async () => {
    const { procs, started } = fakeProcs();
    const open = terminals(procs, async () => {
      throw new DomainError("not_found", "no repo nowhere");
    });

    await expect(open.start({ repo: "nowhere", task: null })).rejects.toMatchObject({ code: "not_found" });
    expect(started).toEqual([]);
  });
});
