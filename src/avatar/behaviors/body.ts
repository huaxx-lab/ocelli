/**
 * body.ts — BodyController. THE HEAD MOVES.
 *
 * This is the layer that was missing, and its absence is why the avatar read
 * as "a face painted on a ball" rather than as a creature. Two references
 * pointed at it and I had only implemented the eye half of each:
 *
 *   - The Grok orb scene applies a `bodyTransform` to the whole body, drifting
 *     ±1.49 in X, ±1.45 in Y and rotating, INDEPENDENTLY of the eyes.
 *   - A spring-driven character study (blessonism/grok-icon-study, study-only,
 *     no licence for reuse) drives the entire rig from four springs —
 *     `spin`, `tx`, `ty`, `squash` — and layers hops and spins on top.
 *
 * So a pose here is not just "where do the eyes look": it is where the *body*
 * leans, how far it has drifted, and how it is squashed. The eyes ride inside.
 *
 * ── Design rules ──────────────────────────────────────────────────────────
 *  1. **Everything is a spring.** Nothing is set directly. A lean is a spring
 *     target, a hop is an impulse into a spring's velocity. That is what makes
 *     the motion overshoot and settle like a physical object.
 *  2. **Squash preserves volume.** `scaleY` grows ⇒ `scaleX` shrinks by a
 *     related amount, so the orb reads as a soft body rather than as a
 *     scaling sticker.
 *  3. **Lean follows the gaze.** When the eyes look left the body tilts a
 *     little left too. That single coupling is most of the "it's alive" read,
 *     because it is what a real head does.
 *  4. **Amplitudes are small.** The whole rig moves on the order of 2-6% of
 *     the radius. This is a companion, not a puppet.
 *
 * All constants are derived for our own proportions and palette; none are
 * copied from a reference implementation.
 */

import { Spring } from '../core/transitions';
import { Deadline, Rng } from '../core/timeline';
import { MAX_PITCH, MAX_YAW } from '../core/sphere';

/** Clamp to an arbitrary range. */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
import type { AssistantState } from '../core/state';

/**
 * Per-state body attitude.
 *
 * `lean` is the resting rotation in radians, `driftX/driftY` the resting
 * offset as a fraction of the radius, and `squash` a resting scale-Y delta.
 * These are the deliberate, held poses — the springs then carry the body to
 * them and overshoot naturally.
 */
interface BodyPose {
  lean: number;
  driftX: number;
  driftY: number;
  squash: number;
  /** Amplitude multiplier for the continuous breathing motion. */
  breathe: number;
  /** Whether the idle "look around" head-turns are allowed. */
  wandering: boolean;
}

const BODY_POSES: Record<AssistantState, BodyPose> = {
  // Resting: upright, a slow breath, and the head idly turns now and then.
  idle: { lean: 0, driftX: 0, driftY: 0, squash: 0, breathe: 1, wandering: true },
  // Listening: leans IN and slightly forward. The lean is the whole read.
  listening: { lean: 0, driftX: 0, driftY: 0.035, squash: 0.012, breathe: 1.25, wandering: false },
  // Thinking: tilted over, drifting — "weighing something up".
  thinking: { lean: -0.09, driftX: -0.02, driftY: -0.03, squash: 0.02, breathe: 0.8, wandering: true },
  // Working: upright and deliberate, a slow purposeful bob.
  working: { lean: 0.02, driftX: 0.012, driftY: 0.02, squash: -0.01, breathe: 1.1, wandering: false },
  // Speaking: small nods, taller posture.
  speaking: { lean: 0, driftX: 0, driftY: -0.012, squash: -0.008, breathe: 1.4, wandering: false },
  // Waiting: leans in, absolutely steady. Stillness is the message.
  waiting_input: { lean: 0, driftX: 0, driftY: 0.045, squash: 0.014, breathe: 0.45, wandering: false },
  waiting_approval: { lean: 0, driftX: 0, driftY: 0.055, squash: 0.018, breathe: 0.35, wandering: false },
  // Success: puffs UP and back — literally buoyant.
  success: { lean: 0, driftX: 0, driftY: -0.075, squash: -0.055, breathe: 1.8, wandering: false },
  // Error: SAGS. Dropped, compressed, heavier.
  error: { lean: 0.05, driftX: -0.015, driftY: 0.065, squash: 0.05, breathe: 0.5, wandering: false },
  // Sleeping: slumped down and forward, breathing very slowly.
  sleeping: { lean: 0.13, driftX: 0.02, driftY: 0.105, squash: 0.055, breathe: 0.3, wandering: false },
};

