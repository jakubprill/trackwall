import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FOLDER_TERMINALS, type RunState, type TerminalPlace } from "@trackwall/protocol";
import { DomainError, SpawnFailure } from "../src/infra/errors.ts";
import { FolderTerminals, type TerminalProcs } from "../src/modules/terminals/folder-terminals.ts";
import type { ShellPlacesStore } from "../src/modules/terminals/shell-places.ts";

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

/** Stops that wait until the test releases or fails them, as a shell that ignores the gentle stop makes `procs` wait. */
function heldStops(procs: TerminalProcs) {
  const stop = procs.stop;
  const waiting: { owner: string; release: () => void; fail: (err: Error) => void }[] = [];
  procs.stop = (owner) =>
    new Promise((resolve, reject) => {
      waiting.push({ owner, release: () => resolve(stop(owner)), fail: reject });
    });
  return {
    waiting: () => waiting.map((w) => w.owner),
    release: () => {
      for (const w of waiting.splice(0)) w.release();
    },
    fail: (err: Error) => {
      for (const w of waiting.splice(0)) w.fail(err);
    },
  };
}

/** Lets the queued work of a place run as far as it can. */
function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The places file in memory: what the previous daemon left, and every list followed since, until it stops following. */
function memoryPlaces(left: TerminalPlace[] = []) {
  const followed: TerminalPlace[][] = [];
  let following = true;
  const places: ShellPlacesStore = {
    read: () => left,
    follow: (now) => {
      if (following) followed.push([...now]);
    },
    stopFollowing: () => {
      following = false;
    },
  };
  return { places, followed, last: () => followed.at(-1) };
}

