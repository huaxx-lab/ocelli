/**
 * timeline.ts — timing primitives.
 *
 * KK drives everything from keyframe tracks with explicit easing; AURA drives
 * everything from polled deadlines against `millis()`. We need both, so this
 * module provides:
 *
 *   - `Easing`       — KK-style named easing functions (see easing.ts)
 *   - `Track`        — a keyframed scalar track (KK's keyframe tables)
 *   - `Clock`        — a drift-free frame clock
 *   - `Deadline`     — AURA-style "fire when now >= next" scheduling
 *   - `Rng`          — a seedable PRNG so behaviour is reproducible in tests
 *
 * No `Date.now()` and no `performance.now()` inside the logic: the clock is
 * always injected. That keeps the whole module deterministic and portable.
 */

import { Easing, EASINGS, type EasingName } from './easing';

/** A keyframe on a scalar track. `t` is in seconds from the track start. */
export interface Keyframe {
  t: number;
  value: number;
  /** Easing used to approach this keyframe from the previous one. */
  ease?: EasingName;
}

/**
 * A scalar animation track — KK's keyframe table reduced to the one
 * primitive we actually need. Tracks are immutable once built and are
 * evaluated by pure function, so multiple avatars can share one track.
 */
export class Track {
  readonly keyframes: readonly Keyframe[];
  readonly duration: number;

  constructor(keyframes: readonly Keyframe[]) {
    if (keyframes.length === 0) throw new Error('Track requires at least one keyframe');
    this.keyframes = [...keyframes].sort((a, b) => a.t - b.t);
    this.duration = this.keyframes[this.keyframes.length - 1]!.t;
  }

  /** Sample the track at time `t` (seconds, clamped to the track range). */
  at(t: number): number {
    const frames = this.keyframes;
    if (t <= frames[0]!.t) return frames[0]!.value;
    const last = frames[frames.length - 1]!;
    if (t >= last.t) return last.value;

    for (let i = 1; i < frames.length; i++) {
      const b = frames[i]!;
      if (t <= b.t) {
        const a = frames[i - 1]!;
        const span = b.t - a.t;
        const raw = span <= 0 ? 1 : (t - a.t) / span;
        const ease = EASINGS[b.ease ?? 'linear'];
        return a.value + (b.value - a.value) * ease(raw);
      }
    }
    return last.value;
  }

  /** 0..1 progress through the track at time `t`. */
  progress(t: number): number {
    if (this.duration <= 0) return 1;
    const p = t / this.duration;
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }
}

/**
 * A drift-free frame clock.
 *
 * KK's renderer ticks on a fixed cadence and advances time by a constant;
 * AURA polls `millis()` and compares deadlines. The Web needs the second
 * approach (rAF timestamps) but must stay stable across tab-switches, so we
 * clamp the step and keep our own accumulated time.
 */
export class Clock {
  private lastMs = 0;
  private started = false;

  /** Seconds accumulated since construction. */
  time = 0;
  /** Last frame's delta in seconds, already clamped. */
  dt = 0;
  /** Frames rendered in the last second; exposed for the Lab's FPS readout. */
  fps = 0;

  private fpsAccum = 0;
  private fpsFrames = 0;

  /**
   * @param maxStep - Largest delta we will believe, in seconds. A backgrounded
   *   tab returns one huge timestamp; without this clamp every spring would
   *   explode on the first frame back.
   */
  constructor(private readonly maxStep = 1 / 15) {}

  /** Advance from a monotonic millisecond timestamp (rAF's own argument). */
  tick(nowMs: number): this {
    if (!this.started) {
      this.started = true;
      this.lastMs = nowMs;
      this.dt = 0;
      return this;
    }
    const raw = (nowMs - this.lastMs) / 1000;
    this.lastMs = nowMs;
    this.dt = raw < 0 ? 0 : raw > this.maxStep ? this.maxStep : raw;
    this.time += this.dt;

    this.fpsAccum += this.dt;
    this.fpsFrames += 1;
    if (this.fpsAccum >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
    return this;
  }

  /** Forget the accumulated step so the next tick restarts cleanly. */
  reset(): void {
    this.started = false;
    this.dt = 0;
  }
}

/**
 * AURA's scheduling primitive: hold a "next" timestamp, fire when passed.
 * Used for blink / gaze / micro-reaction intervals.
 */
export class Deadline {
  private next: number;

  constructor(private readonly rng: Rng, minMs: number, maxMs: number) {
    this.next = rng.range(minMs, maxMs);
  }

  /** Reseed the interval, in milliseconds. */
  reseed(minMs: number, maxMs: number): void {
    this.next = this.rng.range(minMs, maxMs);
  }

  /** Force the next firing to `ms` from now. */
  scheduleIn(ms: number): void {
    this.next = ms;
  }

  /**
   * Advance by `dtSeconds`; returns true exactly once per scheduling period.
   * The deadline is *pushed forward* rather than reset to zero, so a slow
   * frame does not silently skip a beat.
   */
  consume(dtSeconds: number, minMs: number, maxMs: number): boolean {
    this.next -= dtSeconds * 1000;
    if (this.next > 0) return false;
    this.reseed(minMs, maxMs);
    return true;
  }
}

/**
 * Deterministic PRNG (mulberry32). AURA uses `esp_random()`; KK uses nothing.
 * We want reproducibility for the Lab's "restart the same demo" affordance,
 * so every random decision in the engine draws from an injected Rng.
 */
export class Rng {
  private state: number;

  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0;
  }

  /** Uniform 0..1. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Pick an entry from a weighted table (weights need not sum to 1). */
  weighted<T>(entries: readonly { value: T; weight: number }[]): T {
    let total = 0;
    for (const e of entries) total += e.weight;
    let roll = this.next() * total;
    for (const e of entries) {
      roll -= e.weight;
      if (roll <= 0) return e.value;
    }
    return entries[entries.length - 1]!.value;
  }

  /** Reseed, so a demo run can be replayed exactly. */
  reset(seed: number): void {
    this.state = seed >>> 0;
  }
}

/** Convenience: build a Track from `[time, value, ease?]` tuples. */
export function track(...frames: [number, number, EasingName?][]): Track {
  return new Track(frames.map(([t, value, ease]) => ({ t, value, ease })));
}

export type { Easing };
export type { EasingName };