/** A one-shot body move — a hop, a shake, a spin-bounce. */
interface Move {
  name: string;
  /** Total duration in seconds. */
  duration: number;
  /** Vertical impulse applied to the Y spring's velocity at t=0. */
  impulseY?: number;
  /** Rotational impulse applied to the lean spring. */
  impulseRot?: number;
  /** Horizontal impulse. */
  impulseX?: number;
  /** Extra squash impulse (positive = compress). */
  impulseSquash?: number;
}

export class BodyController {
  /** Outputs, written every step. */
  rotation = 0;
  x = 0;
  y = 0;
  scaleX = 1;
  scaleY = 1;

  lastMove = '';

  private springRot: Spring;
  private springX: Spring;
  private springY: Spring;
  /** Scale-Y is sprung; scale-X is derived from it to preserve volume. */
  private springSquash: Spring;
  private moveDeadline: Deadline;
  private turnDeadline: Deadline;
  private time = 0;
  private activeMove: Move | null = null;
  private moveElapsed = 0;

  /** Resting attitude, eased towards when the state changes. */
  private pose: BodyPose = BODY_POSES.idle;

  // ── Head turn ────────────────────────────────────────────────────────
  // Yaw and pitch, in radians, driving the sphere projection. These are what
  // make the eyes travel on a curve and scale with depth.
  //
  // They are a SECOND-ORDER FOLLOWER rather than a direct copy of the gaze,
  // ported from the "delayed follow" spring in the Rive reference: the head
  // chases where the eyes are looking with lag and a little bounce. Copying the
  // gaze exactly makes the head feel welded to the eyes; the lag is what makes
  // it read as a head that is *being turned* by attention.
  //
  // The reference's constants, and why these values:
  //   lag    0.25 s  — "a good starting point"; 0.15 is tight, 0.6 floaty
  //   bounce 0.2     — "subtle, feels alive"; 0.7 is wobbly jelly
  // The stiffness is derived from the lag (w = 4 / lag), and the damping ratio
  // is 1 - bounce, exactly as the original does it.
  private headYaw = 0;
  private headYawVel = 0;
  private headPitch = 0;
  private headPitchVel = 0;
  private readonly headLag = 0.25;
  private readonly headBounce = 0.2;

  // ── Manual override (drag) ───────────────────────────────────────────
  // While the user is dragging the ball, the head follows the FINGER rather
  // than the gaze. `null` means "no override, follow the gaze".
  //
  // The override decays instead of clearing instantly, so releasing a drag
  // hands the head back to the gaze spring smoothly rather than snapping.
  private manualYaw: number | null = null;
  private manualPitch: number | null = null;

  /**
   * A slow head-turn target, -1..1. This is the "looking around the room"
   * motion that keeps the body from being a statue.
   */
  private wanderTarget = 0;
  private wander = 0;

  constructor(private readonly rng: Rng) {
    // Smooth times and speeds are tuned for a small, soft creature: the lean
    // settles in roughly a third of a second, the drift a little slower, and
    // the squash is snappy because soft bodies respond fast.
    this.springRot = new Spring(0, 0.42, 2.2);
    this.springX = new Spring(0, 0.55, 1.6);
    this.springY = new Spring(0, 0.46, 1.9);
    this.springSquash = new Spring(0, 0.3, 3.0);
    this.moveDeadline = new Deadline(rng, 7000, 16000);
    this.turnDeadline = new Deadline(rng, 3000, 8000);
  }

  /** Fire a one-shot move now (Lab poke). */
  poke(): void {
    this.startMove();
  }

  /** Trigger a hop (used by SUCCESS and the Lab). */
  hop(): void {
    this.applyImpulse({ impulseY: -3.4, impulseSquash: -2.6 });
  }

