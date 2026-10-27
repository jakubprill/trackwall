import { Vector3 } from "three";
import {
  CALLOUT_BASE_RISE,
  CALLOUT_RUN,
  type CalloutInput,
  type CalloutPlacement,
  type CalloutSide,
  layoutCallouts,
} from "./callout-layout.ts";

/**
 * The scene's label callouts (ADR-104): keeps the labels by key and, once per frame before Pawn's `Labels` places the
 * elements, lays them out with `layoutCallouts` and writes the result to each element: `data-side`, the CSS variables of
 * `CALLOUT_VARIABLES` and the alignment `Labels` puts on the object. Writes only what changed, because most frames move
 * nothing. The UI's `scene-callout` (`packages/ui/src/index.css`) draws the leader line from these.
 */

/** CSS variables the scene sets on a callout element, in pixels; `index.css` reads them under the same names. */
const CALLOUT_VARIABLES = { run: "--callout-run", rise: "--callout-rise" } as const;

/** A label as Pawn's `Label` takes it: the element and its point above the object. */
export interface CalloutLabel {
  element: HTMLElement;
  offset: { y: number };
}

/** What the callouts need from the engine; `HomeScene` gives Pawn's views, a test a fake. */
export interface CalloutViews {
  canvasRect(): { left: number; width: number } | null;
  project(point: Vector3): { x: number; y: number; visible: boolean } | null;
}

/** What the callouts need from the scene: where an object stands, and giving it its label with an alignment. */
export interface CalloutHost<K extends string> {
  position(key: K): { x: number; y: number; z: number } | undefined;
  showLabel(key: K, label: CalloutLabel & { align: { x: number; y: number } }): void;
}

interface Callout {
  label: CalloutLabel;
  side: CalloutSide;
  rise: number;
  /** Measured once, when the browser has laid the element out. */
  size: { width: number; height: number } | null;
}

const CENTRE = new Vector3(0, 0, 0);

/** The element's edge that touches the leader line, at its middle: `Labels` puts that point on the object. */
export function calloutAlign(side: CalloutSide): { x: number; y: number } {
  return { x: side === "right" ? 0 : 1, y: 0.5 };
}

export class SceneCallouts<K extends string> {
  readonly #views: CalloutViews;
  readonly #host: CalloutHost<K>;
  readonly #callouts = new Map<K, Callout>();
  /** One point reused for projecting anchors, because this runs every frame. */
  readonly #anchor = new Vector3();

  constructor(views: CalloutViews, host: CalloutHost<K>) {
    this.#views = views;
    this.#host = host;
  }

  attach(key: K, label: CalloutLabel): void {
    const callout: Callout = { label, side: "right", rise: CALLOUT_BASE_RISE, size: null };
    label.element.dataset.side = callout.side;
    label.element.style.setProperty(CALLOUT_VARIABLES.run, `${CALLOUT_RUN}px`);
    label.element.style.setProperty(CALLOUT_VARIABLES.rise, `${callout.rise}px`);
    this.#callouts.set(key, callout);
    this.#host.showLabel(key, { ...label, align: calloutAlign(callout.side) });
  }

  detach(key: K): void {
    this.#callouts.delete(key);
  }

  clear(): void {
    this.#callouts.clear();
  }

  place(): void {
    const canvas = this.#callouts.size > 0 ? this.#views.canvasRect() : null;
    const centre = canvas && this.#views.project(CENTRE);
    if (!canvas || !centre) return;
    const bounds = { left: canvas.left, right: canvas.left + canvas.width };
    for (const [key, placement] of layoutCallouts(this.#inputs(), centre.x, bounds)) this.#move(key, placement);
  }

  /** Callouts whose object is on the screen, with their size; one the browser has not laid out yet waits. */
  #inputs(): CalloutInput<K>[] {
    const inputs: CalloutInput<K>[] = [];
    for (const [key, callout] of this.#callouts) {
      const position = this.#host.position(key);
      const anchor = position && this.#views.project(this.#anchor.set(position.x, position.y + callout.label.offset.y, position.z));
      if (!anchor?.visible) continue;
      const { element } = callout.label;
      callout.size ??= element.offsetWidth > 0 ? { width: element.offsetWidth, height: element.offsetHeight } : null;
      if (callout.size) inputs.push({ key, anchor, ...callout.size, side: callout.side });
    }
    return inputs;
  }

  #move(key: K, placement: CalloutPlacement): void {
    const callout = this.#callouts.get(key);
    if (!callout) return;
    if (callout.side !== placement.side) {
      callout.side = placement.side;
      callout.label.element.dataset.side = placement.side;
      this.#host.showLabel(key, { ...callout.label, align: calloutAlign(placement.side) });
    }
    const rise = Math.round(placement.rise);
    if (callout.rise !== rise) {
      callout.rise = rise;
      callout.label.element.style.setProperty(CALLOUT_VARIABLES.rise, `${rise}px`);
    }
  }
}
