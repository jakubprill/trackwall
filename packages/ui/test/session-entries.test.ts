import { describe, expect, test } from "bun:test";
import type { Session, Task, TaskProposal } from "@trackwall/protocol";
import { entryId, entrySelection, findEntry, proposerLabel, sessionRows } from "../src/lib/session-entries.ts";
import { attentionCount } from "../src/lib/session-state.ts";

function session(id: string, startedAt: string, task: string | null = null): Session {
  return {
    id,
    repo: "sklep",
    startedAt,
    run: { kind: "running", runId: id, startedAt, pid: 1 },
    state: null,
    windowTitle: null,
    needsAttention: false,
    task,
  };
}

function task(id: string, createdAt: string): Task {
  return {
    id,
    repo: "sklep",
    prompt: "napraw",
    branch: `trackwall/napraw-${id}`,
    baseBranch: "main",
    base: "a".repeat(40),
    worktree: `/home/ja/.trackwall/worktrees/sklep/napraw-${id}`,
    createdAt,
    title: null,
    proposedBy: null,
    summary: null,
  };
}

function proposal(id: string, createdAt: string, proposer: string | null = null): TaskProposal {
  return { id, repo: "sklep", title: "Dodaj test", prompt: "dodaj test", proposedBy: { session: proposer }, createdAt };
}

function delegated(id: string, createdAt: string, proposer: string): Task {
  return { ...task(id, createdAt), title: "Dodaj test", proposedBy: { session: proposer } };
}

/** Pozycje z wierszy, w kolejności wyświetlania, bez głębokości. */
const rowEntries = (list: Parameters<typeof sessionRows>[0]) => sessionRows(list).map((r) => r.entry);
/** Wiersz jako „rodzaj identyfikator @głębokość”, żeby kształt drzewa było widać w jednej linii. */
const shape = (list: Parameters<typeof sessionRows>[0]) => sessionRows(list).map((r) => `${r.entry.kind} ${entryId(r.entry)} @${r.depth}`);

