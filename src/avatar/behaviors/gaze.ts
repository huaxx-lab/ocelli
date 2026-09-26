/**
 * gaze.ts — GazeController.
 *
 * The interface boundary that matters most for the StopWatch port.
 *
 * AURA has no gaze model at all: five fixed poses picked from a weighted
 * table every 18-45 s. Grok's orb has no gaze either. KK drives eyes from
 * touch/IMU. We need the KK/AURA behaviour *and* a clean seam for the future
 * BMI270, so this controller consumes a **gaze source** that is explicitly
 * not a mouse:
 *
 *     Avatar Lab  -> PointerGazeSource   (mouse / touch)
 *     StopWatch   -> ImuGazeSource       (BMI270 tilt + gyro feed-forward)
 *     Agent       -> TargetGazeSource    (look at a UI element / the user)
 *
 * The controller itself only knows `lookX/lookY` in -1..1, plus micro-saccade
 * gestures from AURA's weighted idle table.
 *
 * Inertia is added with a spring: the eyes must arrive *after* the source, or
 * they read as glued to the cursor. KK gets this from IMU filtering; we get
 * it from a critically-damped second-order follower.
 */

import { Spring } from '../core/transitions';
import { Deadline, Rng } from '../core/timeline';
import type { AssistantState } from '../core/state';

/**
 * Anything that can produce a normalised gaze direction.
 *
 * Deliberately tiny: a future BMI270 driver implements this in ~20 lines
 * (`x = clamp(gyroY / maxTilt)`, `y = clamp(gyroX / maxTilt)` plus a
 * complementary filter on the accelerometer).
 */
export interface GazeSource {
  /** Human-readable name, shown in the Lab's seam indicator. */
  readonly kind: string;
  /** Normalised look direction, each -1..1. */
  read(): { x: number; y: number };
}

/** Mouse / touch input. The Lab's default. */
export class PointerGazeSource implements GazeSource {
  readonly kind = 'pointer';
  private x = 0;
  private y = 0;

  /** @param nx -1..1 horizontal */
  set(nx: number, ny: number): void {
    this.x = nx;
    this.y = ny;
  }

  read(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }
}

/** Fixed direction — used by states that must look somewhere specific. */
export class TargetGazeSource implements GazeSource {
  readonly kind = 'target';
  constructor(
    private x = 0,
    private y = 0,
    private readonly blend = 1,
  ) {}
  set(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }
  read(): { x: number; y: number } {
    return { x: this.x * this.blend, y: this.y * this.blend };
  }
}

/**
 * AURA's weighted idle gesture table, expressed as gaze *gestures* rather
 * than fixed frames. Weights and hold times are taken directly from
 * `aura_random_idle_animation`; only the representation changed (offsets
 * instead of pre-rendered images).
 *
 * Kept short and rare on purpose: the brief says the AI must read as calm,
 * not ADHD. AURA's 18-45 s interval is preserved.
 */
interface Gesture {
  name: string;
  x: number;
  y: number;
  holdMs: number;
  weight: number;
}

const GESTURES: readonly Gesture[] = [
  { name: 'glance-left', x: -0.62, y: 0.02, holdMs: 900, weight: 18 },
  { name: 'glance-right', x: 0.62, y: 0.02, holdMs: 900, weight: 18 },
  { name: 'eyes-up', x: -0.08, y: -0.5, holdMs: 850, weight: 12 },
  { name: 'hold-left', x: -0.5, y: 0.05, holdMs: 1300, weight: 12 },
  { name: 'hold-right', x: 0.5, y: 0.05, holdMs: 1300, weight: 12 },
  // "face-up" / "face-down" in AURA tilt the whole head; here they become a
  // whole-orb tilt, applied by the ambient controller, but the eye component
  // still contributes.
  { name: 'face-up', x: 0, y: -0.75, holdMs: 1100, weight: 8 },
  { name: 'face-down', x: 0, y: 0.7, holdMs: 1100, weight: 8 },
  { name: 'soft-smile', x: 0.12, y: -0.06, holdMs: 320, weight: 12 },
];

