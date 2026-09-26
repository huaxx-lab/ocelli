/**
 * gestures.ts — GestureController.
 *
 * A GESTURE is something the avatar *does*; a STATE is something the avatar
 * *is*. Keeping them separate is what stops the state machine from growing a
 * case for every new trick — and it means a gesture can play over any state
 * (a wink while listening, a sneeze while idle) without touching `states.ts`.
 *
 *   AssistantState   idle · listening · thinking · …      (where it lives)
 *   Gesture          wink · nod · laugh · sing · zzz · …   (what it does)
 *
 * Gestures are ADDITIVE deltas applied after the state pose has been blended,
 * exactly like the body springs and the gaze. A one-shot gesture runs its own
 * envelope and expires; a sustained one loops until stopped.
 *
 * ── Why every gesture has the same shape ──────────────────────────────────
 * Each gesture is a function of normalised progress `p` (0..1) returning pose
 * deltas. That single contract means the controller has no per-gesture
 * branching, a C++ port is a table of small functions, and adding a gesture
 * cannot break the others.
 */

import type { AvatarPose } from '../core/params';
import type { Rng } from '../core/timeline';

export const GESTURE_KINDS = [
  'wink',
  'nod',
  'shake',
  'laugh',
  'peek',
  'dizzy',
  'sneeze',
  'heart',
  'sing',
  'zzz',
] as const;

export type GestureKind = (typeof GESTURE_KINDS)[number];

/**
 * What a gesture contributes each frame.
 *
 * Two channels, and the distinction matters:
 *
 *   `pose`  ADDITIVE deltas. Right for motion — a nod displaces the head,
 *           a glance offsets the eyes. These compose with the state.
 *   `set`   ABSOLUTE overrides, blended in by `setWeight`. Right for SHAPE —
 *           "a laugh squints the eyes" is not "add 0.3 of squint to whatever
 *           the state had", it is "the eyes ARE squinted right now".
 *
 * The first implementation had only `pose`, which is why LAUGH, HEART and PEEK
 * all rendered with round eyes: +0.3 added to IDLE's -0.55 baseline still
 * landed at -0.25, i.e. nearly round. Expression gestures need to override.
 */
export interface GestureOutput {
  /** Additive pose deltas. */
  pose: Partial<AvatarPose>;
  /** Absolute pose values this gesture imposes, blended by `setWeight`. */
  set?: Partial<AvatarPose>;
  /** 0..1 how strongly `set` is applied. */
  setWeight?: number;
  /**
   * 0..1 strength of the floating "Z" sleep glyphs. Owned by `zzz`, ignored by
   * every other gesture; the renderer draws the glyphs.
   */
  zzz: number;
}

const EMPTY: GestureOutput = { pose: {}, zzz: 0 };

interface GestureSpec {
  /** Seconds. `Infinity` for a sustained gesture that loops until stopped. */
  duration: number;
  /** Whether this gesture is sustained (loops) rather than one-shot. */
  sustained: boolean;
  /** Map normalised progress to deltas. `t` is elapsed seconds. */
  sample: (p: number, t: number, rng: Rng, side: -1 | 1) => GestureOutput;
}

// ── Envelope helpers ───────────────────────────────────────────────────────

/** 0 → 1 → 0 with smooth shoulders. */
function bump(p: number, peak = 0.35): number {
  if (p < peak) {
    const k = p / peak;
    return k * k * (3 - 2 * k);
  }
  const k = (p - peak) / (1 - peak);
  const s = 1 - k;
  return s * s * (3 - 2 * s);
}

/**
 * The gesture table.
 *
 * Amplitudes are deliberately modest. A gesture is an accent on top of the
 * state, not a replacement for it; a nod that throws the whole face off the
 * sphere stops reading as a nod.
 */
