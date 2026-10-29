import { describe, expect, test } from "bun:test";
import { type CardWarmupProgress, DaemonEvent, type RunningMiseTask, type SessionList } from "@trackwall/protocol";
import { EventHub } from "../src/api/event-hub.ts";
import type { Facade } from "../src/facade.ts";

const EMPTY: SessionList = { sessions: [], tasks: [], proposals: [], messages: [], lastSupervisor: null };
const RUNNING: RunningMiseTask = {
  repo: "shop",
  task: null,
  miseTask: "dev",
  run: { kind: "running", runId: "r1", startedAt: "2026-10-24T10:00:00.000Z", pid: 42 },
};

const STARTED_AT = "2026-10-25T18:00:00.000Z";
const IDLE_WARMUP: CardWarmupProgress = { running: false, done: 0, total: 0 };

/** A facade with only the reads the event source makes; events do not touch the rest. */
function fakeFacade(state: {
  sessions: () => SessionList;
  running: () => RunningMiseTask[];
  revision?: () => number;
  warmup?: () => CardWarmupProgress;
  board?: () => number;
}): Facade {
  return {
    agents: { sessions: state.sessions },
    mise: { running: state.running },
    repoWatch: { state: () => ({ startedAt: STARTED_AT, revision: state.revision?.() ?? 0 }) },
    cards: { warmupProgress: state.warmup ?? (() => IDLE_WARMUP) },
    board: { revision: state.board ?? (() => 0) },
  } as unknown as Facade;
}

/** A listener that collects events checked by the contract and counts how many times a topic stopped working. */
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

describe("the /ws event source", () => {
  test("a new listener gets a snapshot of every topic at once, then only changed snapshots", async () => {
    let sessions = EMPTY;
    const hub = new EventHub({ facade: fakeFacade({ sessions: () => sessions, running: () => [] }), log: () => {} });
    const client = collect();
    const unsubscribe = hub.subscribe(client.listener);
    expect(client.events).toEqual([
      { type: "sessions.changed", payload: EMPTY },
      { type: "mise.running.changed", payload: [] },
      { type: "repos.changed", payload: { startedAt: STARTED_AT, revision: 0 } },
      { type: "cards.warmup.changed", payload: IDLE_WARMUP },
      { type: "board.changed", payload: { revision: 0 } },
    ]);

    await tick();
    expect(client.events).toHaveLength(5);

    sessions = {
      ...EMPTY,
      messages: [
        {
          id: "7c1e2d3a-0000-4000-8000-000000000000",
          task: "3f2a9c1e-0000-4000-8000-000000000000",
          from: { session: null, supervisor: true },
          text: "rebase on main",
          sentAt: STARTED_AT,
          readAt: null,
        },
      ],
    };
    await tick();
    expect(client.events.slice(5)).toEqual([{ type: "sessions.changed", payload: sessions }]);
    unsubscribe();
  });

  test("a second listener gets the latest snapshots, and the first one nothing new", () => {
    const hub = new EventHub({ facade: fakeFacade({ sessions: () => EMPTY, running: () => [RUNNING] }), log: () => {} });
    const first = collect();
    const second = collect();
    const unsubscribeFirst = hub.subscribe(first.listener);
    const unsubscribeSecond = hub.subscribe(second.listener);
    expect(second.events).toEqual(first.events);
    expect(first.events).toHaveLength(5);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  test("a topic that cannot be read is logged once, the listener learns its snapshot is out of date, and the other topics keep working", async () => {
    const logs: string[] = [];
    let broken = false;
    const hub = new EventHub({
      facade: fakeFacade({
        sessions: () => {
          if (broken) throw new Error("hooks.jsonl locked");
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
    expect(logs).toEqual(["reading sessions.changed for events: Error: hooks.jsonl locked"]);

    const late = collect();
    const unsubscribeLate = hub.subscribe(late.listener);
    expect(late.events).toEqual([
      { type: "mise.running.changed", payload: [RUNNING] },
      { type: "repos.changed", payload: { startedAt: STARTED_AT, revision: 0 } },
      { type: "cards.warmup.changed", payload: IDLE_WARMUP },
      { type: "board.changed", payload: { revision: 0 } },
    ]);
    unsubscribe();
    unsubscribeLate();
  });

  test("a new repo revision, the warm-up progress and a board change reach the listener as their own events", async () => {
    let revision = 0;
    let warmup = IDLE_WARMUP;
    let board = 0;
    const hub = new EventHub({
      facade: fakeFacade({ sessions: () => EMPTY, running: () => [], revision: () => revision, warmup: () => warmup, board: () => board }),
      log: () => {},
    });
    const client = collect();
    const unsubscribe = hub.subscribe(client.listener);

    revision = 1;
    warmup = { running: true, done: 3, total: 10 };
    board = 1;
    await tick();

    expect(client.events.slice(5)).toEqual([
      { type: "repos.changed", payload: { startedAt: STARTED_AT, revision: 1 } },
      { type: "cards.warmup.changed", payload: { running: true, done: 3, total: 10 } },
      { type: "board.changed", payload: { revision: 1 } },
    ]);
    unsubscribe();
  });
});
