/**
 * easing.ts — the easing vocabulary.
 *
 * KK carries a hand-written easing table because a 240 MHz MCU cannot afford
 * a generic bezier solver per frame. We mirror that idea: named, closed-form
 * functions only, no cubic-bezier evaluation, no allocation.
 *
 * Every function maps [0,1] -> [0,1] (except the `back`/`elastic` families,
 * which intentionally overshoot) and is exactly 0 at 0 and 1 at 1.
 *
 * Porting note: all of these are `sinf`/`powf`/arithmetic — trivial in C++.
 */

export interface Easing {
  (t: number): number;
}

const c1 = 1.70158;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;
const c5 = (2 * Math.PI) / 4.5;

function bounceOut(t: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}

/**
 * The table. Names are the ones used in `Track` keyframes and state specs, so
 * a C++ port only needs to implement the subset actually referenced.
 */
export const EASINGS = {
  linear: (t: number) => t,

  // ── Quadratic ─────────────────────────────────────────────────────────
  quadIn: (t: number) => t * t,
  quadOut: (t: number) => 1 - (1 - t) * (1 - t),
  quadInOut: (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),

  // ── Cubic ─────────────────────────────────────────────────────────────
  cubicIn: (t: number) => t * t * t,
  cubicOut: (t: number) => 1 - Math.pow(1 - t, 3),
  cubicInOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),

  // ── Quartic / quintic — used for snappy state entries ─────────────────
  quartOut: (t: number) => 1 - Math.pow(1 - t, 4),
  quintOut: (t: number) => 1 - Math.pow(1 - t, 5),
  quintInOut: (t: number) => (t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2),

  // ── Sine — the "breathing" family, our most-used easing ───────────────
  sineIn: (t: number) => 1 - Math.cos((t * Math.PI) / 2),
  sineOut: (t: number) => Math.sin((t * Math.PI) / 2),
  sineInOut: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,

  // ── Exponential ───────────────────────────────────────────────────────
  expoOut: (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  expoInOut: (t: number) =>
    t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,

  // ── Overshooting families — SUCCESS / APPROVAL "pop" ──────────────────
  backOut: (t: number) => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2),
  backInOut: (t: number) =>
    t < 0.5
      ? (Math.pow(2 * t, 2) * ((c2() + 1) * 2 * t - c2())) / 2
      : (Math.pow(2 * t - 2, 2) * ((c2() + 1) * (t * 2 - 2) + c2()) + 2) / 2,
  elasticOut: (t: number) =>
    t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1,
  bounceOut,

  // ── Smoothstep — the "soft, premium" default for organic motion ───────
  smoothstep: (t: number) => t * t * (3 - 2 * t),
  smootherstep: (t: number) => t * t * t * (t * (t * 6 - 15) + 10),
} satisfies Record<string, Easing>;

// `backInOut` needs a slightly larger constant than `backOut`; kept in a
// function so the table above reads as pure one-liners.
function c2(): number {
  return 1.70158 * 1.525;
}

export type EasingName = keyof typeof EASINGS;

export const EASING_NAMES = Object.keys(EASINGS) as EasingName[];

export function ease(name: EasingName, t: number): number {
  return EASINGS[name](t);
}

/** Clamp helper shared by every easing-driven blend. */
export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export { c5 };
