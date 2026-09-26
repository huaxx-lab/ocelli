/**
 * states.ts — the pose spec table: AssistantState -> target AvatarPose.
 *
 * Pure data, not code. The Lab renders this table as documentation, a designer
 * can retune the avatar without touching the engine, and a C++ port can
 * `static const` the whole thing.
 *
 * ── The expression vocabulary ─────────────────────────────────────────────
 * With no mouth and no nose, everything is carried by:
 *
 *   eyeRound      capsule aspect      tall ▮ / round ◉ / wide ▬
 *   eyeRoundL/R   per-eye aspect      asymmetry = a *thought*, not just a mood
 *   eyeSizeL/R    per-eye scale       one eye larger reads as a reaction
 *   eyeLiftL/R    per-eye height      both up = happy, both down = sad
 *   eyeTiltL/R    per-eye rotation    leaning the pair reads as a head-cock
 *   browOpen      brow visibility     ZERO unless the state needs one
 *   browTilt/Lift per-brow shape      the "worried" vs "quizzical" difference
 *
 * Brows are opt-in for a reason: a permanent brow changes the character's
 * whole face. Only THINKING (one raised), WAITING_APPROVAL (both raised — a
 * question, not a frown) and ERROR (inner ends pinched up — distress) show
 * them. IDLE, LISTENING, WORKING, SPEAKING, SUCCESS and SLEEPING have none.
 */

import type { AvatarPose, AvatarInput } from './params';
import { NEUTRAL_POSE, clamp01, lerp } from './params';
import type { AssistantState } from './state';

export interface StateSpec {
  /** Stable pose this state blends towards. */
  pose: AvatarPose;
  /** Blend duration and easing used when *entering* this state. */
  enter: { duration: number; easing: import('./easing').EasingName };
  /** Blend duration used when leaving towards another state. */
  exit: number;
  /**
   * Per-frame additive modulation: the *living* motion on top of the blended
   * base pose. Applied after the blend, never blended itself — a continuous
   * wave that keeps retargeting the blend would restart the transition every
   * frame and the pose would never arrive.
   */
  modulate?: (
    pose: AvatarPose,
    input: AvatarInput,
    time: number,
    level: number,
  ) => Partial<AvatarPose>;
  /** Presentation metadata for the Lab (never read by the renderer). */
  note: string;
}

/** Build a pose by overriding the neutral baseline. */
function pose(overrides: Partial<AvatarPose>): AvatarPose {
  return { ...NEUTRAL_POSE, ...overrides };
}

/** Slow sine, period `seconds`, phase in turns. */
function wave(time: number, seconds: number, phase = 0): number {
  return Math.sin((time / seconds) * Math.PI * 2 + phase * Math.PI * 2);
}