const GESTURES: Record<GestureKind, GestureSpec> = {
  // ── WINK ────────────────────────────────────────────────────────────────
  // One capsule closes and reopens. Fast shut, slower open with a small
  // overshoot, because that is what an eyelid does.
  //
  // Additive on `eyeOpen`: the state supplies the open value and the gesture
  // contributes the difference, so the channel is never driven past 1.
  wink: {
    duration: 0.46,
    sustained: false,
    sample: (p, _t, _rng, side) => {
      let open: number;
      if (p < 0.28) open = 1 - p / 0.28;
      else if (p < 0.42) open = 0;
      else {
        const k = (p - 0.42) / 0.58;
        open = k * k * (3 - 2 * k) * 1.06;
      }
      open = Math.max(0, Math.min(1, open));
      const delta = open - 1;
      return {
        pose: side < 0 ? { eyeOpenL: delta } : { eyeOpenR: delta },
        zzz: 0,
      };
    },
  },

  // ── NOD ─────────────────────────────────────────────────────────────────
  // Agreement. The head dips and the eyes travel with it. The eyes narrow very
  // slightly — a nod is not a neutral movement, it is an affirmative one.
  nod: {
    duration: 0.72,
    sustained: false,
    sample: (p) => {
      const b = bump(p, 0.3);
      return {
        pose: {
          bodyY: b * 0.075,
          bodyRotation: b * 0.045,
          eyeOffsetY: b * 0.16,
          eyeRound: b * 0.2,
        },
        zzz: 0,
      };
    },
  },

  // ── SHAKE ───────────────────────────────────────────────────────────────
  // Disagreement. Two and a half cycles of head rotation, with the eyes lagging
  // opposite — which is what makes it read as a deliberate "no" rather than a
  // wobble. The eyes NARROW throughout: disagreement is a narrowed expression,
  // never a wide-eyed one.
  shake: {
    duration: 0.86,
    sustained: false,
    sample: (p) => {
      const env = bump(p, 0.16);
      const s = Math.sin(p * Math.PI * 2 * 2.5);
      return {
        pose: {
          bodyRotation: s * env * 0.11,
          bodyX: s * env * 0.05,
          eyeOffsetX: -s * env * 0.2,
        },
        // Disagreement: narrowed AND downturned. A wide-eyed shake would read
        // as surprise, not refusal.
        set: { eyeRound: 0.55, eyeBowL: -0.6, eyeBowR: -0.6 },
        setWeight: env,
        zzz: 0,
      };
    },
  },

  // ── LAUGH ───────────────────────────────────────────────────────────────
  // THE HAPPY CRESCENT. Eyes squeeze into wide flat shapes — this is an
  // override, not a nudge, because laughter genuinely changes the shape of the
  // eye rather than adding to it. The bounce modulates on top of the squint.
  laugh: {
    duration: 1.5,
    sustained: false,
    sample: (p, t) => {
      const env = bump(p, 0.18);
      const beat = Math.sin(t * Math.PI * 2 * 4.2);
      const bounce = Math.abs(beat);
      return {
        pose: {
          eyeRound: bounce * 0.18 * env,
          eyeSize: bounce * 0.07 * env,
          eyeLiftL: bounce * 0.015 * env,
          eyeLiftR: bounce * 0.015 * env,
          bodyY: -bounce * 0.05 * env,
          bodyScaleY: bounce * 0.035 * env,
          bodyScaleX: -bounce * 0.02 * env,
        },
        // THE GRIN. Laughter's defining feature is not the bounce, it is the
        // eye becoming an upward arc (^ ^). The bounce only adds motion on top.
        set: { eyeRound: 0.95, eyeSize: 0.95, eyeBowL: 1.0, eyeBowR: 1.0 },
        setWeight: env * 0.92,
        zzz: 0,
      };
    },
  },

  // ── PEEK ────────────────────────────────────────────────────────────────
  // A quick glance aside and back. The eyes NARROW as they go — that slight
  // squint is what turns "eyes slid sideways" into "checking something".
  peek: {
    duration: 1.05,
    sustained: false,
    sample: (p, _t, _rng, side) => {
      let amt: number;
      if (p < 0.22) amt = p / 0.22;
      else if (p < 0.62) amt = 1;
      else amt = 1 - (p - 0.62) / 0.38;
      const a = Math.max(0, Math.min(1, amt));
      return {
        pose: {
          eyeOffsetX: a * 0.6 * side,
          eyeOffsetY: -a * 0.1,
          bodyRotation: -a * 0.045 * side,
          bodyX: a * 0.02 * side,
        },
        // Peering: flattened for focus, with the faintest downward bow —
        // inspection, not delight.
        set: { eyeRound: 0.3, eyeBowL: -0.1, eyeBowR: -0.1 },
        setWeight: a,
        zzz: 0,
      };
    },
  },

  // ── DIZZY ───────────────────────────────────────────────────────────────
  // The two capsules rotate in OPPOSITE directions and swap shapes, which is
  // instantly legible as "spinning" with no swirl graphics at all. The body
  // follows loosely.
  dizzy: {
    duration: 1.9,
    sustained: false,
    sample: (p, t) => {
      const env = bump(p, 0.2);
      const spin = t * Math.PI * 2 * 1.7;
      return {
        pose: {
          eyeTiltL: Math.sin(spin) * 0.5 * env,
          eyeTiltR: Math.sin(spin + Math.PI * 0.6) * 0.5 * env,
          bodyRotation: Math.sin(spin * 0.5) * 0.07 * env,
          bodyX: Math.cos(spin * 0.5) * 0.035 * env,
        },
        set: {
          eyeRoundL: Math.sin(spin * 1.3) * 0.75,
          eyeRoundR: -Math.sin(spin * 1.3) * 0.75,
          eyeSize: 0.95,
        },
        setWeight: env,
        zzz: 0,
      };
    },
  },

  // ── SNEEZE ──────────────────────────────────────────────────────────────
  // Wind-up: the eyes CLAMP SHUT and the body compresses. Release: they pop
  // wide open as the body snaps upward. The shut phase is what sells it — a
  // sneeze with open eyes is just a twitch.
  sneeze: {
    duration: 1.0,
    sustained: false,
    sample: (p) => {
      if (p < 0.4) {
        const k = p / 0.4;
        const e = k * k;
        return {
          pose: {
            bodyScaleY: -e * 0.09,
            bodyScaleX: e * 0.05,
            bodyY: e * 0.05,
            eyeOpen: -e,
            browOpen: e,
            browTiltL: e * 0.3,
            browTiltR: e * 0.3,
          },
          // Squeezed shut AND flattened AND downturned: a sneeze screws the
          // whole face up rather than merely closing it.
          set: { eyeRound: 0.85, eyeBowL: -0.75, eyeBowR: -0.75 },
          setWeight: e,
          zzz: 0,
        };
      }
      const k = (p - 0.4) / 0.6;
      const pop = Math.exp(-k * 5) * Math.cos(k * 11);
      return {
        pose: {
          bodyScaleY: pop * 0.075,
          bodyScaleX: -pop * 0.045,
          bodyY: -pop * 0.05,
          eyeOpen: Math.min(0, -0.75 + k * 3),
          eyeSize: Math.abs(pop) * 0.14,
        },
        // Then they snap WIDE: the opposite extreme is the punchline.
        set: { eyeRound: -0.85 },
        setWeight: Math.max(0, 1 - k * 2.2),
        zzz: 0,
      };
    },
  },

  // ── HEART ───────────────────────────────────────────────────────────────
  // Affection. The capsules soften into WIDE, LOW arcs and drift up — the fond
  // shape. No hearts are drawn; the warmth is entirely in the eye geometry and
  // the slight inward tilt.
  heart: {
    duration: 1.8,
    sustained: false,
    sample: (p, t) => {
      const env = bump(p, 0.3);
      const swell = 1 + Math.sin(t * Math.PI * 2 * 1.4) * 0.14;
      return {
        pose: {
          eyeSize: 0.06 * env * swell,
          eyeLiftL: 0.055 * env,
          eyeLiftR: 0.055 * env,
          eyeTiltL: -0.12 * env,
          eyeTiltR: 0.12 * env,
          bodyY: -0.045 * env,
          bodyScaleY: 0.02 * env,
        },
        // Fondness is the same upward arc as laughter, but shallower and held
        // longer — the difference between "haha" and "aww".
        set: { eyeRound: 0.8, eyeBowL: 0.75, eyeBowR: 0.75, eyeSize: 0.98 },
        setWeight: env,
        zzz: 0,
      };
    },
  },

  // ── SING ────────────────────────────────────────────────────────────────
  // SUSTAINED. The two capsules bounce alternately, like notes being sung —
  // one rises while the other falls. The alternation is the entire idea; if
  // both moved together it would just be a pulse.
  //
  // Deliberately additive rather than an override: singing should ride on top
  // of whatever the avatar is already expressing.
  sing: {
    duration: Infinity,
    sustained: true,
    sample: (_p, t) => {
      const beat = t * Math.PI * 2 * 1.9;
      const a = Math.sin(beat);
      const b = Math.sin(beat + Math.PI);
      const phrase = 1 + Math.sin(t * Math.PI * 2 * 0.42) * 0.3;
      return {
        pose: {
          // A gentle, sustained upward bow: singing is buoyant.
          eyeBowL: 0.25 * phrase,
          eyeBowR: 0.25 * phrase,
          eyeRound: a * 0.14 * phrase,
          eyeRoundL: (a - b) * 0.16 * phrase,
          eyeRoundR: (b - a) * 0.16 * phrase,
          eyeSizeL: a * 0.05 * phrase,
          eyeSizeR: b * 0.05 * phrase,
          eyeLiftL: a * 0.03 * phrase,
          eyeLiftR: b * 0.03 * phrase,
          eyeTiltL: b * 0.06 * phrase,
          eyeTiltR: a * 0.06 * phrase,
          bodyY: -Math.abs(a) * 0.03 * phrase,
          bodyRotation: b * 0.03 * phrase,
        },
        zzz: 0,
      };
    },
  },

  // ── ZZZ ─────────────────────────────────────────────────────────────────
  // SUSTAINED. Dozing off.
  //
  // THE EYES MUST BE CLOSED. An earlier version emitted only the glyph
  // intensity and left the eyes wide open, so "Zzz" looked like a wide-awake
  // avatar with letters floating past its head — the exact opposite of dozing.
  // A doze is heavy-lidded: nearly shut, and flat.
  //
  // The gesture only publishes the glyph *intensity*; the renderer draws the
  // letters, because typography is a rendering concern.
  zzz: {
    duration: Infinity,
    sustained: true,
    sample: (_p, t) => {
      const cycle = 4.4;
      const local = (t % cycle) / cycle;
      let env: number;
      if (local < 0.2) env = local / 0.2;
      else if (local < 0.72) env = 1;
      else env = 1 - (local - 0.72) / 0.28;
      const e = Math.max(0, Math.min(1, env));
      // A slow "heavy lid" breath: the eyes sink a little further and lift a
      // fraction, so a dozing face still moves rather than looking switched off.
      const breath = Math.sin(t * Math.PI * 2 * 0.28);
      return {
        pose: {
          bodyY: 0.03 * e,
          bodyRotation: 0.03 * e,
        },
        set: {
          eyeOpen: 0.08 + breath * 0.03,
          eyeRound: 0.45,
          eyeSize: 0.94,
          // Closed lids relax DOWNWARD. A doze with level eyes looks like a
          // stare; the slight sag is what makes it read as heavy-lidded.
          eyeBowL: -0.3,
          eyeBowR: -0.3,
          eyeLiftL: -0.05,
          eyeLiftR: -0.05,
        },
        setWeight: e,
        zzz: e,
      };
    },
  },
};