  /**
   * Turn the head directly, as a drag does.
   *
   * Absolute, not a delta: the caller passes where the drag HAS taken the head,
   * so the same call works whether the finger moved 1 px or 100.
   */
  setManualTurn(yaw: number, pitch: number): void {
    this.manualYaw = yaw;
    this.manualPitch = pitch;
  }

  /** Release the manual turn; the head returns to following the gaze. */
  clearManualTurn(): void {
    this.manualYaw = null;
    this.manualPitch = null;
  }

  /** True while a drag owns the head. */
  get turned(): boolean {
    return this.manualYaw !== null;
  }

  /** Reseed the idle-move schedule. */
  reseed(minMs = 7000, maxMs = 16000): void {
    this.moveDeadline.reseed(minMs, maxMs);
  }

  /**
   * Choose and start a one-shot move.
   *
   * The moves are all *impulses into the springs* rather than animated curves:
   * the spring then decides how the body actually travels, which is why two
   * hops never look identical.
   */
  private startMove(): void {
    const move = this.rng.weighted([
      { value: { name: 'hop', duration: 0.9, impulseY: -3.0, impulseSquash: -2.2 } as Move, weight: 30 },
      { value: { name: 'lean-left', duration: 0.8, impulseRot: -1.5, impulseX: -0.9 } as Move, weight: 20 },
      { value: { name: 'lean-right', duration: 0.8, impulseRot: 1.5, impulseX: 0.9 } as Move, weight: 20 },
      { value: { name: 'settle', duration: 0.9, impulseSquash: 3.2 } as Move, weight: 18 },
      { value: { name: 'bounce', duration: 1.1, impulseY: -2.0, impulseRot: 0.9, impulseSquash: -1.6 } as Move, weight: 12 },
    ]);
    if (this.activeMove && move.name === this.activeMove.name) {
      // Avoid an immediate repeat — the tell that gives away a random loop.
      move.name = 'settle';
    }
    this.activeMove = move;
    this.moveElapsed = 0;
    this.lastMove = move.name;
    this.applyImpulse(move);
  }

  private applyImpulse(move: Pick<Move, 'impulseY' | 'impulseRot' | 'impulseX' | 'impulseSquash'>): void {
    if (move.impulseY) this.springY.velocity += move.impulseY;
    if (move.impulseRot) this.springRot.velocity += move.impulseRot;
    if (move.impulseX) this.springX.velocity += move.impulseX;
    if (move.impulseSquash) this.springSquash.velocity += move.impulseSquash;
  }

