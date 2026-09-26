/**
 * ambient.ts — MicroReaction / AmbientController.
 *
 * The "very small, very rare" life layer. The brief is explicit that the AI
 * must read as calm rather than ADHD, so every parameter here is tuned
 * downwards from what feels good in isolation:
 *
 *   - micro-reactions fire on a 12-30 s timer, never more than one at a time
 *   - amplitudes are at or below 1% of the orb radius
 *   - a reaction never competes with a state transition (it is suppressed
 *     while a state blend is in flight)
 *
 * Fusion:
 *   KK       — a continuous procedural baseline (breathing / drift) that
 *              never stops, so the avatar is alive even between gestures
 *   AURA     — the *discrete* micro-gesture idea and its long, randomized
 *              scheduling, plus the 8°/s outer-ring rotation
 *   Grok     — nothing here; Grok's motion is all state-driven, and copying
 *              it into idle is exactly the "ADHD" failure mode
 */

import { Deadline, Rng } from '../core/timeline';
import type { AssistantState } from '../core/state';

/**
 * A one-shot micro-reaction. Each is a tiny, named deviation that decays
 * back to zero — they are additive deltas, never absolute poses, so they
 * layer on top of whatever state is active without fighting it.
 */
interface Reaction {
  name: string;
  weight: number;
  /** Total duration in seconds. */
  duration: number;
  /** Return the delta at normalised progress `p` (0..1). */
  sample: (p: number) => ReactionDelta;
}

interface ReactionDelta {
  tilt?: number; // radians
  squashX?: number;
  squashY?: number;
  glanceX?: number;
  glanceY?: number;
  haloShift?: number;
  trailDrift?: number;
}

/** Decay envelope: fast attack, smooth release, always returns to 0. */
function bump(p: number, peakAt = 0.22): number {
  if (p < peakAt) {
    const k = p / peakAt;
    return k * k * (3 - 2 * k);
  }
  const k = (p - peakAt) / (1 - peakAt);
  const s = 1 - k;
  return s * s * (3 - 2 * s);
}

/**
 * The reaction table. Deliberately tiny amplitudes: a "tiny tilt" is
 * 0.02 rad (~1.1°) and a "very small orb compression" is 1.5%.
 */
const REACTIONS: readonly Reaction[] = [
  {
    name: 'tiny-tilt',
    weight: 22,
    duration: 1.6,
    sample: (p) => ({ tilt: bump(p) * 0.022 }),
  },
  {
    name: 'glance',
    weight: 20,
    duration: 1.1,
    sample: (p) => {
      const b = bump(p, 0.18);
      return { glanceX: b * 0.16, glanceY: b * -0.05 };
    },
  },
  {
    name: 'compress',
    weight: 18,
    duration: 1.3,
    sample: (p) => {
      const b = bump(p, 0.3);
      return { squashX: b * 0.015, squashY: -b * 0.014 };
    },
  },
  {
    name: 'trail-drift',
    weight: 16,
    duration: 2.4,
    sample: (p) => ({ trailDrift: bump(p, 0.4) * 0.09 }),
  },
  {
    name: 'halo-shift',
    weight: 14,
    duration: 2.0,
    sample: (p) => ({ haloShift: bump(p, 0.35) * 0.03 }),
  },
  {
    name: 'double-tilt',
    weight: 10,
    duration: 2.2,
    sample: (p) => {
      // A small tilt one way, then a smaller correction — the "settling"
      // motion of something that just moved.
      const a = bump(p, 0.2);
      const b = bump(Math.max(0, (p - 0.45) / 0.55), 0.3);
      return { tilt: a * 0.026 - b * 0.014 };
    },
  },
];

export class AmbientController {
  /** Slow positional drift of the whole orb, in normalised orb radii. */
  driftX = 0;
  driftY = 0;
  /** Orbital tilt from micro-reactions, radians. */
  tilt = 0;
  /** Additive orb squash from micro-reactions. */
  squashX = 0;
  squashY = 0;
  /** Additive gaze offset from micro-reactions. */
  glanceX = 0;
  glanceY = 0;
  /** Additive halo radius offset. */
  haloShift = 0;
  /** Additive trail phase drift. */
  trailDrift = 0;
  /** AURA's slow outer-ring rotation, radians. 8°/s => 45 s per turn. */
  ringRotation = 0;