/**
 * Play one gesture at a time.
 *
 * A single slot rather than a list: two simultaneous gestures fight over the
 * same channels (both `nod` and `laugh` want `bodyY`), and the result is noise
 * rather than richness. The most recent request simply wins.
 */
export class GestureController {
  /** The gesture currently playing, if any. */
  current: GestureKind | null = null;
  /** Published every step for the renderer and the Lab. */
  output: GestureOutput = { pose: {}, zzz: 0 };

  private elapsed = 0;
  private spec: GestureSpec | null = null;
  private side: -1 | 1 = -1;

  /** Names of the gestures that have run, most recent first (Lab readout). */
  readonly history: GestureKind[] = [];

  constructor(private readonly rng: Rng) {}

  /**
   * Start a gesture.
   *
   * @param kind - which gesture
   * @param side - for lateral gestures (wink/peek), which way. Defaults to a
   *   random side so a repeated wink is not always the same eye.
   */
  play(kind: GestureKind, side?: -1 | 1): void {
    this.spec = GESTURES[kind];
    this.current = kind;
    this.elapsed = 0;
    this.side = side ?? (this.rng.chance(0.5) ? -1 : 1);
    this.history.unshift(kind);
    if (this.history.length > 8) this.history.pop();
  }

  /** Stop the current gesture immediately. */
  stop(): void {
    this.current = null;
    this.spec = null;
    this.output = { pose: {}, zzz: 0 };
  }