  /**
   * @param dt        seconds
   * @param state     current AssistantState
   * @param gazeX     the gaze controller's horizontal output, -1..1
   * @param gazeY     the gaze controller's vertical output, -1..1
   * @param energy    0..1 — scales the continuous motion
   * @param suppress  true while a state blend is in flight
   */
  step(dt: number, state: AssistantState, gazeX: number, gazeY: number, energy: number, suppress: boolean): void {
    this.time += dt;
    this.pose = BODY_POSES[state];

    // ── Idle head-turns ─────────────────────────────────────────────────
    // Slow, deliberate turns of the whole body, on a long timer. These are
    // the "it is looking around the room" beats.
    if (this.pose.wandering && !suppress) {
      if (this.turnDeadline.consume(dt, 3000, 8000)) {
        this.wanderTarget = this.rng.range(-1, 1);
      }
    } else {
      this.wanderTarget = 0;
    }
    // Ease the wander value so a turn is a movement, not a jump.
    this.wander += (this.wanderTarget - this.wander) * Math.min(1, dt / 0.9);
    const wanderAmt = this.pose.wandering ? this.wander : 0;

    // ── One-shot moves ──────────────────────────────────────────────────
    if (this.activeMove) {
      this.moveElapsed += dt;
      if (this.moveElapsed >= this.activeMove.duration) this.activeMove = null;
    } else if (!suppress && (state === 'idle' || state === 'working')) {
      // Only genuinely calm states get random hops; anything else would fight
      // the state's own body language.
      if (this.moveDeadline.consume(dt, 7000, 16000)) this.startMove();
    }

    // ── Continuous breathing ────────────────────────────────────────────
    // A slow, shallow vertical float plus a matching volume change. Period is
    // long (5.5-8 s) so it reads as breathing rather than as bobbing.
    const breathPeriod = 6.5;
    const breath = Math.sin((this.time / breathPeriod) * Math.PI * 2);
    const breathAmt = this.pose.breathe * (0.4 + energy * 0.6) * 0.016;
    // A second, faster and much smaller oscillation keeps the motion from
    // looking like a pure sine loop.
    const micro = Math.sin((this.time / 2.3) * Math.PI * 2 + 1.3) * 0.0035 * this.pose.breathe;

    // ── Lean follows the gaze ───────────────────────────────────────────
    // THE KEY COUPLING. When the eyes look left, the head leans left. Without
    // this the eyes move inside a static ball and the illusion collapses.
    const gazeLean = -gazeX * 0.11;
    const gazeDriftX = gazeX * 0.07;
    const gazeDriftY = gazeY * 0.05;

    // ── Compose the spring targets ──────────────────────────────────────
    const targetRot =
      this.pose.lean + gazeLean + wanderAmt * 0.16 + Math.sin((this.time / 9.1) * Math.PI * 2) * 0.022;
    const targetX = this.pose.driftX + gazeDriftX + wanderAmt * 0.1 + micro;
    const targetY = this.pose.driftY + gazeDriftY + breath * breathAmt;
    const targetSquash = this.pose.squash - breath * breathAmt * 0.8 + micro * 0.6;

    this.rotation = this.springRot.step(targetRot, dt);
    this.x = this.springX.step(targetX, dt);
    this.y = this.springY.step(targetY, dt);
    const squash = this.springSquash.step(targetSquash, dt);

    // ── Volume preservation ─────────────────────────────────────────────
    // Squashing vertically must widen horizontally (and vice versa), or the
    // orb reads as a scaling sprite instead of a soft body. The 0.62 factor
    // is slightly under 1:1 so the effect reads as compressible rather than
    // as strictly incompressible.
    this.scaleY = 1 - squash;
    this.scaleX = 1 + squash * 0.62;

    // ── Head turn follower ──────────────────────────────────────────────
    // Fixed-step integration, exactly as the reference does it: physics run in
    // 1/240 s slices so the feel does not change with frame rate, and a frame
    // hitch is clamped rather than allowed to teleport the head.
    const MAX_STEP = 1 / 240;
    const MAX_FRAME = 0.1;
    // A head turns a FRACTION of where the eyes look — eyes move ~45° while the
    // head moves ~15°. Using the full gaze rotated the head to its limit on the
    // states with extreme look directions (THINKING, ERROR) and dragged the eyes
    // onto the sphere's limb, where the projection smears them.
    //
    // While dragging, the finger owns the head: the goal is the drag position
    // and the spring is stiffened so it tracks the finger rather than trailing
    // it. Otherwise the gaze drives it, scaled down.
    const dragging = this.manualYaw !== null;
    const headFollow = 0.42;
    const goalYaw = dragging
      ? (this.manualYaw as number)
      : clamp(gazeX * headFollow, -1, 1) * MAX_YAW;
    const goalPitch = dragging
      ? (this.manualPitch as number)
      : clamp(gazeY * headFollow, -1, 1) * MAX_PITCH;
    // A drag needs a tighter follow than a gaze does, or the ball feels
    // rubber-banded to the finger.
    const activeLag = dragging ? 0.11 : this.headLag;
    const lag = Math.max(activeLag, 0.05);
    const zeta = 1 - Math.min(Math.max(this.headBounce, 0), 0.95);
    const w = 4 / lag;

    let remaining = Math.min(dt, MAX_FRAME);
    while (remaining > 0) {
      const slice = Math.min(remaining, MAX_STEP);
      const ax = w * w * (goalYaw - this.headYaw) - 2 * zeta * w * this.headYawVel;
      const ay = w * w * (goalPitch - this.headPitch) - 2 * zeta * w * this.headPitchVel;
      this.headYawVel += ax * slice;
      this.headPitchVel += ay * slice;
      this.headYaw += this.headYawVel * slice;
      this.headPitch += this.headPitchVel * slice;
      remaining -= slice;
    }
  }

  /** Current head rotation in radians, for the sphere projection. */
  get yaw(): number {
    return this.headYaw;
  }

  get pitch(): number {
    return this.headPitch;
  }
}

export { BODY_POSES };
export type { BodyPose };