/**
 * Where each state looks, as a base offset in -1..1.
 *
 * THIS IS THE INTERACTION CHANNEL. The brief asks for an avatar whose eyes
 * visibly look up / down / left / right and whose mood is readable — that is
 * this table, not the saccades.
 *
 * The distinction matters and was got wrong at first: saccades are *random*
 * noise layered on top, while this is the *deliberate* direction. When both
 * were mixed into one channel, the state's direction was swamped by the noise,
 * and THINKING ended up looking exactly like IDLE.
 *
 *   idle              centre, resting
 *   listening         level, engaged with the speaker
 *   thinking          UP and to one side — "looking into the middle distance"
 *   working           level and slightly down — "focused on the task"
 *   speaking          level, on the listener
 *   waiting_input     dead level at the user — eye contact
 *   waiting_approval  level at the user, a touch down (gravity of the moment)
 *   success           UP — the eyes lift with the mood
 *   error             DOWN and away — averting
 *   sleeping          down, drifting shut
 */
const BASE_LOOK: Record<AssistantState, { x: number; y: number }> = {
  idle: { x: 0, y: 0 },
  listening: { x: 0, y: -0.1 },
  thinking: { x: -0.28, y: -0.85 },
  working: { x: 0.1, y: 0.3 },
  speaking: { x: 0, y: -0.06 },
  waiting_input: { x: 0, y: -0.02 },
  waiting_approval: { x: 0, y: 0.06 },
  success: { x: 0, y: -0.6 },
  error: { x: -0.22, y: 0.75 },
  sleeping: { x: 0.06, y: 0.5 },
};

/**
 * How much of the random saccade survives in each state.
 *
 * AWAITING states keep almost none: a darting gaze while the user is deciding
 * reads as evasive. IDLE and THINKING keep the most, because that is where
 * liveliness is wanted.
 */
const SACCADE_GAIN: Record<AssistantState, number> = {
  idle: 1,
  listening: 0.3,
  thinking: 0.75,
  working: 0.5,
  speaking: 0.45,
  waiting_input: 0.1,
  waiting_approval: 0.1,
  success: 0.5,
  error: 0.25,
  sleeping: 0.15,
};

export class GazeController {
  /** Springed output, -1..1. Drives `eyeOffsetX` / `eyeOffsetY`. */
  x = 0;
  y = 0;

  /** Emitted once when a gesture or saccade starts, for the Lab's readout. */
  lastGesture = '';
  lastSaccade = '';

  private springX: Spring;
  private springY: Spring;
  private deadline: Deadline;
  private gesture: Gesture | null = null;
  private gestureElapsed = 0;
  private gestureBlend = 0;

  // ── Saccade state ──────────────────────────────────────────────────────
  // A saccade is a fast, ballistic eye movement followed by a hold. This is
  // the mechanism that makes eyes read as *alive*: without it they only drift,
  // and slow drift with no jumps looks like a sleeping person.
  private saccadeDeadline: Deadline;
  private saccade: { dx: number; dy: number; holdMs: number } | null = null;
  private saccadeElapsed = 0;

  /**
   * An externally supplied bias, -1..1, added to whatever the source reports.
   *
   * This exists so the Lab's Look X/Y sliders and the pointer can drive the
   * gaze *simultaneously* without either overwriting the other. The source is
   * the primary input; the bias nudges it.
   */
  private biasX = 0;
  private biasY = 0;

  /** Set the external bias (sliders, or a future agent-driven look-at). */
  setBias(x: number, y: number): void {
    this.biasX = clamp(x, -1, 1);
    this.biasY = clamp(y, -1, 1);
  }

  constructor(
    private readonly rng: Rng,
    private readonly source: GazeSource,
  ) {
    // 0.16 s smooth time: enough lag to read as mass, little enough that the
    // eyes still feel responsive to a deliberate look.
    this.springX = new Spring(0, 0.16, 3.2);
    this.springY = new Spring(0, 0.19, 2.6);
    this.deadline = new Deadline(rng, 18000, 45000);
    // Saccades fire far more often than the idle gesture table: 0.9-3.2 s is
    // the human range for spontaneous gaze shifts during a relaxed task.
    this.saccadeDeadline = new Deadline(rng, 800, 2600);
  }