function terminals(
  procs: TerminalProcs,
  folder: (place: TerminalPlace) => Promise<string> = async () => "/projects/shop",
  places: ShellPlacesStore = memoryPlaces().places,
  log: (msg: string) => void = () => {},
) {
  return new FolderTerminals({
    procs,
    folder,
    env: async () => ({ PATH: "/bin" }),
    shell: () => ({ command: ["/bin/bash"], screenLine: null }),
    places,
    log,
  });
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

  test("a close takes the terminal off its place at once, so the place opens a new shell while the old one still ends", async () => {
    const { procs, started } = fakeProcs();
    const ends = heldStops(procs);
    const open = terminals(procs);
    const old = await open.start({ repo: "shop", task: null });
    const windowClosed: string[] = [];
    open.attach(
      old.id,
      () => {},
      () => {},
      () => windowClosed.push(old.id),
    );

    const closing = open.close(old.id);
    await settled();
    expect(open.list()).toEqual([]);
    expect(windowClosed).toEqual([old.id]);
    const fresh = await open.start({ repo: "shop", task: null });

    expect(fresh.id).not.toBe(old.id);
    expect(started).toHaveLength(2);
    expect(ends.waiting()).toEqual([`terminal:${old.id}`]);
    ends.release();
    await closing;
    expect(open.list().map((t) => t.id)).toEqual([fresh.id]);
  });

  test("a close whose end is not confirmed puts the terminal back at its place, with the error for the user", async () => {
    const { procs } = fakeProcs();
    const ends = heldStops(procs);
    const open = terminals(procs);
    const shell = await open.start({ repo: "shop", task: null });

    const closing = open.close(shell.id);
    await settled();
    ends.fail(new DomainError("stop_unconfirmed", "still running after the kill"));

    await expect(closing).rejects.toMatchObject({ code: "stop_unconfirmed" });
    expect(open.list().map((t) => t.id)).toEqual([shell.id]);
    expect((await open.start({ repo: "shop", task: null })).id).toBe(shell.id);
  });

  test("a close not confirmed after the place got a new shell leaves the new one as the place's only terminal", async () => {
    const { procs } = fakeProcs();
    const ends = heldStops(procs);
    const open = terminals(procs);
    const old = await open.start({ repo: "shop", task: null });
    const closing = open.close(old.id);
    const fresh = await open.start({ repo: "shop", task: null });
    await settled();

    ends.fail(new DomainError("stop_unconfirmed", "still running after the kill"));

    await expect(closing).rejects.toMatchObject({ code: "stop_unconfirmed" });
    expect(open.list().map((t) => t.id)).toEqual([fresh.id]);
  });

  test("ending a task waits for its shell that a close is still ending", async () => {
    const { procs } = fakeProcs();
    const ends = heldStops(procs);
    const worktree = mkdtempSync(join(tmpdir(), "worktree-"));
    const open = terminals(procs, async () => worktree);
    const shell = await open.start({ repo: "shop", task: "t1" });
    const closing = open.close(shell.id);
    let taskEnded = false;

    const ending = open.closeTask("t1").then(() => {
      taskEnded = true;
    });
    await settled();
    expect(taskEnded).toBe(false);

    ends.release();
    await Promise.all([closing, ending]);
    expect(taskEnded).toBe(true);
    rmSync(worktree, { recursive: true });
  });

  test("a place the daemon cannot find starts nothing", async () => {
    const { procs, started } = fakeProcs();
    const open = terminals(procs, async () => {
      throw new DomainError("not_found", "no repo nowhere");
    });

    await expect(open.start({ repo: "nowhere", task: null })).rejects.toMatchObject({ code: "not_found" });
    expect(started).toEqual([]);
  });

  describe("across a daemon restart (ADR-283)", () => {
    test("the places of running shells follow every start and close, and stay as they were once the daemon stops", async () => {
      const { procs } = fakeProcs();
      const file = memoryPlaces();
      const open = terminals(procs, async () => "/projects", file.places);

      const shop = await open.start({ repo: "shop", task: null });
      await open.start({ repo: null, task: null });
      expect(file.last()).toEqual([
        { repo: "shop", task: null },
        { repo: null, task: null },
      ]);
      await open.close(shop.id);
      expect(file.last()).toEqual([{ repo: null, task: null }]);

      open.keepForRestart();
      await open.start({ repo: "billing", task: null });
      expect(file.last()).toEqual([{ repo: null, task: null }]);
    });

    test("a shell that ended by itself is left out when the daemon stops", async () => {
      const { procs } = fakeProcs();
      const file = memoryPlaces();
      const open = terminals(procs, async () => "/projects", file.places);
      const shell = await open.start({ repo: "shop", task: null });
      const exited: RunState = {
        ...STARTED,
        kind: "exited",
        endedAt: "2026-11-19T10:00:00.000Z",
        exitCode: 0,
        signal: null,
        stoppedByUser: false,
        lastLines: [],
      };
      procs.state = (owner) => (owner === `terminal:${shell.id}` ? exited : undefined);

      open.keepForRestart();

      expect(file.last()).toEqual([]);
    });

    test("the next daemon opens a shell in each place left, with a line saying it is new, and logs a place that is gone", async () => {
      const { procs, started } = fakeProcs();
      const log: string[] = [];
      const file = memoryPlaces([
        { repo: "shop", task: null },
        { repo: "shop", task: "3f2a9c1e-0000-4000-8000-000000000000" },
      ]);
      const folder = async (place: TerminalPlace) => {
        if (place.task !== null) throw new DomainError("not_found", `no task ${place.task}`);
        return "/projects/shop";
      };
      const open = terminals(procs, folder, file.places, (msg) => log.push(msg));

      await open.reopenLeft();

      expect(started.map((s) => s.cwd)).toEqual(["/projects/shop"]);
      expect(open.list().map(({ repo, task }) => ({ repo, task }))).toEqual([{ repo: "shop", task: null }]);
      expect(log.some((line) => line.includes("not opening a shell again in task:3f2a9c1e") && line.includes("no task"))).toBe(true);
      expect(file.last()).toEqual([{ repo: "shop", task: null }]);
    });

    test("a place the user opened before the reopening keeps the shell it has", async () => {
      const { procs, started } = fakeProcs();
      const open = terminals(procs, undefined, memoryPlaces([{ repo: "shop", task: null }]).places);
      const mine = await open.start({ repo: "shop", task: null });

      await open.reopenLeft();

      expect(started).toHaveLength(1);
      expect(open.list().map((t) => t.id)).toEqual([mine.id]);
    });
  });
});
