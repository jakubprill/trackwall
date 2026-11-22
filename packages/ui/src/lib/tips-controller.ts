import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import { readSeenTips, readTipsOn, saveSeenTips, saveTipsOn, TIPS_ON_KEY, TIPS_SEEN_KEY, type TipId, tipToShow } from "./tips.ts";

/**
 * Which tip a window shows, and where (ADR-296). Every place a tip explains says so while it is on screen (`enter`), and
 * the controller picks one tip for the whole window by `tipToShow`, shown in the first of its places that came. A choice
 * made in another window, tips turned off or a tip seen, arrives with the `storage` event, so a tip the user answered in
 * one window goes from all of them.
 */
export interface TipsEnvironment {
  storage: () => Pick<Storage, "getItem" | "setItem">;
  /** Calls `listener` with the key of every `storage` event, a change another window made. */
  onStorage: (listener: (key: string | null) => void) => void;
}

/** What the window shows of tips now. */
export interface TipsState {
  /** Whether tips and What's new show (Settings › App). */
  on: boolean;
  /** How many tips this computer has seen. */
  seen: number;
  /** The place that shows its tip, by the id it entered with, and whether "Show" of What's new asked for the tip. */
  shown: { tip: TipId; place: string; asked: boolean } | null;
}

export class TipsController {
  #on: boolean;
  #seen: ReadonlySet<TipId>;
  /** The tip "Show" of What's new asked for; it shows until the user answers it. */
  #asked: TipId | null = null;
  /** The places on screen, in the order they came. */
  #places: ReadonlyArray<{ tip: TipId; place: string }> = [];
  #state: TipsState;
  readonly #environment: TipsEnvironment;
  readonly #listeners = new Set<() => void>();

  constructor(environment: TipsEnvironment) {
    this.#environment = environment;
    this.#on = readTipsOn(environment.storage);
    this.#seen = readSeenTips(environment.storage);
    this.#state = this.#compute();
    environment.onStorage((key) => {
      if (key !== TIPS_ON_KEY && key !== TIPS_SEEN_KEY && key !== null) return;
      this.#on = readTipsOn(environment.storage);
      this.#seen = readSeenTips(environment.storage);
      this.#changed();
    });
  }

  get state(): TipsState {
    return this.#state;
  }

  /** A place of `tip` is on screen until the returned function is called. */
  enter(tip: TipId, place: string): () => void {
    this.#places = [...this.#places, { tip, place }];
    this.#changed();
    return () => {
      this.#places = this.#places.filter((p) => p.place !== place);
      this.#changed();
    };
  }

  /** "Got it": the tip goes, and does not come back on this computer until "Show the tips again". */
  gotIt(tip: TipId): void {
    this.#seen = new Set([...this.#seen, tip]);
    saveSeenTips(this.#environment.storage, this.#seen);
    if (this.#asked === tip) this.#asked = null;
    this.#changed();
  }

  setOn(on: boolean): void {
    this.#on = on;
    saveTipsOn(this.#environment.storage, on);
    this.#changed();
  }

  /** "Show" of What's new: `tip` shows once its place is on screen, also when it was seen. */
  ask(tip: TipId): void {
    this.#asked = tip;
    this.#changed();
  }

  /** Every tip shows again, each the next time its place is on screen. */
  showAgain(): void {
    this.#seen = new Set();
    saveSeenTips(this.#environment.storage, this.#seen);
    this.#changed();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #compute(): TipsState {
    const tip = tipToShow({ present: new Set(this.#places.map((p) => p.tip)), seen: this.#seen, on: this.#on, asked: this.#asked });
    const place = this.#places.find((p) => p.tip === tip);
    return { on: this.#on, seen: this.#seen.size, shown: place ? { ...place, asked: place.tip === this.#asked } : null };
  }

  #changed(): void {
    // Tips turned off, here or in another window, end an ask too, so that turning them on again does not bring it back.
    if (!this.#on) this.#asked = null;
    this.#state = this.#compute();
    for (const listener of this.#listeners) listener();
  }
}

/** The controller of this window's page. */
export function startTips(): TipsController {
  return new TipsController({
    storage: () => window.localStorage,
    onStorage: (listener) => window.addEventListener("storage", (event) => listener(event.key)),
  });
}

export const TipsContext = createContext<TipsController | null>(null);

const NO_TIPS: TipsState = { on: false, seen: 0, shown: null };

/** This window's tips, and what they show now; without a controller (a component test, the gallery) none show. */
export function useTips(): { tips: TipsController | null; state: TipsState } {
  const tips = useContext(TipsContext);
  const subscribe = useCallback((listener: () => void) => tips?.subscribe(listener) ?? (() => {}), [tips]);
  const state = useSyncExternalStore(subscribe, () => tips?.state ?? NO_TIPS);
  return { tips, state };
}
