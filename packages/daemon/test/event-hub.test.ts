import { describe, expect, test } from "bun:test";
import type { DaemonEvent, RunningMiseTask, SessionList } from "@trackwall/protocol";
import { EventHub } from "../src/api/event-hub.ts";
import type { Facade } from "../src/facade.ts";

const EMPTY: SessionList = { sessions: [], tasks: [], worktreesDir: "/stan/worktrees" };
const RUNNING: RunningMiseTask = {
  repo: "sklep",
  miseTask: "dev",
  run: { kind: "running", runId: "r1", startedAt: "2026-10-24T10:00:00.000Z", pid: 42 },
};

/** Fasada z samymi odczytami, które czyta źródło zdarzeń; reszty zdarzenia nie dotykają. */
function fakeFacade(state: { sessions: () => SessionList; running: () => RunningMiseTask[] }): Facade {
  return { agents: { sessions: state.sessions }, mise: { running: state.running } } as unknown as Facade;
}

const tick = () => new Promise((r) => setTimeout(r, 450));

describe("źródło zdarzeń /ws", () => {
  test("nowy słuchacz dostaje od razu migawkę każdego tematu, a potem tylko zmienione migawki z kolejnym seq", async () => {
    let sessions = EMPTY;
    const hub = new EventHub({ facade: fakeFacade({ sessions: () => sessions, running: () => [] }), log: () => {} });
    const events: DaemonEvent[] = [];
    const unsubscribe = hub.subscribe((e) => events.push(e));
    expect(events).toEqual([
      { seq: 1, type: "sessions.changed", payload: EMPTY },
      { seq: 2, type: "mise.running.changed", payload: [] },
    ]);

    await tick();
    expect(events).toHaveLength(2);

    sessions = { ...EMPTY, worktreesDir: "/inny/worktrees" };
    await tick();
    expect(events.slice(2)).toEqual([{ seq: 3, type: "sessions.changed", payload: sessions }]);
    unsubscribe();
  });

  test("drugi słuchacz dostaje najnowsze migawki bez nowych numerów, a pierwszy nic nowego", () => {
    const hub = new EventHub({ facade: fakeFacade({ sessions: () => EMPTY, running: () => [RUNNING] }), log: () => {} });
    const first: DaemonEvent[] = [];
    const second: DaemonEvent[] = [];
    const unsubscribeFirst = hub.subscribe((e) => first.push(e));
    const unsubscribeSecond = hub.subscribe((e) => second.push(e));
    expect(second).toEqual(first);
    expect(second.map((e) => e.seq)).toEqual([1, 2]);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  test("temat, którego nie da się odczytać, trafia do logu raz, a pozostałe tematy działają dalej", async () => {
    const logs: string[] = [];
    const hub = new EventHub({
      facade: fakeFacade({
        sessions: () => {
          throw new Error("hooks.jsonl zablokowany");
        },
        running: () => [RUNNING],
      }),
      log: (msg) => logs.push(msg),
    });
    const events: DaemonEvent[] = [];
    const unsubscribe = hub.subscribe((e) => events.push(e));
    await tick();
    expect(events).toEqual([{ seq: 1, type: "mise.running.changed", payload: [RUNNING] }]);
    expect(logs).toEqual(["reading sessions for events: Error: hooks.jsonl zablokowany"]);
    unsubscribe();
  });
});
