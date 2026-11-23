import { describe, expect, test } from "bun:test";
import { readSeenTips, readTipsOn, saveSeenTips, saveTipsOn, TIP_IDS, TIPS, tipToShow } from "../src/lib/tips.ts";
import { TipsController, type TipsEnvironment } from "../src/lib/tips-controller.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const stored = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
}

/** A window of the desktop shell: the storage every window shares, and the `storage` events another window's changes send. */
function fakeWindow(stored: Record<string, string> = {}) {
  const storage = memoryStorage(stored);
  const listeners: Array<(key: string | null) => void> = [];
  const environment: TipsEnvironment = { storage: () => storage, onStorage: (listener) => void listeners.push(listener) };
  return {
    storage,
    environment,
    storageEvent(key: string | null) {
      for (const listener of listeners) listener(key);
    },
  };
}

describe("which tip shows (ADR-296)", () => {
  test("a control on screen shows its tip the first time", () => {
    expect(tipToShow({ present: new Set(["evidence"]), seen: new Set(), on: true, asked: null })).toBe("evidence");
  });

  test("with several on screen, one tip shows at a time, the one a new user meets first", () => {
    expect(tipToShow({ present: new Set(["evidence", "own-worktree"]), seen: new Set(), on: true, asked: null })).toBe("own-worktree");
  });

  test("the tips take turns in the order a new user meets their controls, from the New session form to a task ready to close", () => {
    expect(TIP_IDS).toEqual(["own-worktree", "plan-first", "next-waiting", "always-allow", "verify", "evidence", "ready-to-close"]);
  });

  test("More options of the New session form shows the tip of Plan first before the one of Next waiting beside it", () => {
    expect(tipToShow({ present: new Set(["next-waiting", "plan-first"]), seen: new Set(["own-worktree"]), on: true, asked: null })).toBe(
      "plan-first",
    );
  });

  test("a seen tip does not show again, and the next one on screen takes its turn", () => {
    expect(tipToShow({ present: new Set(["evidence", "own-worktree"]), seen: new Set(["own-worktree"]), on: true, asked: null })).toBe(
      "evidence",
    );
    expect(tipToShow({ present: new Set(["evidence"]), seen: new Set(["evidence"]), on: true, asked: null })).toBeNull();
  });

  test("a tip that Show of What's new asked for shows first, also when seen, once its control is on screen", () => {
    expect(
      tipToShow({ present: new Set(["next-waiting", "own-worktree"]), seen: new Set(["own-worktree"]), on: true, asked: "own-worktree" }),
    ).toBe("own-worktree");
    expect(tipToShow({ present: new Set(["next-waiting"]), seen: new Set(), on: true, asked: "own-worktree" })).toBe("next-waiting");
  });

  test("with tips off no tip shows, not even one that was asked for", () => {
    expect(tipToShow({ present: new Set(["own-worktree"]), seen: new Set(), on: false, asked: "own-worktree" })).toBeNull();
  });
});

describe("tips on this computer (ADR-296)", () => {
  test("tips are on until the user turns them off, and the choice is read back at the next start", () => {
    const storage = memoryStorage();
    expect(readTipsOn(() => storage)).toBe(true);

    saveTipsOn(() => storage, false);

    expect(readTipsOn(() => storage)).toBe(false);
  });

  test("the seen tips are read back at the next start, without one this version does not know, such as a newer version's", () => {
    const storage = memoryStorage();
    saveSeenTips(() => storage, new Set(["evidence"]));
    expect(readSeenTips(() => storage)).toEqual(new Set(["evidence"]));

    const newer = memoryStorage({ "trackwall.tips.seen": JSON.stringify(["evidence", "a-tip-of-a-newer-version"]) });
    expect(readSeenTips(() => newer)).toEqual(new Set(["evidence"]));
  });

  test("a stored value that is not a list of tips reads as nothing seen, and an unknown switch as tips on", () => {
    const storage = memoryStorage({ "trackwall.tips.seen": "{not json", "trackwall.tips": "sometimes" });

    expect(readSeenTips(() => storage)).toEqual(new Set());
    expect(readTipsOn(() => storage)).toBe(true);
  });

  test("storage that refuses access reads as tips on and nothing seen, and saving to it does not throw", () => {
    const refusing = () => {
      throw new Error("SecurityError");
    };

    expect(readTipsOn(refusing)).toBe(true);
    expect(readSeenTips(refusing)).toEqual(new Set());
    expect(() => saveTipsOn(refusing, false)).not.toThrow();
    expect(() => saveSeenTips(refusing, new Set(["evidence"]))).not.toThrow();
  });

  test("a tip names the keys of the system it runs on", () => {
    expect(TIPS["next-waiting"].text(false)).toContain("Alt+J does it from any view");
    expect(TIPS["next-waiting"].text(false)).toContain("Win+Alt+J from any other app");
    expect(TIPS["next-waiting"].text(true)).toContain("⌥J does it from any view");
    expect(TIPS["next-waiting"].text(true)).toContain("⌃⌥J from any other app");
  });
});

