import { describe, expect, test } from "bun:test";
import type { RepoStatusOk } from "@trackwall/protocol";
import { StatusMemo } from "../src/modules/vcs/status-memo.ts";

const CLEAN: RepoStatusOk = { kind: "ok", branch: "main", head: null, changes: 0, untracked: 0, upstream: null };
const EDITED: RepoStatusOk = { ...CLEAN, changes: 1 };

/** A memo whose clock and git directory key the test sets, and a read that takes `readMs` on that clock. */
function memoWithClock() {
  const clock = { ms: 0, key: "HEAD 1" as string | undefined, readMs: 0, reads: 0 };
  const memo = new StatusMemo({ now: () => clock.ms, gitDirKey: async () => clock.key });
  const read = (status: RepoStatusOk) => async () => {
    clock.reads++;
    clock.ms += clock.readMs;
    return status;
  };
  return { clock, memo, read };
}

describe("the status the repo lists reuse (ADR-141)", () => {
  test("a status that took 3 s is reused for twenty times that while the git directory is unchanged", async () => {
    const { clock, memo, read } = memoWithClock();
    clock.readMs = 3000;
    await memo.get("/p/orders", "recent", read(CLEAN));
    clock.readMs = 0;

    clock.ms = 59_000;
    expect(await memo.get("/p/orders", "recent", read(EDITED))).toEqual(CLEAN);
    clock.ms = 60_000;
    expect(await memo.get("/p/orders", "recent", read(EDITED))).toEqual(EDITED);
    expect(clock.reads).toBe(2);
  });

  test("a fast status is reused for a second, so a refresh every 30 s always reads git", async () => {
    const { clock, memo, read } = memoWithClock();
    clock.readMs = 10;
    await memo.get("/p/orders", "recent", read(CLEAN));

    clock.ms = 900;
    expect(await memo.get("/p/orders", "recent", read(EDITED))).toEqual(CLEAN);
    clock.ms = 30_000;
    expect(await memo.get("/p/orders", "recent", read(EDITED))).toEqual(EDITED);
  });

  test("even a very slow status is reused for at most five minutes", async () => {
    const { clock, memo, read } = memoWithClock();
    clock.readMs = 60_000;
    await memo.get("/p/orders", "recent", read(CLEAN));

    clock.ms = 5 * 60_000;
    expect(await memo.get("/p/orders", "recent", read(EDITED))).toEqual(EDITED);
  });

  test("a change in the git directory (a commit, a fetch, staging) reads git again at once", async () => {
    const { clock, memo, read } = memoWithClock();
    await memo.get("/p/orders", "recent", read(CLEAN));
    clock.key = "HEAD 2";

    expect(await memo.get("/p/orders", "recent", read(EDITED))).toEqual(EDITED);
  });

  test("a fresh read always runs git, and the lists then reuse what it found", async () => {
    const { memo, read } = memoWithClock();
    await memo.get("/p/orders", "recent", read(CLEAN));

    expect(await memo.get("/p/orders", "fresh", read(EDITED))).toEqual(EDITED);
    expect(await memo.get("/p/orders", "recent", read(CLEAN))).toEqual(EDITED);
  });

  test("without a readable git directory key nothing is reused", async () => {
    const { clock, memo, read } = memoWithClock();
    clock.key = undefined;
    await memo.get("/p/orders", "recent", read(CLEAN));

    expect(await memo.get("/p/orders", "recent", read(EDITED))).toEqual(EDITED);
  });

  test("a failed read forgets the repo's status, so the next list asks git again", async () => {
    const { memo, read } = memoWithClock();
    await memo.get("/p/orders", "recent", read(CLEAN));
    const failing = async (): Promise<RepoStatusOk> => {
      throw new Error("fatal: not a git repository");
    };

    await expect(memo.get("/p/orders", "fresh", failing)).rejects.toThrow("not a git repository");
    expect(await memo.get("/p/orders", "recent", read(EDITED))).toEqual(EDITED);
  });

  test("each repo has its own status", async () => {
    const { memo, read } = memoWithClock();
    await memo.get("/p/orders", "recent", read(CLEAN));

    expect(await memo.get("/p/billing", "recent", read(EDITED))).toEqual(EDITED);
    expect(await memo.get("/p/orders", "recent", read(EDITED))).toEqual(CLEAN);
  });
});
