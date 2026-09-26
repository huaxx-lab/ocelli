/**
 * transitions.ts — how a pose gets from A to B.
 *
 * KK blends between expressions by crossfading keyframe output over a fixed
 * duration with a named easing. Grok's orb interpolates expression parameter
 * sets. AURA hard-cuts. We take KK's crossfade as the default and add a
 * critically-damped spring for anything driven by continuous input (gaze,
 * audio), because a spring is the only thing that gives the eyes *inertia*
 * without a fixed settle time.
 *
 * Two mechanisms, one contract:
 *
 *   PoseBlender<T>  — eased crossfade between two named targets over a duration
 *   Spring          — critically-damped second-order follower for live input
 *
 * Both are pure and step-driven (`step(dt)`), never time-source-driven, so the
 * whole file transliterates to C++.
 */

import { EASINGS, type EasingName } from './easing';
import { lerpPose, type AvatarPose } from './params';

/**
 * A critically-damped spring follower.
 *
 * Used for the gaze channel: the Lab feeds it a mouse position and the eyes
 * inherit mass, so they arrive *after* the pointer rather than glued to it.
 * `smoothTime` is the approximate time to reach the target, which is a far
 * more designer-friendly knob than raw stiffness/damping.
 *
 * The integrator is the semi-implicit "SmoothDamp" form: unconditionally
 * stable for any dt, which matters because rAF dt is not fixed.
 */
export class Spring {
  value: number;
  velocity = 0;

  constructor(
    initial = 0,
    /** Seconds to converge. Lower = snappier. */
    public smoothTime = 0.18,
    /** Hard cap on speed; 0 disables the cap. */
    public maxSpeed = 0,
  ) {
    this.value = initial;
  }

  /** Jump straight to a value, killing momentum (used on state resets). */
  set(value: number): void {
    this.value = value;
    this.velocity = 0;
  }

  step(target: number, dt: number): number {
    return this.stepWith(target, dt, this.smoothTime, this.maxSpeed);
  }

  /** Step with per-call parameters, for channels needing a temporary retune. */
  stepWith(target: number, dt: number, smoothTime: number, maxSpeed: number): number {
    if (dt <= 0) return this.value;
    // Guard against a zero smoothTime turning the spring into a hard snap.
    const time = smoothTime < 1e-4 ? 1e-4 : smoothTime;
    const omega = 2 / time;
    const x = omega * dt;
    // Rational approximation of exp(-x); avoids Math.exp in the hot path and
    // matches the reference SmoothDamp implementation exactly.
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

    let change = this.value - target;
    if (maxSpeed > 0) {
      const maxChange = maxSpeed * time;
      change = change < -maxChange ? -maxChange : change > maxChange ? maxChange : change;
    }
    const temp = (this.velocity + omega * change) * dt;
    this.velocity = (this.velocity - omega * temp) * exp;
    this.value = target + (change + temp) * exp;
    return this.value;
  }
}

/**
 * A single transition's live state.
 *
 * A pose blend is defined by (from, to, duration, easing). Once `elapsed`
 * reaches `duration` the transition reports `done` and the caller promotes
 * `to` to be the new stable pose.
 */
export interface BlendSpec {
  duration: number;
  easing: EasingName;
}

/**
 * Crossfades between two poses with an eased parameter-wise interpolation.
 *
 * Deliberately NOT a spring: a crossfade has a known duration, which is what
 * makes state changes feel *authored* rather than merely physical.
 */
export class PoseBlender {
  private from: AvatarPose;
  private to: AvatarPose;
  private elapsed: number;
  private spec: BlendSpec;

  constructor(initial: AvatarPose, spec: BlendSpec = { duration: 0.45, easing: 'sineInOut' }) {
    this.from = { ...initial };
    this.to = { ...initial };
    this.elapsed = spec.duration;
    this.spec = spec;
  }

  /** True once the blend has settled on `to`. */
  get done(): boolean {
    return this.elapsed >= this.spec.duration;
  }

  /** 0..1 raw progress of the current blend. */
  get progress(): number {
    if (this.spec.duration <= 0) return 1;
    const p = this.elapsed / this.spec.duration;
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }

  /** The pose the blender is heading towards. */
  get target(): AvatarPose {
    return this.to;
  }