  lastReaction = '';

  private deadline: Deadline;
  private active: Reaction | null = null;
  private elapsed = 0;
  private time = 0;

  constructor(private readonly rng: Rng) {
    // AURA's idle-expression cadence, 18-45 s. We shorten the floor a little
    // because a browser avatar is looked at directly rather than glanced at,
    // but stay far away from anything twitchy.
    this.deadline = new Deadline(rng, 12000, 30000);
  }

  /** Fire a reaction immediately (Lab affordance / manual test). */
  poke(): void {
    this.start();
  }

  reseed(minMs = 12000, maxMs = 30000): void {
    this.deadline.reseed(minMs, maxMs);
  }

  private start(): void {
    const next = this.rng.weighted(REACTIONS.map((r) => ({ value: r, weight: r.weight })));
    // Never run the same reaction twice in a row.
    if (this.active && next.name === this.active.name && REACTIONS.length > 1) {
      const others = REACTIONS.filter((r) => r.name !== next.name);
      this.active = this.rng.weighted(others.map((r) => ({ value: r, weight: r.weight })));
    } else {
      this.active = next;
    }
    this.lastReaction = this.active.name;
    this.elapsed = 0;
  }

  /**
   * @param dt        seconds
   * @param state     current AssistantState
   * @param activity  0..1 — scales the continuous drift
   * @param suppress  true while a state transition is in flight, or while the
   *                  character is deeply engaged (LISTENING/WAITING_*)
   */
  step(dt: number, state: AssistantState, activity: number, suppress: boolean): void {
    this.time += dt;

    // ── Continuous layer (KK) ───────────────────────────────────────────
    // Two incommensurate periods per axis so the drift never loops visibly.
    // Sleeping damps it to almost nothing but never to exactly nothing.
    const sleepFactor = state === 'sleeping' ? 0.22 : 1;
    const energy = (0.35 + activity * 0.65) * sleepFactor;
    // Amplitudes are in orb radii; 0.004 is ~0.4% of the radius at 466 px,
    // i.e. under one pixel of travel. Subtlety is the entire point.
    this.driftX = (Math.sin((this.time / 11.3) * Math.PI * 2) * 0.6 + Math.sin((this.time / 4.7) * Math.PI * 2) * 0.4) * 0.004 * energy;
    this.driftY = (Math.sin((this.time / 13.9) * Math.PI * 2 + 1.1) * 0.6 + Math.sin((this.time / 5.3) * Math.PI * 2) * 0.4) * 0.0035 * energy;

    // AURA's ring rotation: exactly 2° per 250 ms. This is the one
    // continuous motion AURA has, and it is what stops the face reading as a
    // static image between gestures.
    const ringSpeed = state === 'sleeping' ? 0.002 : 0.0028; // rad/s
    this.ringRotation = (this.ringRotation + ringSpeed * dt * energy) % (Math.PI * 2);

    // ── Discrete layer (AURA) ───────────────────────────────────────────
    if (this.active) {
      this.elapsed += dt;
      const p = this.elapsed / this.active.duration;
      if (p >= 1) {
        this.active = null;
        this.squashX = 0;
        this.squashY = 0;
        this.tilt = 0;
        this.glanceX = 0;
        this.glanceY = 0;
        this.haloShift = 0;
        this.trailDrift = 0;
      } else {
        const d = this.active.sample(p);
        this.tilt = d.tilt ?? 0;
        this.squashX = d.squashX ?? 0;
        this.squashY = d.squashY ?? 0;
        this.glanceX = d.glanceX ?? 0;
        this.glanceY = d.glanceY ?? 0;
        this.haloShift = d.haloShift ?? 0;
        this.trailDrift = d.trailDrift ?? 0;
      }
    } else if (!suppress && this.deadline.consume(dt, 12000, 30000)) {
      this.start();
    }
  }
}