export const STATE_SPECS: Record<AssistantState, StateSpec> = {
  // ── IDLE ────────────────────────────────────────────────────────────────
  // Resting. Tall-ish capsules, no brows, slow breathing. Never fully still:
  // the body sways, the gaze saccades, the sphere's light drifts.
  // Feel: "I'm here."
  idle: {
    pose: pose({
      eyeRound: -0.55,
      eyeSize: 1,
      eyeDistance: 1,
      browOpen: 0,
    }),
    enter: { duration: 1.1, easing: 'sineInOut' },
    exit: 0.5,
    note: 'Slow breathing, faint interior light drift, occasional blink. Never fully still.',
    modulate: (_p, input, time, _level) => {
      // A long, shallow breathing cycle. Activity shortens the period so an
      // aroused avatar breathes faster.
      const period = lerp(7.2, 5.2, clamp01(input.activity));
      const breath = wave(time, period);
      return {
        eyeSize: breath * 0.012,
        eyeLiftL: breath * 0.004,
        eyeLiftR: breath * 0.004,
        orbDeform: Math.abs(breath) * 0.35,
      };
    },
  },

  // ── LISTENING ───────────────────────────────────────────────────────────
  // Taller capsules, closer together, no brows: leaning in and attending.
  // The capsules answer the voice with a small, shallow pulse — deliberately
  // understated, because a big response reads as a level meter rather than as
  // attention.
  // Feel: "I'm listening to you."
  listening: {
    pose: pose({
      eyeRound: -0.78,
      eyeSize: 1.08,
      eyeDistance: 0.94,
      // A whisper of upward bow: attentive, not yet pleased. Deliberately
      // below SUCCESS's arc so the two states stay distinguishable.
      eyeBowL: 0.12,
      eyeBowR: 0.12,
      browOpen: 0,
    }),
    enter: { duration: 0.5, easing: 'cubicOut' },
    exit: 0.4,
    note: 'Eyes focus and hold, capsules answer your voice, head leans in.',
    modulate: (_p, _input, _time, level) => {
      const amp = clamp01(level);
      return {
        eyeSize: amp * 0.05,
        eyeRound: -amp * 0.08,
      };
    },
  },

  // ── THINKING ────────────────────────────────────────────────────────────
  // THE ASYMMETRY STATE. One capsule subtly narrower and smaller than the
  // other, plus a single raised brow. That single difference is what makes it
  // look like it is *considering* rather than merely staring.
  // Feel: "I'm reasoning."
  thinking: {
    pose: pose({
      eyeRound: -0.5,
      // Both stay capsules; the LEFT is simply shorter. Pushing one past zero
      // turned it into a filled circle, which reads as a fault, not a thought.
      eyeRoundL: 0.3,
      eyeRoundR: -0.05,
      // A slight downward bow on the narrowed eye: considering something
      // doubtful, not delighted by it.
      eyeBowL: -0.15,
      eyeBowR: -0.15,
      eyeSize: 0.97,
      eyeSizeL: -0.05,
      eyeDistance: 1.0,
      eyeLiftL: 0.012,
      eyeTiltL: -0.05,
      // One brow, raised and angled. Thinking is the classic single-brow state.
      browOpen: 1,
      browTiltL: 0.2,
      browTiltR: -0.04,
      browLiftL: 0.05,
    }),
    enter: { duration: 0.7, easing: 'sineInOut' },
    exit: 0.45,
    note: 'One eye narrower than the other, one brow raised. Never a spinner.',
    modulate: (_p, _input, time, _level) => {
      // A slow drift of the asymmetry itself, so the "thought" keeps moving.
      const drift = wave(time, 4.3);
      return {
        eyeRoundL: drift * 0.07,
        eyeRound: wave(time, 6.1, 0.3) * 0.05,
        orbDeform: 0.5 + Math.abs(drift) * 0.4,
      };
    },
  },

  // ── WORKING ─────────────────────────────────────────────────────────────
  // Deliberately distinct from THINKING: level, symmetric, purposeful. The
  // asymmetry collapses to zero, which is exactly what "decided, executing"
  // looks like after "weighing it up".
  // Feel: "I've started doing it."
  working: {
    pose: pose({
      eyeRound: -0.62,
      eyeSize: 1.0,
      eyeDistance: 1.0,
      browOpen: 0,
    }),
    enter: { duration: 0.55, easing: 'cubicOut' },
    exit: 0.4,
    note: 'Level and symmetric — decided, executing. Distinct from thinking.',
    modulate: (_p, _input, time, _level) => {
      // A slow, metronomic working pulse. Ordered, not agitated.
      const tick = wave(time, 2.0);
      return {
        eyeSize: tick * 0.014,
        eyeLiftL: tick * 0.006,
        eyeLiftR: tick * 0.006,
      };
    },
  },

  // ── SPEAKING ────────────────────────────────────────────────────────────
  // Rounder and more animated, with a gentle symmetric bob on the voice
  // envelope. There is no mouth — the amplitude is expressed by the eyes,
  // which is what keeps the character minimal.
  // Feel: "I'm talking to you."
  speaking: {
    pose: pose({
      eyeRound: -0.15,
      eyeSize: 1.03,
      eyeDistance: 1.0,
      eyeBowL: 0.2,
      eyeBowR: 0.2,
      browOpen: 0,
    }),
    enter: { duration: 0.45, easing: 'cubicOut' },
    exit: 0.35,
    note: 'Rounded, animated capsules that answer the voice. No cartoon mouth.',
    modulate: (_p, _input, _time, level) => {
      const shaped = clamp01(level);
      return {
        eyeSize: shaped * 0.055,
        eyeRound: shaped * 0.14,
        // The bow answers the voice too, so speaking is visibly warmer than
        // merely being open.
        eyeBowL: shaped * 0.12,
        eyeBowR: shaped * 0.12,
        eyeLiftL: shaped * 0.008,
        eyeLiftR: shaped * 0.008,
        orbDeform: 0.3 + shaped * 0.6,
      };
    },
  },

  // ── WAITING_INPUT ───────────────────────────────────────────────────────
  // Tall, calm, evenly spaced, no brows. Movement is suppressed on purpose —
  // the whole read is "stillness = waiting for you".
  // Feel: "I'm waiting for you."
  waiting_input: {
    pose: pose({
      eyeRound: -0.85,
      eyeSize: 1.06,
      eyeDistance: 0.96,
      browOpen: 0,
    }),
    enter: { duration: 0.6, easing: 'sineInOut' },
    exit: 0.35,
    note: 'Gaze locks on, movement drops, capsules tall and still.',
    modulate: (_p, _input, time, _level) => ({
      eyeSize: wave(time, 4.4) * 0.008,
    }),
  },

  // ── WAITING_APPROVAL ────────────────────────────────────────────────────
  // The most important Personal Assistant state. TALLEST capsules, widest
  // attention, and BOTH brows raised evenly — a question, not a frown. Tipping
  // them inward would make it read as anger, which this state must never do.
  // Feel: "I need your decision."
  waiting_approval: {
    pose: pose({
      eyeRound: -0.95,
      eyeSize: 1.1,
      eyeDistance: 0.93,
      browOpen: 1,
      browTiltL: 0,
      browTiltR: 0,
      browLiftL: 0.08,
      browLiftR: 0.08,
    }),
    enter: { duration: 0.5, easing: 'backOut' },
    exit: 0.5,
    note: 'Tallest capsules, both brows up — a question. No error semantics.',
    modulate: (_p, input, time, _level) => {
      // The signature beat: a 2.6 s cycle — contract fast, pause, expand slow.
      // The pause is real dead time, and it is what makes the state feel
      // deliberate rather than jittery.
      const cycle = 2.6;
      const t = (time % cycle) / cycle;
      let beat: number;
      if (t < 0.16) beat = -Math.sin((t / 0.16) * Math.PI);
      else if (t < 0.45) beat = 0;
      else if (t < 0.72) beat = Math.sin(((t - 0.45) / 0.27) * Math.PI);
      else beat = 0;
      const urgency = clamp01(input.urgency);
      const gain = 0.7 + urgency * 0.9;
      return {
        eyeSize: beat * 0.05 * gain,
        eyeLiftL: beat * 0.008 * gain,
        eyeLiftR: beat * 0.008 * gain,
        browLiftL: beat * 0.01 * gain,
        browLiftR: beat * 0.01 * gain,
        orbDeform: 0.4 + Math.abs(beat) * 0.8,
      };
    },
  },

  // ── SUCCESS ─────────────────────────────────────────────────────────────
  // Never a green tick. Both capsules flatten and rise — the "happy squint" —
  // then melt back to idle. No brows: the capsules alone carry it.
  // Feel: "Done. That went well."
  success: {
    pose: pose({
      // THE GRINNING EYES. 😄
      //
      // Every grinning emoji draws its eyes as two upward arcs — "^ ^" — and
      // that arc is the single feature that reads as delight. A flat capsule
      // cannot express it no matter how wide it gets; that is why the earlier
      // version looked merely squinting.
      //
      // So: wide, thin, and strongly BOWED UP. `eyeBow` is the channel that
      // does the actual work here, and `eyeSize` comes down a little because a
      // bow already thins the stroke (see the renderer).
      eyeRound: 1.0,
      eyeSize: 1.0,
      eyeBowL: 0.85,
      eyeBowR: 0.85,
      eyeDistance: 1.0,
      // Raised: delight lifts the face. The bow supplies the shape, the lift
      // supplies the energy.
      eyeLiftL: 0.05,
      eyeLiftR: 0.05,
      browOpen: 0,
      // The wink itself is driven by the engine's timed envelope
      // (`engine.winkOnce()`), not held here — a held wink would freeze.
    }),
    enter: { duration: 0.42, easing: 'backOut' },
    // A long, soft exit is what produces "slowly return to idle".
    exit: 1.1,
    note: 'Capsules flatten and lift into a happy squint with a wink, then melt back to idle.',
    modulate: (_p, _input, time, _level) => {
      // A single gentle settle after the initial pop, not a continuing pulse.
      const settle = Math.exp(-time * 2.4) * Math.cos(time * 9.5);
      return {
        eyeSize: settle * 0.03,
        eyeLiftL: settle * 0.006,
        eyeLiftR: settle * 0.006,
      };
    },
  },

  // ── ERROR ───────────────────────────────────────────────────────────────
  // THE OTHER BROW STATE. Capsules slightly flattened and dropped, with the
  // inner ends of both brows pinched UP — the universal distressed shape.
  // Without brows this would only look "smaller", which is not the same as
  // "upset". A short instability burst decays into a stable subdued pose.
  // Feel: "That didn't work."
  error: {
    pose: pose({
      // The exact inverse of SUCCESS: the arc SAGS (v v where SUCCESS is ^ ^).
      // That pairing is how emoji distinguish 😄 from 😞, and it means the two
      // states differ by the SIGN of one channel, which is impossible to
      // confuse. Paired with the distressed brows, ERROR carries two
      // independent signals pointing the same way.
      // Wide as well as sagging: a downward arc needs horizontal span to be
      // legible, and a short thick capsule simply swallows it. Same aspect as
      // SUCCESS, opposite bow — so the two are mirror images.
      eyeRound: 0.9,
      eyeSize: 1.0,
      eyeBowL: -0.85,
      eyeBowR: -0.85,
      eyeDistance: 1.0,
      eyeLiftL: -0.045,
      eyeLiftR: -0.045,
      browOpen: 1,
      // BOTH positive: `browTilt * side` then lifts each brow's INNER end.
      // That is the universal distressed shape; the opposite pair reads as a
      // smirk, and one-of-each reads as confusion.
      browTiltL: 0.34,
      browTiltR: 0.34,
      browLiftL: -0.015,
      browLiftR: -0.015,
    }),
    enter: { duration: 0.22, easing: 'cubicOut' },
    exit: 0.7,
    note: 'Capsules drop, brows pinch up into distress, then a stable subdued pose.',
    modulate: (_p, _input, time, _level) => {
      // The instability decays fast: visible for ~0.5 s, gone by ~1.1 s.
      const decay = Math.exp(-time * 3.4);
      if (decay < 0.01) {
        return { eyeSize: wave(time, 6.5) * 0.006 };
      }
      const jitter = wave(time, 0.083) * decay;
      const wobble = wave(time, 0.061, 0.4) * decay;
      return {
        eyeRoundL: wobble * 0.06,
        eyeRoundR: -wobble * 0.06,
        eyeTiltL: jitter * 0.05,
        eyeTiltR: jitter * 0.05,
        eyeSize: jitter * 0.03,
      };
    },
  },

  // ── SLEEPING ────────────────────────────────────────────────────────────
  // Capsules collapse to thin horizontal lines and drift down. No brows. Only
  // a very faint breath remains — the difference between "asleep" and
  // "powered off".
  // Feel: "I'm resting, but I'm still here."
  sleeping: {
    pose: pose({
      eyeOpen: 0,
      eyeRound: 1,
      eyeSize: 0.9,
      eyeDistance: 1.0,
      eyeLiftL: -0.05,
      eyeLiftR: -0.05,
      browOpen: 0,
    }),
    // Slow, heavy entry — falling asleep is gradual.
    enter: { duration: 1.6, easing: 'sineInOut' },
    // Waking is faster than sleeping: attention snaps back.
    exit: 0.55,
    note: 'Capsules close to thin lines, motion nearly stops. One faint breath.',
    modulate: (_p, _input, time, _level) => {
      // One breath roughly every 9 s, very shallow.
      const breath = wave(time, 9.0);
      return {
        eyeSize: breath * 0.018,
        eyeLiftL: breath * 0.004,
        eyeLiftR: breath * 0.004,
      };
    },
  },
};

/** Convenience accessor used by the resolver and the Lab's docs panel. */
export function specFor(state: AssistantState): StateSpec {
  return STATE_SPECS[state];
}
