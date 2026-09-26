/**
 * interaction.ts — the touch / pointer interaction layer.
 *
 * The StopWatch is a TOUCH device with two buttons, a vibration motor and an
 * IMU. Touch is therefore the primary way a person talks to the avatar, and it
 * deserves better than "pointer moves the eyes, click blinks".
 *
 * ── The interaction vocabulary ────────────────────────────────────────────
 *
 *   POINT        the avatar looks at your finger, wherever it is
 *   DRAG         GRAB THE BALL AND TURN IT. Horizontal drag turns the head,
 *                vertical drag pitches it. This is direct manipulation: the
 *                sphere projection swings the eyes around the ball as you
 *                turn, which is the single most satisfying thing this avatar
 *                does. Release and it springs back to following your gaze.
 *   TAP          blink
 *   DOUBLE TAP   wink
 *   LONG PRESS   sleep / wake
 *   SWIPE ←  →   a deliberate glance (peek) in that direction
 *   SWIPE ↑  ↓   nudge the mood: activity up / down
 *
 * ── Why this lives in `core/` ─────────────────────────────────────────────
 * The gesture recognition is pure logic: it takes positions and timestamps and
 * emits intents. It does not know about DOM events, React, or a canvas. That
 * means the C++ port consumes the SAME recogniser, fed by the CST820B
 * touch controller instead of `pointerdown`, and the interaction feels
 * identical on both — which is the point of splitting the engine out.
 *
 * The only Web-specific part is the adapter at the bottom, which converts
 * `PointerEvent`s into the plain calls this module understands.
 */

/** A discrete thing the user did. */
export type InteractionIntent =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'doubleTap'; x: number; y: number }
  | { kind: 'longPress'; x: number; y: number }
  | { kind: 'swipe'; dir: 'left' | 'right' | 'up' | 'down' };

/** Recognition thresholds, in milliseconds and normalised units. */
export interface InteractionTuning {
  /** Longest press still counted as a tap. */
  tapMaxMs: number;
  /** A tap farther than this from the previous one is not a double tap. */
  doubleTapMaxMs: number;
  /** How long a press must last to become a long press. */
  longPressMs: number;
  /** Movement beyond this cancels a tap (it is a drag). */
  tapSlop: number;
  /** Shortest travel that counts as a swipe. */
  swipeMinDist: number;
  /** Longest press that can still end as a swipe. */
  swipeMaxMs: number;
  /** Maximum head turn from a full drag, in radians. */
  dragTurnRange: number;
}

export const DEFAULT_TUNING: InteractionTuning = {
  // These are the standard values for touch on a small screen: long enough to
  // forgive a slow finger, short enough that a deliberate long press is not
  // mistaken for one.
  tapMaxMs: 250,
  doubleTapMaxMs: 280,
  longPressMs: 520,
  // In normalised units (the surface is -1..1 across), so ~4% of the panel.
  tapSlop: 0.04,
  swipeMinDist: 0.22,
  swipeMaxMs: 420,
  dragTurnRange: 0.9,
};

/**
 * Tracks one pointer through its lifetime and reports what it turned out to be.
 *
 * Deliberately a small state machine driven by three calls — `down`, `move`,
 * `up` — because that is exactly what a touch controller gives you.
 */
export class TouchRecogniser {
  /** Current position, normalised -1..1. The gaze target. */
  x = 0;
  y = 0;
  /** True while a pointer is down. */
  pressing = false;
  /** True once the press has travelled far enough to be a drag. */
  dragging = false;
  /** How far the current drag has travelled, in normalised units. */
  dragDX = 0;
  dragDY = 0;
  /** True once the current press became a long press. */
  private longFired = false;

  private downX = 0;
  private downY = 0;
  private downAt = 0;
  private lastTapAt = -1e9;
  private lastTapX = 0;
  private lastTapY = 0;

  constructor(private tuning: InteractionTuning = DEFAULT_TUNING) {}

  /** Retune at runtime (the Lab exposes the drag range as a slider). */
  setTuning(patch: Partial<InteractionTuning>): void {
    Object.assign(this.tuning, patch);
  }

  /**
   * Pointer down.
   *
   * @param x -1..1
   * @param y -1..1
   * @param now timestamp in ms (injected, never read from a clock here)
   */
  down(x: number, y: number, now: number): void {
    this.pressing = true;
    this.dragging = false;
    this.longFired = false;
    this.dragDX = 0;
    this.dragDY = 0;
    this.downX = x;
    this.downY = y;
    this.downAt = now;
    this.x = x;
    this.y = y;
  }