  /**
   * Retarget. If the target is unchanged the running blend is left alone, so
   * a per-frame `setTarget` call is free — important because the state
   * resolver runs every frame.
   *
   * When retargeting mid-blend we snapshot the *current* interpolated pose as
   * the new `from`. That is what keeps rapid state switching smooth instead of
   * snapping back to the previous keyframe (a classic crossfade bug).
   */
  setTarget(next: AvatarPose, spec?: BlendSpec): void {
    if (spec) this.spec = spec;
    if (samePose(this.to, next)) return;
    if (!this.done) {
      this.from = this.value();
      this.elapsed = 0;
    } else {
      this.from = { ...this.to };
      this.elapsed = 0;
    }
    this.to = { ...next };
  }

  /** Retarget immediately with no blend (used for hard resets). */
  snap(next: AvatarPose): void {
    this.from = { ...next };
    this.to = { ...next };
    this.elapsed = this.spec.duration;
  }

  step(dt: number): AvatarPose {
    if (!this.done) this.elapsed = Math.min(this.spec.duration, this.elapsed + dt);
    return this.value();
  }

  /** Sample the current blended pose without advancing time. */
  value(): AvatarPose {
    if (this.done) return { ...this.to };
    if (this.spec.duration <= 0) return { ...this.to };
    const eased = EASINGS[this.spec.easing](this.progress);
    return lerpPose(this.from, this.to, eased);
  }
}

/**
 * Eased scalar ramp with a hold, used for one-shot reactions (a blink's
 * closing phase, WORKING's progress ring, ERROR's instability burst).
 *
 * Modelled on KK's keyframe idea but specialised: `attack` -> `hold` ->
 * `release`, each with its own easing. This one shape covers almost every
 * transient the avatar needs.
 */
export class Pulse {
  private elapsed = 0;
  private active = false;

  constructor(
    public attack = 0.1,
    public hold = 0.2,
    public release = 0.3,
    public attackEase: EasingName = 'sineOut',
    public releaseEase: EasingName = 'sineInOut',
    /** Peak value; the pulse ramps 0 -> peak -> 0. */
    public peak = 1,
  ) {}

  get running(): boolean {
    return this.active;
  }

  /** Total length of one pulse, in seconds. */
  get duration(): number {
    return this.attack + this.hold + this.release;
  }

  fire(): void {
    this.elapsed = 0;
    this.active = true;
  }

  cancel(): void {
    this.active = false;
    this.elapsed = 0;
  }

  /** Current 0..peak value. */
  step(dt: number): number {
    if (!this.active) return 0;
    this.elapsed += dt;
    if (this.elapsed >= this.duration) {
      this.active = false;
      return 0;
    }
    const t = this.elapsed;
    if (t < this.attack) {
      return this.peak * EASINGS[this.attackEase](t / this.attack);
    }
    if (t < this.attack + this.hold) {
      return this.peak;
    }
    const r = (t - this.attack - this.hold) / this.release;
    return this.peak * (1 - EASINGS[this.releaseEase](r));
  }
}

/**
 * A one-pole exponential follower with AURA's asymmetric attack/release.
 *
 * This is the single most important "aliveness" primitive in the engine: fast
 * in, slow out is what separates a living response from a twitchy one. AURA
 * uses 0.55/0.18 for the mouth and 0.58/0.14 for the VU meter.
 */
export class Envelope {
  value = 0;

  constructor(
    public attack = 0.55,
    public release = 0.18,
  ) {}

  set(value: number): void {
    this.value = value;
  }

  step(target: number, dt: number, rateScale = 1): number {
    if (dt <= 0) return this.value;
    // The raw coefficients are per-poll constants tuned to a 70-80 ms poll;
    // converting them to a frame-rate-independent form keeps the feel
    // identical whether the renderer runs at 60, 90 or 120 Hz.
    const reference = 1 / 14; // AURA's 70 ms mouth poll
    const alpha = target > this.value ? this.attack : this.release;
    const scaled = 1 - Math.pow(1 - alpha, (dt / reference) * rateScale);
    this.value += (target - this.value) * scaled;
    return this.value;
  }
}

/** Exact pose equality — used to make `setTarget` idempotent. */
export function samePose(a: AvatarPose, b: AvatarPose): boolean {
  for (const key of Object.keys(a) as (keyof AvatarPose)[]) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
