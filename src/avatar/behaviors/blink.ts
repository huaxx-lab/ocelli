/**
 * blink.ts — BlinkController.
 *
 * Ported from AURA's `aura_blink` script, which is the single highest
 * life-feel-per-line behaviour in that project. Two details matter more than
 * the blink itself:
 *
 *   1. The interval is 6-20 s uniform, NOT a fixed period. A fixed period
 *      reads as a machine within about thirty seconds.
 *   2. After the character stops speaking / wakes up, the interval is
 *      *reseeded short* (2.5-6 s). Blinking sooner right after engagement is
 *      what makes it feel like the character re-engages with you.
 *
 * We add KK's easing to AURA's hard frame flips: a real eyelid has mass, so
 * the close is faster than the open. AURA's 70/90/70 ms is preserved as the
 * default shape.
 */

import { EASINGS } from '../core/easing';
import { Deadline, Rng } from '../core/timeline';
import type { AssistantState } from '../core/state';

interface BlinkTiming {
  /** Milliseconds for the closing half. */
  closeMs: number;
  /** Milliseconds fully shut. */
  holdMs: number;
  /** Milliseconds for the opening half. */
  openMs: number;
  /** Minimum interval between blinks. */
  minMs: number;
  /** Maximum interval between blinks. */
  maxMs: number;
  /** Probability of an immediate second blink (AURA: 0.20). */
  doubleChance: number;
  /** Extra delay before the second blink of a double. */
  doubleGapMs: number;
}

/**
 * Per-state blink personality. AURA only blinks while idle (its gate requires
 * `phase == 1`); we relax that because a Web avatar that cannot blink while
 * thinking looks frozen — but we keep the *cadence changes*, which is the
 * part that carries meaning.
 */
const TIMING: Record<'idle' | 'engaged' | 'thinking' | 'deep' | 'sleeping', BlinkTiming> = {
  // AURA idle: 6-20 s, 20% double, 230 ms blink.
  idle: {
    closeMs: 70,
    holdMs: 90,
    openMs: 70,
    minMs: 6000,
    maxMs: 20000,
    doubleChance: 0.2,
    doubleGapMs: 120,
  },
  // AURA's post-engagement reseed: 2.5-6 s. Same shape, faster cadence.
  engaged: {
    closeMs: 70,
    holdMs: 90,
    openMs: 70,
    minMs: 2500,
    maxMs: 6000,
    doubleChance: 0.2,
    doubleGapMs: 120,
  },
  // THINKING: rarer and slightly slower — attention is elsewhere.
  thinking: {
    closeMs: 90,
    holdMs: 110,
    openMs: 110,
    minMs: 5200,
    maxMs: 12000,
    doubleChance: 0.08,
    doubleGapMs: 140,
  },
  // LISTENING / WAITING_*: suppressed hard. AURA never blinks while engaged,
  // and it is right — a blink mid-sentence breaks eye contact.
  deep: {
    closeMs: 80,
    holdMs: 90,
    openMs: 90,
    minMs: 9000,
    maxMs: 18000,
    doubleChance: 0.05,
    doubleGapMs: 120,
  },
  // SLEEPING: blinking is disabled; the sleep pose is the closed eye.
  sleeping: {
    closeMs: 1,
    holdMs: 1,
    openMs: 1,
    minMs: 1e9,
    maxMs: 1e9,
    doubleChance: 0,
    doubleGapMs: 0,
  },
};

export type BlinkMode = keyof typeof TIMING;

export class BlinkController {
  /** 0 = open, 1 = shut. Written every step; the renderer reads it. */
  value = 0;

  private deadline: Deadline;
  private timing: BlinkTiming = TIMING.idle;
  private elapsed = -1; // <0 = not blinking
  private queued = 0; // pending double blinks

  constructor(private readonly rng: Rng) {
    this.deadline = new Deadline(rng, TIMING.idle.minMs, TIMING.idle.maxMs);
    this.elapsed = -1;
  }

  /** Total length of one blink in seconds. */
  private get blinkDuration(): number {
    return (this.timing.closeMs + this.timing.holdMs + this.timing.openMs) / 1000;
  }

  /**
   * Reseed to the short "re-engaged" interval.
   * AURA calls this after speaking ends, after music stops, and on wake.
   */
  reseedShort(): void {
    this.deadline.reseed(TIMING.engaged.minMs, TIMING.engaged.maxMs);
  }

  /** Force a blink right now (used by the Lab's manual trigger). */
  trigger(): void {
    if (this.elapsed >= 0) return;
    this.elapsed = 0;
  }

  /**
   * Advance the controller.
   *
   * @param dt    seconds since the last step
   * @param state current AssistantState
   * @param engagedOverride - when true, use the short post-engagement cadence
   *   regardless of state (set by the engine for a few seconds after
   *   SPEAKING/WORKING ends).
   */
  step(dt: number, state: AssistantState, engagedOverride = false): number {
    const mode = this.modeFor(state, engagedOverride);
    const next = TIMING[mode];
    if (next !== this.timing) {
      // Entering a new cadence band: reseed so the change is felt promptly
      // instead of waiting out the old interval.
      this.timing = next;
      this.deadline.reseed(next.minMs, next.maxMs);
    }

    if (mode === 'sleeping') {
      this.value = 0; // the sleep pose owns the eyelids
      return this.value;
    }

    if (this.elapsed < 0) {
      // Not blinking: count down to the next one.
      if (this.deadline.consume(dt, this.timing.minMs, this.timing.maxMs)) {
        this.elapsed = 0;
      } else {
        return this.value;
      }
    }

    this.elapsed += dt;
    const total = this.blinkDuration;
    if (this.elapsed >= total) {
      // Blink finished.
      this.value = 0;
      this.elapsed = -1;
      if (this.queued > 0) {
        this.queued -= 1;
        // AURA's double blink: a 120 ms gap, then the second blink.
        this.deadline.scheduleIn(this.timing.doubleGapMs);
        this.elapsed = -2; // sentinel: "waiting out the double gap"
      } else if (this.rng.chance(this.timing.doubleChance)) {
        this.queued = 1;
        this.deadline.scheduleIn(this.timing.doubleGapMs);
        this.elapsed = -2;
      }
      return this.value;
    }

    if (this.elapsed === -2) {
      // In the gap between the two halves of a double blink.
      if (this.deadline.consume(dt, this.timing.doubleGapMs, this.timing.doubleGapMs)) {
        this.elapsed = 0;
      }
      return this.value;
    }

    this.value = this.shape(this.elapsed);
    return this.value;
  }

  /**
   * Eyelid curve. Asymmetric on purpose: closing is a small, fast muscle
   * movement, opening is slower. A symmetric blink looks like a camera
   * shutter.
   */
  private shape(elapsed: number): number {
    const close = this.timing.closeMs / 1000;
    const hold = this.timing.holdMs / 1000;
    const open = this.timing.openMs / 1000;

    if (elapsed < close) {
      return EASINGS.cubicOut(elapsed / close);
    }
    if (elapsed < close + hold) {
      return 1;
    }
    const k = (elapsed - close - hold) / open;
    return 1 - EASINGS.cubicInOut(k);
  }

  private modeFor(state: AssistantState, engagedOverride: boolean): BlinkMode {
    if (state === 'sleeping') return 'sleeping';
    if (state === 'thinking' || state === 'working') return 'thinking';
    if (
      state === 'listening' ||
      state === 'speaking' ||
      state === 'waiting_input' ||
      state === 'waiting_approval' ||
      state === 'success' ||
      state === 'error'
    ) {
      return 'deep';
    }
    return engagedOverride ? 'engaged' : 'idle';
  }
}