  /**
   * Pointer move.
   *
   * @returns the drag delta since the last move, so the caller can turn the
   *   head by it directly.
   */
  move(x: number, y: number): { dx: number; dy: number } {
    const dx = x - this.x;
    const dy = y - this.y;
    this.x = x;
    this.y = y;

    if (this.pressing) {
      this.dragDX = x - this.downX;
      this.dragDY = y - this.downY;
      // Promote to a drag once the finger has travelled past the tap slop. A
      // press that has not moved is still a potential tap or long press.
      if (Math.hypot(this.dragDX, this.dragDY) > this.tuning.tapSlop) {
        this.dragging = true;
      }
    }
    return { dx, dy };
  }

  /**
   * Pointer up. Resolves the press into at most one intent.
   *
   * @returns the recognised intent, or null if the press was a drag or too
   *   short to mean anything.
   */
  up(now: number): InteractionIntent | null {
    if (!this.pressing) return null;
    this.pressing = false;
    const held = now - this.downAt;
    const dist = Math.hypot(this.dragDX, this.dragDY);
    const wasDragging = this.dragging;
    this.dragging = false;

    // A long press already fired while held; it is never also a tap or swipe.
    if (this.longFired) return null;

    // ── Swipe ───────────────────────────────────────────────────────────
    // Checked BEFORE the drag bail-out, because a flick necessarily begins with
    // movement: judged by distance and time together, a fast flick that travels
    // far is a swipe while a slow drag over the same distance is a head turn.
    if (dist >= this.tuning.swipeMinDist && held <= this.tuning.swipeMaxMs) {
      const horizontal = Math.abs(this.dragDX) >= Math.abs(this.dragDY);
      // Only a clearly lateral/vertical motion counts; a diagonal is ambiguous.
      const ratio = horizontal
        ? Math.abs(this.dragDX) / Math.max(1e-6, Math.abs(this.dragDY))
        : Math.abs(this.dragDY) / Math.max(1e-6, Math.abs(this.dragDX));
      if (ratio >= 1.4) {
        const dir = horizontal
          ? this.dragDX < 0
            ? 'left'
            : 'right'
          : this.dragDY < 0
            ? 'up'
            : 'down';
        return { kind: 'swipe', dir };
      }
    }

    // A drag that was too slow to be a flick is not an intent: the user was
    // turning the head, which already happened while held.
    if (wasDragging) return null;

    // ── Tap / double tap ────────────────────────────────────────────────
    if (held > this.tuning.tapMaxMs) return null;

    const sinceLast = now - this.lastTapAt;
    const nearLast = Math.hypot(this.x - this.lastTapX, this.y - this.lastTapY) < 0.18;
    if (sinceLast <= this.tuning.doubleTapMaxMs && nearLast) {
      // Consume the pair so a third tap starts a fresh sequence rather than
      // reporting another double tap.
      this.lastTapAt = -1e9;
      return { kind: 'doubleTap', x: this.x, y: this.y };
    }

    this.lastTapAt = now;
    this.lastTapX = this.x;
    this.lastTapY = this.y;
    return { kind: 'tap', x: this.x, y: this.y };
  }

  /**
   * Poll while a press is held, to fire the long press.
   *
   * Called every frame because a long press has to happen *during* the hold —
   * waiting for the release would make it feel late.
   */
  tick(now: number): InteractionIntent | null {
    if (!this.pressing || this.longFired) return null;
    if (this.dragging) return null;
    if (now - this.downAt < this.tuning.longPressMs) return null;
    this.longFired = true;
    return { kind: 'longPress', x: this.x, y: this.y };
  }

  /** Cancel the current press — pointer left, or the page lost focus. */
  cancel(): void {
    this.pressing = false;
    this.dragging = false;
    this.longFired = false;
  }
}

/**
 * Convert a drag into a head turn, in radians.
 *
 * The mapping is intentionally direct: dragging a third of the surface width
 * turns the head to its limit. No inertia is applied here — the caller's spring
 * supplies that, which keeps this a pure function of the drag.
 *
 * ── THE SIGN OF PITCH IS INVERTED ON PURPOSE ──────────────────────────────
 * Screen coordinates grow DOWNWARD, and the projection is a standard 3D one
 * where positive pitch tips the face UP. So a raw `+dragDY` (finger moving
 * down) tipped the head *up* — backwards from what the gesture means.
 *
 * The fix is a negation, and it is worth stating why rather than hiding it in a
 * minus sign: the vertical axis is the only one where the screen's convention
 * and the projection's convention disagree. Yaw needs no correction — dragging
 * right already turns the face right — which is exactly why the bug looked like
 * "the swipe direction is reversed" only some of the time.
 */
export function dragToTurn(
  dragDX: number,
  dragDY: number,
  range: number,
): { yaw: number; pitch: number } {
  const clamp = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v);
  return {
    yaw: clamp(dragDX) * range,
    // Negated: drag down => pitch NEGATIVE => the face tips DOWN, following
    // the finger. The 0.55 is separate — a head tips less far than it turns.
    pitch: clamp(-dragDY) * range * 0.55,
  };
}