describe("pozycje widoku Sesje", () => {
  test("zadanie to jedna pozycja z ostatnią sesją, a kolejność idzie od ostatnio uruchomionej", () => {
    const list = {
      // Od najnowszej, jak w `SessionList`.
      sessions: [
        session("s3", "2026-10-23T12:00:00Z", "t1"),
        session("s2", "2026-10-23T11:00:00Z"),
        session("s1", "2026-10-23T10:00:00Z", "t1"),
      ],
      tasks: [task("t2", "2026-10-23T11:30:00Z"), task("t1", "2026-10-23T09:00:00Z")],
      proposals: [],
      worktreesDir: "/home/ja/.trackwall/worktrees",
    };
    expect(rowEntries(list).map((e) => (e.kind === "task" ? `zadanie ${e.task.id} ${e.session?.id}` : `sesja ${entryId(e)}`))).toEqual([
      "zadanie t1 s3",
      "zadanie t2 undefined",
      "sesja s2",
    ]);
  });

  test("wybór sesji zadania (z traya albo „Następna czekająca”) wskazuje jej zadanie", () => {
    const entries = rowEntries({
      sessions: [session("s1", "2026-10-23T12:00:00Z", "t1")],
      tasks: [task("t1", "2026-10-23T09:00:00Z")],
      proposals: [],
      worktreesDir: "/home/ja/.trackwall/worktrees",
    });
    expect(findEntry(entries, { kind: "session", id: "s1" })).toMatchObject({ kind: "task", task: { id: "t1" } });
    expect(findEntry(entries, { kind: "new" })).toBeUndefined();
    expect(findEntry(entries, { kind: "task", id: "nieznane" })).toBe(entries[0]);
    expect(findEntry(entries, undefined)).toBe(entries[0]);
  });

  test("wybór z pozycji listy wskazuje zadanie, a nie jego sesję", () => {
    const [entry] = rowEntries({
      sessions: [session("s1", "2026-10-23T12:00:00Z", "t1")],
      tasks: [task("t1", "2026-10-23T09:00:00Z")],
      proposals: [],
      worktreesDir: "/home/ja/.trackwall/worktrees",
    });
    if (!entry) throw new Error("brak pozycji");
    expect(entrySelection(entry)).toEqual({ kind: "task", id: "t1" });
  });

  test("propozycje zadań są na górze, od najnowszej, przed sesjami i zadaniami", () => {
    const entries = rowEntries({
      sessions: [session("s1", "2026-10-23T12:00:00Z")],
      tasks: [task("t1", "2026-10-23T13:00:00Z")],
      proposals: [proposal("p2", "2026-10-23T11:00:00Z"), proposal("p1", "2026-10-23T10:00:00Z")],
      worktreesDir: "/home/ja/.trackwall/worktrees",
    });
    expect(entries.map((e) => `${e.kind} ${entryId(e)}`)).toEqual(["proposal p2", "proposal p1", "task t1", "session s1"]);
    expect(findEntry(entries, { kind: "proposal", id: "p1" })).toMatchObject({ kind: "proposal", proposal: { id: "p1" } });
  });

  test("wybrana propozycja, z której powstało zadanie, wybiera to zadanie, a nie pierwszą pozycję", () => {
    const entries = rowEntries({
      sessions: [],
      tasks: [task("t0", "2026-10-23T14:00:00Z"), task("p1", "2026-10-23T13:00:00Z")],
      proposals: [],
      worktreesDir: "/home/ja/.trackwall/worktrees",
    });
    expect(findEntry(entries, { kind: "proposal", id: "p1" })).toMatchObject({ kind: "task", task: { id: "p1" } });
  });

  test("licznik na pasku widoków liczy sesje, które czekają, i propozycje zadań", () => {
    const waiting = { ...session("s1", "2026-10-23T12:00:00Z"), needsAttention: true };
    const list = {
      sessions: [waiting, session("s2", "2026-10-23T11:00:00Z")],
      tasks: [],
      proposals: [proposal("p1", "2026-10-23T10:00:00Z")],
    };
    expect(attentionCount({ ...list, worktreesDir: "/w" })).toBe(2);
    expect(attentionCount(undefined)).toBe(0);
  });

  test("zadania i propozycje sesji głównej leżą pod nią, a ona zna ich liczbę", () => {
    const list = {
      sessions: [session("s2", "2026-10-23T12:00:00Z"), session("s1", "2026-10-23T10:00:00Z")],
      tasks: [delegated("t1", "2026-10-23T11:00:00Z", "s1"), task("t2", "2026-10-23T09:00:00Z")],
      proposals: [proposal("p1", "2026-10-23T11:30:00Z", "s1")],
      worktreesDir: "/w",
    };
    expect(shape(list)).toEqual(["session s2 @0", "session s1 @0", "proposal p1 @1", "task t1 @1", "task t2 @0"]);
    expect(sessionRows(list).find((r) => entryId(r.entry) === "s1")?.children).toBe(2);
  });

  test("zadanie zlecone przez sesję innego zadania leży pod tym zadaniem, także gdy to nie jego ostatnia sesja", () => {
    const list = {
      sessions: [session("s2", "2026-10-23T12:00:00Z", "t1"), session("s1", "2026-10-23T10:00:00Z", "t1")],
      tasks: [delegated("t2", "2026-10-23T11:00:00Z", "s1"), task("t1", "2026-10-23T09:00:00Z")],
      proposals: [],
      worktreesDir: "/w",
    };
    expect(shape(list)).toEqual(["task t1 @0", "task t2 @1"]);
  });

  test("zadanie od sesji, której nie ma już na liście, i propozycja od agenta spoza Trackwall są na górnym poziomie", () => {
    const list = {
      sessions: [session("s1", "2026-10-23T10:00:00Z")],
      tasks: [delegated("t1", "2026-10-23T11:00:00Z", "zamknieta")],
      proposals: [proposal("p1", "2026-10-23T09:00:00Z")],
      worktreesDir: "/w",
    };
    expect(shape(list)).toEqual(["proposal p1 @0", "task t1 @0", "session s1 @0"]);
  });

  test("zadania, które zlecają się nawzajem, zostają na liście zamiast ją zapętlić", () => {
    const list = {
      sessions: [session("s2", "2026-10-23T12:00:00Z", "t2"), session("s1", "2026-10-23T11:00:00Z", "t1")],
      tasks: [delegated("t2", "2026-10-23T10:00:00Z", "s1"), delegated("t1", "2026-10-23T09:00:00Z", "s2")],
      proposals: [],
      worktreesDir: "/w",
    };
    expect(shape(list)).toEqual(["task t2 @0", "task t1 @1"]);
    // t1 zlecił t2, ale t2 stoi już wyżej, więc t1 nie ma nikogo pod sobą i nie dostaje znacznika „main”.
    expect(sessionRows(list).map((r) => r.children)).toEqual([1, 0]);
  });

  test("propozycja mówi, czy przyszła od sesji z listy, od zamkniętej sesji, czy od agenta spoza Trackwall", () => {
    const sessions = [{ ...session("s1", "2026-10-23T12:00:00Z"), windowTitle: "Plan sprintu" }];
    expect(proposerLabel({ session: "s1" }, sessions)).toBe("proposed by the session in sklep (Plan sprintu)");
    expect(proposerLabel({ session: "s9" }, sessions)).toBe("proposed by a session that is no longer listed");
    expect(proposerLabel({ session: null }, sessions)).toBe("proposed by an agent outside Trackwall");
  });
});