  /** True while a gesture is playing. */
  get active(): boolean {
    return this.current !== null;
  }

  /** True if the current gesture is the sustained `zzz`. */
  get sleeping(): boolean {
    return this.current === 'zzz';
  }

  /**
   * Advance the controller.
   *
   * @param dt seconds
   * @param stateBlendDone true once the state crossfade has settled. One-shot
   *   gestures are suppressed while a state move is in flight, because a wink
   *   during a transition reads as a glitch.
   */
  step(dt: number, stateBlendDone = true): GestureOutput {
    if (!this.spec || !this.current) {
      this.output = EMPTY;
      return this.output;
    }

    this.elapsed += dt;
    const spec = this.spec;

    // A one-shot gesture started mid-transition is held at its first frame
    // until the move settles, rather than being cancelled outright.
    if (!spec.sustained && !stateBlendDone) {
      this.output = spec.sample(0, 0, this.rng, this.side);
      return this.output;
    }

    if (!spec.sustained && this.elapsed >= spec.duration) {
      this.stop();
      return this.output;
    }

    const p = spec.sustained ? 0 : this.elapsed / spec.duration;
    const sampled = spec.sample(p, this.elapsed, this.rng, this.side);
    // Copy ALL channels. An earlier version rebuilt the object as
    // `{ pose, zzz }`, which silently dropped `set`/`setWeight` and meant no
    // gesture could ever change the eyes' SHAPE — only nudge them.
    this.output = sampled;
    return this.output;
  }

  /** The gesture's name for the Lab, or null. */
  get label(): string | null {
    return this.current;
  }
}

export { GESTURES };
