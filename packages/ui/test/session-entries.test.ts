import { describe, expect, test } from "bun:test";
import type { Session, Task } from "@trackwall/protocol";
import { entrySelection, findEntry, sessionEntries } from "../src/lib/session-entries.ts";

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
  };
}

describe("pozycje widoku Sesje", () => {
  test("zadanie to jedna pozycja z ostatnią sesją, a kolejność idzie od ostatnio uruchomionej", () => {
    const list = {
      sessions: [
        session("s1", "2026-10-23T10:00:00Z", "t1"),
        session("s3", "2026-10-23T12:00:00Z", "t1"),
        session("s2", "2026-10-23T11:00:00Z"),
      ],
      tasks: [task("t2", "2026-10-23T11:30:00Z"), task("t1", "2026-10-23T09:00:00Z")],
      worktreesDir: "/home/ja/.trackwall/worktrees",
    };
    expect(
      sessionEntries(list).map((e) => (e.kind === "task" ? `zadanie ${e.task.id} ${e.session?.id}` : `sesja ${e.session.id}`)),
    ).toEqual(["zadanie t1 s3", "zadanie t2 undefined", "sesja s2"]);
  });

  test("wybór sesji zadania (z traya albo „Następna czekająca”) wskazuje jej zadanie", () => {
    const entries = sessionEntries({
      sessions: [session("s1", "2026-10-23T12:00:00Z", "t1")],
      tasks: [task("t1", "2026-10-23T09:00:00Z")],
      worktreesDir: "/home/ja/.trackwall/worktrees",
    });
    expect(findEntry(entries, { kind: "session", id: "s1" })).toMatchObject({ kind: "task", task: { id: "t1" } });
    expect(findEntry(entries, { kind: "new" })).toBeUndefined();
    expect(findEntry(entries, { kind: "task", id: "nieznane" })).toBe(entries[0]);
    expect(findEntry(entries, undefined)).toBe(entries[0]);
  });

  test("wybór z pozycji listy wskazuje zadanie, a nie jego sesję", () => {
    const [entry] = sessionEntries({
      sessions: [session("s1", "2026-10-23T12:00:00Z", "t1")],
      tasks: [task("t1", "2026-10-23T09:00:00Z")],
      worktreesDir: "/home/ja/.trackwall/worktrees",
    });
    if (!entry) throw new Error("brak pozycji");
    expect(entrySelection(entry)).toEqual({ kind: "task", id: "t1" });
  });
});
