import { describe, expect, test } from "bun:test";
import type { Repo } from "@trackwall/protocol";
import { RepoStatusRounds, repoBatches, withLoadedRepos } from "../src/lib/repo-status-rounds.ts";

describe("lazy loading of the repo list (ADR-113)", () => {
  test("the repos the view shows come first, then the rest in list order, in batches, every repo once", () => {
    expect(repoBatches(["api", "bff", "orders", "payments", "web"], ["web", "api", "web"], 2)).toEqual([
      ["web", "api"],
      ["bff", "orders"],
      ["payments"],
    ]);
  });

  test("a repo asked first that is not on the list is left out", () => {
    expect(repoBatches(["api", "web"], ["gone", "web"], 8)).toEqual([["web", "api"]]);
  });

  test("an empty list has no batches", () => {
    expect(repoBatches([], ["api"], 8)).toEqual([]);
  });

  test("a loaded repo replaces its loading entry, and a repo not loaded yet stays loading in its place", () => {
    const loading = (id: string): Repo => ({ id, path: `/projects/${id}`, remote: null, status: { kind: "loading" } });
    const api: Repo = { ...loading("api"), remote: "git.example.com/shop/api", status: { kind: "unavailable", message: "broken" } };
    const removed: Repo = { ...loading("removed"), status: { kind: "unavailable", message: "gone" } };

    expect(
      withLoadedRepos(
        [loading("api"), loading("web")],
        new Map([
          ["api", api],
          ["removed", removed],
        ]),
      ),
    ).toEqual([api, loading("web")]);
  });

  test("a status from another projects folder with the same repo id is not taken for this repo", () => {
    const entry: Repo = { id: "api", path: "/work/api", remote: null, status: { kind: "loading" } };
    const other: Repo = { ...entry, path: "/home/api", status: { kind: "unavailable", message: "broken" } };

    expect(withLoadedRepos([entry], new Map([["api", other]]))).toEqual([entry]);
  });
});

const loading = (id: string): Repo => ({ id, path: `/projects/${id}`, remote: null, status: { kind: "loading" } });
const read = (id: string): Repo => ({ ...loading(id), status: { kind: "unavailable", message: `read ${id}` } });

/** A `repos` request the test answers by hand, to see what is asked and when. */
function scriptedSource(first: readonly string[] = []) {
  const asked: string[][] = [];
  const answers: Array<{ ids: string[]; answer: (repos: Repo[]) => void; fail: (err: Error) => void }> = [];
  let changes = 0;
  const source = {
    fetch: (ids: string[]) =>
      new Promise<Repo[]>((answer, fail) => {
        asked.push(ids);
        answers.push({ ids, answer, fail });
      }),
    first: () => first,
    changed: () => {
      changes++;
    },
  };
  /** Answers the oldest open request with every repo it asked for read, and lets the rounds go on. */
  const answerNext = async () => {
    const next = answers.shift();
    if (!next) throw new Error("no request is waiting");
    next.answer(next.ids.map(read));
    await Bun.sleep(0);
  };
  const failNext = async (message: string) => {
    const next = answers.shift();
    if (!next) throw new Error("no request is waiting");
    next.fail(new Error(message));
    await Bun.sleep(0);
  };
  return { source, asked, answerNext, failNext, changes: () => changes };
}

const twentyRepos = Array.from({ length: 20 }, (_, i) => loading(`repo-${String(i).padStart(2, "0")}`));

describe("rounds of repo statuses (ADR-113)", () => {
  test("the quick list shows at once, and the statuses come batch by batch, the repos shown first", async () => {
    const { source, asked, answerNext } = scriptedSource(["repo-19"]);
    const rounds = new RepoStatusRounds(source);

    rounds.refresh(twentyRepos);
    expect(rounds.repos).toEqual(twentyRepos);
    expect(asked).toEqual([["repo-19", "repo-00", "repo-01", "repo-02", "repo-03", "repo-04", "repo-05", "repo-06"]]);

    await answerNext();
    expect(rounds.repos[19]).toEqual(read("repo-19"));
    expect(rounds.repos[7]).toEqual(loading("repo-07"));
    expect(asked).toHaveLength(2);
  });

  test("quick lists that come during a round wait for its end and start one more round, so the last repo is reached", async () => {
    const { source, asked, answerNext } = scriptedSource();
    const rounds = new RepoStatusRounds(source);

    rounds.refresh(twentyRepos);
    rounds.refresh(twentyRepos);
    rounds.refresh(twentyRepos);
    await answerNext();
    await answerNext();
    await answerNext();

    expect(rounds.repos.every((r) => r.status.kind === "unavailable")).toBe(true);
    expect(asked.map((ids) => ids[0])).toEqual(["repo-00", "repo-08", "repo-16", "repo-00"]);
  });

  test("a failed batch ends the round with its error, and the next round's first batch clears it", async () => {
    const { source, asked, answerNext, failNext } = scriptedSource();
    const rounds = new RepoStatusRounds(source);

    rounds.refresh(twentyRepos);
    await failNext("The projects folder is not available.");
    expect(rounds.error?.message).toBe("The projects folder is not available.");
    expect(asked).toHaveLength(1);

    rounds.refresh(twentyRepos);
    await answerNext();
    expect(rounds.error).toBeUndefined();
  });

  test("an error goes away with a list that has nothing to read, such as an emptied projects folder", async () => {
    const { source, failNext } = scriptedSource();
    const rounds = new RepoStatusRounds(source);
    rounds.refresh(twentyRepos);
    await failNext("The projects folder is not available.");

    rounds.refresh([]);
    await Bun.sleep(0);

    expect(rounds.error).toBeUndefined();
  });

  test("a status shown stays through a refresh until its new one comes, and a repo gone from the list is dropped", async () => {
    const { source, answerNext } = scriptedSource();
    const rounds = new RepoStatusRounds(source);
    rounds.refresh([loading("api"), loading("web")]);
    await answerNext();

    rounds.refresh([loading("api")]);
    expect(rounds.repos).toEqual([read("api")]);
    rounds.refresh([loading("api"), loading("web")]);
    expect(rounds.repos).toEqual([read("api"), loading("web")]);
  });

  test("after stop an answer changes nothing and no further batch is asked", async () => {
    const { source, asked, answerNext, changes } = scriptedSource();
    const rounds = new RepoStatusRounds(source);
    rounds.refresh(twentyRepos);
    const before = changes();

    rounds.stop();
    await answerNext();

    expect(changes()).toBe(before);
    expect(asked).toHaveLength(1);
  });
});
