import { describe, expect, test } from "bun:test";
import { DaemonEvent, type RunningMiseTask, type SessionList } from "@trackwall/protocol";
import { EventHub } from "../src/api/event-hub.ts";
import type { Facade } from "../src/facade.ts";

const EMPTY: SessionList = { sessions: [], tasks: [], proposals: [], worktreesDir: "/stan/worktrees" };
const RUNNING: RunningMiseTask = {
  repo: "sklep",
  task: null,
  miseTask: "dev",
  run: { kind: "running", runId: "r1", startedAt: "2026-10-24T10:00:00.000Z", pid: 42 },
};

/** Fasada z samymi odczytami, które czyta źródło zdarzeń; reszty zdarzenia nie dotykają. */
function fakeFacade(state: { sessions: () => SessionList; running: () => RunningMiseTask[] }): Facade {
  return { agents: { sessions: state.sessions }, mise: { running: state.running } } as unknown as Facade;
}

/** Słuchacz, który zbiera zdarzenia sprawdzone kontraktem i liczy, ile razy temat przestał działać. */
function collect() {
  const events: DaemonEvent[] = [];
  let failures = 0;
  return {
    events,
    failures: () => failures,
    listener: { event: (frame: string) => events.push(DaemonEvent.parse(JSON.parse(frame))), topicFailed: () => void failures++ },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 450));

describe("źródło zdarzeń /ws", () => {
  test("nowy słuchacz dostaje od razu migawkę każdego tematu, a potem tylko zmienione migawki", async () => {
    let sessions = EMPTY;
    const hub = new EventHub({ facade: fakeFacade({ sessions: () => sessions, running: () => [] }), log: () => {} });
    const client = collect();
    const unsubscribe = hub.subscribe(client.listener);
    expect(client.events).toEqual([
      { type: "sessions.changed", payload: EMPTY },
      { type: "mise.running.changed", payload: [] },
    ]);

    await tick();
    expect(client.events).toHaveLength(2);

    sessions = { ...EMPTY, worktreesDir: "/inny/worktrees" };
    await tick();
    expect(client.events.slice(2)).toEqual([{ type: "sessions.changed", payload: sessions }]);
    unsubscribe();
  });

  test("drugi słuchacz dostaje najnowsze migawki, a pierwszy nic nowego", () => {
    const hub = new EventHub({ facade: fakeFacade({ sessions: () => EMPTY, running: () => [RUNNING] }), log: () => {} });
    const first = collect();
    const second = collect();
    const unsubscribeFirst = hub.subscribe(first.listener);
    const unsubscribeSecond = hub.subscribe(second.listener);
    expect(second.events).toEqual(first.events);
    expect(first.events).toHaveLength(2);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  test("temat, którego nie da się odczytać, trafia do logu raz, słuchacz dowiaduje się, że jego migawka jest nieaktualna, a pozostałe tematy działają dalej", async () => {
    const logs: string[] = [];
    let broken = false;
    const hub = new EventHub({
      facade: fakeFacade({
        sessions: () => {
          if (broken) throw new Error("hooks.jsonl zablokowany");
          return EMPTY;
        },
        running: () => [RUNNING],
      }),
      log: (msg) => logs.push(msg),
    });
    const client = collect();
    const unsubscribe = hub.subscribe(client.listener);
    broken = true;
    await tick();
    expect(client.failures()).toBe(1);
    expect(logs).toEqual(["reading sessions.changed for events: Error: hooks.jsonl zablokowany"]);

    const late = collect();
    const unsubscribeLate = hub.subscribe(late.listener);
    expect(late.events).toEqual([{ type: "mise.running.changed", payload: [RUNNING] }]);
    unsubscribe();
    unsubscribeLate();
  });
});