describe("a window's tips (ADR-296)", () => {
  test("a control that comes on screen shows its tip there, and the tip goes with it", () => {
    const tips = new TipsController(fakeWindow().environment);

    const leave = tips.enter("evidence", "evidence card");
    expect(tips.state.shown).toEqual({ tip: "evidence", place: "evidence card", asked: false });

    leave();
    expect(tips.state.shown).toBeNull();
  });

  test("a tip on screen in two places shows in the one that came first", () => {
    const tips = new TipsController(fakeWindow().environment);
    tips.enter("ready-to-close", "left tile");
    tips.enter("ready-to-close", "right tile");

    expect(tips.state.shown?.place).toBe("left tile");
  });

  test("Got it keeps the tip away in every window from then on, and the next tip on screen takes its turn", () => {
    const window = fakeWindow();
    const tips = new TipsController(window.environment);
    tips.enter("evidence", "evidence card");
    tips.enter("own-worktree", "new session form");

    tips.gotIt("own-worktree");

    expect(tips.state.shown?.tip).toBe("evidence");
    expect(tips.state.seen).toBe(1);
    expect(new TipsController(window.environment).state.seen).toBe(1);
  });

  test("Turn off tips hides the tip on screen and is read back at the next start", () => {
    const window = fakeWindow();
    const tips = new TipsController(window.environment);
    tips.enter("evidence", "evidence card");

    tips.setOn(false);

    expect(tips.state).toEqual({ on: false, seen: 0, shown: null });
    expect(new TipsController(window.environment).state.on).toBe(false);
  });

  test("Show of What's new brings a seen tip back until the user answers it with Got it", () => {
    const tips = new TipsController(fakeWindow({ "trackwall.tips.seen": '["own-worktree"]' }).environment);

    tips.ask("own-worktree");
    const leave = tips.enter("own-worktree", "new session form");
    expect(tips.state.shown).toEqual({ tip: "own-worktree", place: "new session form", asked: true });

    tips.gotIt("own-worktree");
    expect(tips.state.shown).toBeNull();
    leave();
    tips.enter("own-worktree", "new session form, opened again");
    expect(tips.state.shown).toBeNull();
  });

  test("turning tips off ends an ask, so that turning them on again does not bring it back", () => {
    const tips = new TipsController(fakeWindow({ "trackwall.tips.seen": '["own-worktree"]' }).environment);
    tips.ask("own-worktree");
    tips.enter("own-worktree", "new session form");

    tips.setOn(false);
    tips.setOn(true);

    expect(tips.state.shown).toBeNull();
  });

  test("Show the tips again forgets the seen ones, here and at the next start", () => {
    const window = fakeWindow({ "trackwall.tips.seen": '["evidence", "own-worktree"]' });
    const tips = new TipsController(window.environment);
    tips.enter("evidence", "evidence card");
    expect(tips.state.shown).toBeNull();

    tips.showAgain();

    expect(tips.state.shown?.tip).toBe("evidence");
    expect(new TipsController(window.environment).state.seen).toBe(0);
  });

  test("a tip answered or tips turned off in another window go from this one at once", () => {
    const window = fakeWindow();
    const tips = new TipsController(window.environment);
    tips.enter("evidence", "evidence card");
    let heard = 0;
    tips.subscribe(() => heard++);

    window.storage.setItem("trackwall.tips.seen", '["evidence"]');
    window.storageEvent("trackwall.tips.seen");
    expect(tips.state.shown).toBeNull();

    window.storage.setItem("trackwall.tips", "off");
    window.storageEvent("trackwall.tips");
    expect(tips.state.on).toBe(false);
    expect(heard).toBe(2);
  });

  test("a storage event for another key leaves the tips alone", () => {
    const window = fakeWindow();
    const tips = new TipsController(window.environment);
    let heard = 0;
    tips.subscribe(() => heard++);

    window.storageEvent("trackwall.theme");

    expect(heard).toBe(0);
  });
});