  /** Force the next gesture to happen soon (Lab's "poke" affordance). */
  reseed(minMs = 18000, maxMs = 45000): void {
    this.deadline.reseed(minMs, maxMs);
  }

  /** Fire a random gesture immediately. */
  poke(): void {
    this.startGesture();
  }

  /** Fire a saccade immediately (Lab's "look around" poke). */
  saccadeNow(): void {
    this.startSaccade(1);
  }

  private startGesture(): void {
    const next = this.rng.weighted(GESTURES.map((g) => ({ value: g, weight: g.weight })));
    if (this.gesture && next.name === this.gesture.name && GESTURES.length > 1) {
      const others = GESTURES.filter((g) => g.name !== next.name);
      this.gesture = this.rng.weighted(others.map((g) => ({ value: g, weight: g.weight })));
    } else {
      this.gesture = next;
    }
    this.lastGesture = this.gesture.name;
    this.gestureElapsed = 0;
  }

  /**
   * Start a saccade. `scale` widens the jump for a deliberate look-around.
   *
   * The offsets are drawn from the full -1..1 range rather than a small
   * neighbourhood, because the reference avatar moves its eyes across most of
   * its face — a gaze confined to the middle is the "dead" look.
   */
  private startSaccade(scale = 1): void {
    // Bias towards horizontal movement: real gaze shifts are mostly lateral,
    // and a vertical-only jump reads as a nod rather than as looking.
    const angle = this.rng.range(0, Math.PI * 2);
    const reach = this.rng.range(0.5, 1) * scale;
    const dx = Math.cos(angle) * reach;
    // Vertical range is smaller than horizontal (real gaze shifts are
    // mostly lateral) but still substantial — a gaze that only moves sideways
    // never reads as looking up or down.
    const dy = Math.sin(angle) * reach * 0.8;
    this.saccade = {
      dx: clamp(dx, -1, 1),
      dy: clamp(dy, -1, 1),
      // Hold times from the reference: brief glances and longer holds mixed.
      holdMs: this.rng.weighted([
        { value: 360, weight: 34 },
        { value: 700, weight: 34 },
        { value: 1250, weight: 22 },
        { value: 2100, weight: 10 },
      ]),
    };
    this.saccadeElapsed = 0;
    this.lastSaccade = `${dx >= 0 ? 'right' : 'left'}${Math.abs(dy) > 0.3 ? dy < 0 ? '-up' : '-down' : ''}`;
  }

