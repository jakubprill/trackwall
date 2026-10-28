/**
 * The frame pace of the dashboard scene (ADR-106): a Pawn loop driver that draws every display frame while the user
 * works with the scene and for `AWAKE_MS` after (`wake`), and at most `IDLE_FPS` frames a second otherwise. Without
 * it the scene drew 60 frames a second all the time; on a computer that renders WebGL in software (no GPU, a blocked
 * driver, a remote desktop) that kept more than two processor cores busy and slowed Copilot CLI and the daemon down.
 */

/** Enough for the slow pulses and turning dials of a scene at rest. */
const IDLE_FPS = 10;
const IDLE_FRAME_MS = 1000 / IDLE_FPS;
/** Covers a camera flight to a selected object and the damping after a drag. */
const AWAKE_MS = 2000;
/**
 * A frame comes on the display's beat, so the one due at `IDLE_FRAME_MS` may come a little early: half a 60 Hz frame
 * of slack keeps 10 frames a second on a 60 Hz display instead of 8.6.
 */
const FRAME_SLACK_MS = 1000 / 60 / 2;

export interface FrameScheduler {
  request: (frame: (timeMs: number) => void) => number;
  cancel: (handle: number) => void;
  now: () => number;
}

const BROWSER: FrameScheduler = {
  request: (frame) => requestAnimationFrame(frame),
  cancel: (handle) => cancelAnimationFrame(handle),
  now: () => performance.now(),
};

/** Structurally Pawn's `LoopDriver` (`HomeCanvas` passes it as one), so that this file stays free of the engine. */
export class PacedFrames {
  readonly #scheduler: FrameScheduler;
  #handle: number | null = null;
  #awakeUntil = Number.NEGATIVE_INFINITY;
  #lastTick = Number.NEGATIVE_INFINITY;

  constructor(scheduler: FrameScheduler = BROWSER) {
    this.#scheduler = scheduler;
  }

  start(tick: (timeMs: number) => void): void {
    this.stop();
    const loop = (timeMs: number) => {
      this.#handle = this.#scheduler.request(loop);
      if (timeMs >= this.#awakeUntil && timeMs - this.#lastTick < IDLE_FRAME_MS - FRAME_SLACK_MS) return;
      this.#lastTick = timeMs;
      tick(timeMs);
    };
    this.#handle = this.#scheduler.request(loop);
  }

  stop(): void {
    if (this.#handle === null) return;
    this.#scheduler.cancel(this.#handle);
    this.#handle = null;
  }

  /** Every frame from now until `AWAKE_MS` after the last call. */
  wake(): void {
    this.#awakeUntil = this.#scheduler.now() + AWAKE_MS;
  }
}
