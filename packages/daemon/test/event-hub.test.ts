import { describe, expect, test } from "bun:test";
import { type CardWarmupProgress, DaemonEvent, type RunningMiseTask, type SessionList } from "@trackwall/protocol";
import { EventHub } from "../src/api/event-hub.ts";
import type { Facade } from "../src/facade.ts";

const EMPTY: SessionList = { sessions: [], tasks: [], proposals: [], worktreesDir: "/state/worktrees" };
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
}): Facade {
  return {
    agents: { sessions: state.sessions },
    mise: { running: state.running },
    repoWatch: { state: () => ({ startedAt: STARTED_AT, revision: state.revision?.() ?? 0 }) },
    cards: { warmupProgress: state.warmup ?? (() => IDLE_WARMUP) },
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
    ]);

    await tick();
    expect(client.events).toHaveLength(4);

    sessions = { ...EMPTY, worktreesDir: "/other/worktrees" };
    await tick();
    expect(client.events.slice(4)).toEqual([{ type: "sessions.changed", payload: sessions }]);
    unsubscribe();
  });

  test("a second listener gets the latest snapshots, and the first one nothing new", () => {
    const hub = new EventHub({ facade: fakeFacade({ sessions: () => EMPTY, running: () => [RUNNING] }), log: () => {} });
    const first = collect();
    const second = collect();
    const unsubscribeFirst = hub.subscribe(first.listener);
    const unsubscribeSecond = hub.subscribe(second.listener);
    expect(second.events).toEqual(first.events);
    expect(first.events).toHaveLength(4);
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
    ]);
    unsubscribe();
    unsubscribeLate();
  });

  test("a new repo revision and the warm-up progress reach the listener as their own events", async () => {
    let revision = 0;
    let warmup = IDLE_WARMUP;
    const hub = new EventHub({
      facade: fakeFacade({ sessions: () => EMPTY, running: () => [], revision: () => revision, warmup: () => warmup }),
      log: () => {},
    });
    const client = collect();
    const unsubscribe = hub.subscribe(client.listener);

    revision = 1;
    warmup = { running: true, done: 3, total: 10 };
    await tick();

    expect(client.events.slice(4)).toEqual([
      { type: "repos.changed", payload: { startedAt: STARTED_AT, revision: 1 } },
      { type: "cards.warmup.changed", payload: { running: true, done: 3, total: 10 } },
    ]);
    unsubscribe();
  });
});
