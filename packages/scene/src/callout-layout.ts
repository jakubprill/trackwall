/**
 * Placing label callouts on the screen (ADR-104): a pure function of screen points and label sizes, without three.js or
 * the DOM, so it is tested directly. A callout stands beside its object, on the side away from the middle of the ring, and
 * a leader line runs from the object up to it; a callout that would stick out of the canvas there goes to the other side. Callouts that would cover each other are lifted: the one nearest to the
 * bottom of the screen (nearest to the camera) keeps its place, the ones behind it rise above it.
 */

/** Horizontal run of the leader line from the object to the callout, in pixels. */
export const CALLOUT_RUN = 28;
/** The smallest rise of a callout's middle above its object, in pixels. */
export const CALLOUT_BASE_RISE = 22;
/** Room kept between two callouts, in pixels. */
const GAP = 4;
/**
 * How far past the middle an object must move before its callout changes side, in pixels; without it an object straight in
 * front of the camera would flip sides with every small turn.
 */
const SIDE_HYSTERESIS = 12;

export type CalloutSide = "left" | "right";

export interface CalloutInput<K extends string> {
  key: K;
  /** The object's point on the screen, where the leader line starts. */
  anchor: { x: number; y: number };
  width: number;
  height: number;
  /** The side from the previous frame, if the callout had one. */
  side: CalloutSide | null;
}

export interface CalloutPlacement {
  side: CalloutSide;
  /** How far the callout's middle stands above its object, in pixels. */
  rise: number;
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The canvas's left and right edge on the screen, in pixels. */
export interface CalloutBounds {
  left: number;
  right: number;
}

export function layoutCallouts<K extends string>(
  inputs: readonly CalloutInput<K>[],
  centerX: number,
  bounds: CalloutBounds,
): Map<K, CalloutPlacement> {
  const placed: Box[] = [];
  const result = new Map<K, CalloutPlacement>();
  for (const input of [...inputs].sort((a, b) => b.anchor.y - a.anchor.y)) {
    const side = calloutSide(input, centerX, bounds);
    let rise = CALLOUT_BASE_RISE;
    let box = calloutBox(input, side, rise);
    for (let blocker = placed.find((p) => overlaps(p, box)); blocker; blocker = placed.find((p) => overlaps(p, box))) {
      rise = input.anchor.y - (blocker.top - GAP - input.height / 2);
      box = calloutBox(input, side, rise);
    }
    placed.push(box);
    result.set(input.key, { side, rise });
  }
  return result;
}

function calloutSide(input: CalloutInput<string>, centerX: number, bounds: CalloutBounds): CalloutSide {
  const offset = input.anchor.x - centerX;
  const wanted = input.side !== null && Math.abs(offset) < SIDE_HYSTERESIS ? input.side : offset < 0 ? "left" : "right";
  const other = wanted === "left" ? "right" : "left";
  const fits = (side: CalloutSide) => {
    const box = calloutBox(input, side, CALLOUT_BASE_RISE);
    return box.left >= bounds.left && box.right <= bounds.right;
  };
  return !fits(wanted) && fits(other) ? other : wanted;
}

function calloutBox(input: CalloutInput<string>, side: CalloutSide, rise: number): Box {
  const middle = input.anchor.y - rise;
  const left = side === "right" ? input.anchor.x + CALLOUT_RUN : input.anchor.x - CALLOUT_RUN - input.width;
  return { left, right: left + input.width, top: middle - input.height / 2, bottom: middle + input.height / 2 };
}

/** Boxes closer than `GAP` count as overlapping, so callouts never touch. */
function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right + GAP && b.left < a.right + GAP && a.top < b.bottom + GAP && b.top < a.bottom + GAP;
}