  /**
   * @param dt        seconds
   * @param state     current AssistantState
   * @param attention 0..1 — high attention suppresses random glances and
   *                  biases the eyes towards the user (centre/forward)
   * @param idleGestures whether the ambient gesture table may fire at all
   */
  step(
    dt: number,
    state: AssistantState,
    attention: number,
    idleGestures: boolean,
  ): { x: number; y: number } {
    // ── Gesture layer (AURA's weighted idle table) ──────────────────────
    if (this.gesture) {
      this.gestureElapsed += dt * 1000;
      const hold = this.gesture.holdMs;
      const inMs = 220;
      const outMs = 260;
      if (this.gestureElapsed < inMs) {
        this.gestureBlend = this.gestureElapsed / inMs;
      } else if (this.gestureElapsed < inMs + hold) {
        this.gestureBlend = 1;
      } else if (this.gestureElapsed < inMs + hold + outMs) {
        this.gestureBlend = 1 - (this.gestureElapsed - inMs - hold) / outMs;
      } else {
        this.gesture = null;
        this.gestureBlend = 0;
      }
    } else if (idleGestures) {
      if (this.deadline.consume(dt, 18000, 45000)) this.startGesture();
    }

    // ── Saccade layer ───────────────────────────────────────────────────
    // Suppressed while the character must hold eye contact (waiting states and
    // listening), because a darting gaze during "I'm waiting for you" reads as
    // evasive rather than attentive.
    const saccadesAllowed =
      state === 'idle' || state === 'thinking' || state === 'working' || state === 'speaking';

    if (this.saccade) {
      this.saccadeElapsed += dt * 1000;
      if (this.saccadeElapsed >= this.saccade.holdMs) this.saccade = null;
    }

    if (!this.saccade && saccadesAllowed) {
      // Faster cadence when active/thinking, slower when calm.
      const min = state === 'thinking' || state === 'working' ? 520 : 800;
      const max = state === 'thinking' || state === 'working' ? 1600 : 2600;
      if (this.saccadeDeadline.consume(dt, min, max)) this.startSaccade();
    }

    // ── Compose the target ──────────────────────────────────────────────
    //
    // THE ANCHOR + OFFSET MODEL. This is subtle and was got wrong twice:
    //
    //   1st attempt: the state direction was applied BEFORE the saccades, so
    //                the noise cancelled it — THINKING looked like IDLE.
    //   2nd attempt: the state was blended at 75% weight, which *crushed* the
    //                saccade amplitude by 4x — the eyes went dead again.
    //
    // The fix: the state's direction is an ANCHOR (applied at full strength),
    // and the saccade / gesture / pointer are ADDITIVE offsets around it. That
    // is also how real gaze works — you look *at* something and your eyes
    // jitter around that point.
    //
    // `SACCADE_GAIN` is what stops a WAITING state from fidgeting: the anchor
    // holds the direction, the gain controls how much life is allowed on top.
    const raw = this.source.read();

    // Attention pulls the gaze towards the user (and shrinks the jitter).
    const pull = 0.25 + attention * 0.7;

    // Layer 1 — THE STATE'S DIRECTION. The anchor.
    const base = BASE_LOOK[state];

    // Layer 2 — pointer / future IMU plus the external bias. Deliberately
    // small: an external input should steer the gaze, not yank it off the
    // state's intent. The bias is ADDED so sliders and the pointer compose.
    const inputGain = 0.3 * (1 - pull * 0.4);
    const srcX = clamp(raw.x + this.biasX, -1, 1);
    const srcY = clamp(raw.y + this.biasY, -1, 1);

    // Layer 3 — the random saccade, scaled by the state's tolerance for it.
    const gain = SACCADE_GAIN[state] * (1 - attention * 0.45);
    const saccadeX = this.saccade && saccadesAllowed ? this.saccade.dx * gain : 0;
    const saccadeY = this.saccade && saccadesAllowed ? this.saccade.dy * gain : 0;

    // Layer 4 — the ambient gesture.
    const gestureK = this.gesture ? this.gestureBlend * (1 - attention * 0.7) : 0;
    const gestureX = this.gesture ? this.gesture.x * gestureK : 0;
    const gestureY = this.gesture ? this.gesture.y * gestureK : 0;

    let targetX = base.x + srcX * inputGain + saccadeX + gestureX;
    let targetY = base.y + srcY * inputGain * 0.8 + saccadeY + gestureY;

    // Keep the anchor dominant where the state demands steadiness, by scaling
    // the *offsets* if they would pull the gaze too far from where it should be.
    const maxDrift = state === 'waiting_input' || state === 'waiting_approval' ? 0.22 : 1.0;
    const driftX = targetX - base.x;
    const driftY = targetY - base.y;
    const drift = Math.hypot(driftX, driftY);
    if (drift > maxDrift) {
      const k = maxDrift / drift;
      targetX = base.x + driftX * k;
      targetY = base.y + driftY * k;
    }

    targetX = clamp(targetX, -1, 1);
    targetY = clamp(targetY, -1, 1);

    // ── Spring ──────────────────────────────────────────────────────────
    // A saccade is BALLISTIC: it should arrive fast and hard, not glide. So
    // the spring is retuned per-frame — short smoothTime while a saccade is
    // active, long while merely drifting. This asymmetry is what makes the
    // motion read as an eye rather than as a lerp.
    const saccading = this.saccade !== null && this.saccadeElapsed < 190;
    const smooth = saccading
      ? 0.045
      : state === 'thinking' || state === 'sleeping'
        ? 0.3
        : 0.16;

    this.x = this.springX.stepWith(targetX, dt, smooth, saccading ? 14 : 3.2);
    this.y = this.springY.stepWith(targetY, dt, smooth * 1.1, saccading ? 11 : 2.6);

    return { x: this.x, y: this.y };
  }

}

/** Clamp to an arbitrary range (params.clamp is 0..1 only). */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
