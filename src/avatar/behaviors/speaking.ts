/**
 * speaking.ts — AudioEnvelope + MouthShape.
 *
 * AURA's mouth pipeline, ported with the constants intact because the
 * constants are the design:
 *
 *   dB peak -> clamp((db + 68) / 45) with a -62 dB gate
 *           -> one-pole smoothing, attack 0.55 / release 0.18
 *           -> multiply by syllable (452 ms) * phrase (1319 ms) * closure
 *              (640 ms cycle) with a x0.25 dip in the last 200 ms of every
 *              2300 ms
 *           -> QUANTISE TO 4 STEPS
 *
 * The quantisation is the part people get wrong. Smoothing it away produces
 * an equaliser; keeping the 4 steps produces a character.
 *
 * AURA reads this from the microphone because it has no access to the TTS
 * PCM. In the browser we have a real AnalyserNode, so `AudioEnvelope` accepts
 * either a linear 0..1 level (already normalised) or AURA's raw dB value.
 *
 * The synthetic-pulse floor is also ported: it guarantees the character never
 * freezes during a quiet passage of speech.
 */

import { Envelope } from '../core/transitions';

/** AURA mouth level mapping: -68 dB -> 0, -23 dB -> 1, hard gate at -62 dB. */
export const DB_FLOOR = -68;
export const DB_CEIL = -23;
export const DB_GATE = -62;

/** AURA envelope rates (per 70 ms poll). */
export const ATTACK = 0.55;
export const RELEASE = 0.18;

/** AURA's oscillator periods, in seconds. */
const SYLLABLE_PERIOD = 0.452; // sinf(now/72) in AURA's ms-ish units
const PHRASE_PERIOD = 1.319; // sinf(now/210)
const CLOSURE_PERIOD = 0.64; // now % 640
const PHRASE_END_PERIOD = 2.3; // now % 2300
const PHRASE_END_TAIL = 0.2; // > 2100 -> attenuate

/**
 * Convert AURA's decibel reading into a 0..1 level.
 * Exposed separately so a future StopWatch firmware and the Web analyser
 * share one normalisation.
 */
export function dbToLevel(db: number): number {
  if (!Number.isFinite(db)) return 0;
  if (db < DB_GATE) return 0;
  const n = (db - DB_FLOOR) / (DB_CEIL - DB_FLOOR);
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * The mouth channel.
 *
 * `level` (output) is the quantised 0..1 mouth opening; `envelope` is the
 * un-quantised smoothed value (used by LISTENING, which wants the plain
 * envelope rather than the stylised one).
 */
export class MouthChannel {
  /** Smoothed, un-quantised 0..1. */
  envelope = 0;
  /** Quantised to 4 steps, 0..1. The renderer reads this for SPEAKING. */
  level = 0;

  private smoother = new Envelope(ATTACK, RELEASE);
  private time = 0;

  /** Hard reset — AURA zeroes the mouth immediately when speech stops. */
  reset(): void {
    this.smoother.set(0);
    this.envelope = 0;
    this.level = 0;
  }

  /**
   * @param dt        seconds
   * @param rawLevel  0..1 TTS amplitude (already normalised)
   * @param active    whether the character is currently producing sound
   */
  step(dt: number, rawLevel: number, active: boolean): number {
    this.time += dt;

    const target = active ? Math.max(0, Math.min(1, rawLevel)) : 0;
    // AURA's asymmetric one-pole. Attack fast, release slow.
    this.envelope = this.smoother.step(target, dt);

    if (!active || this.envelope <= 0.05) {
      // AURA forces frame 0 below 0.05 and on teardown.
      this.level = 0;
      return this.level;
    }

    // Syllable / phrase / lip-closure envelope, verbatim from AURA.
    const syllable = 0.5 + 0.5 * ((Math.sin((this.time / SYLLABLE_PERIOD) * Math.PI * 2) + 1) * 0.5);
    const phrase = 0.72 + 0.28 * ((Math.sin((this.time / PHRASE_PERIOD) * Math.PI * 2 + 1.4) + 1) * 0.5);
    const cc = this.time % CLOSURE_PERIOD;
    let closure: number;
    if (cc < 0.07) closure = 0.1;
    else if (cc < 0.115) closure = 0.35;
    else closure = 1;
    if (this.time % PHRASE_END_PERIOD > PHRASE_END_PERIOD - PHRASE_END_TAIL) closure *= 0.25;

    const anim = Math.max(0, Math.min(1, this.envelope * syllable * phrase * closure));
    // 4 discrete steps — AURA's 4 mouth images.
    this.level = Math.round(anim * 3) / 3;
    return this.level;
  }
}

/**
 * The LISTENING channel: plain smoothed envelope plus AURA's synthetic
 * floor, so the orb keeps reacting gently even in near-silence.
 */
export class ListenChannel {
  envelope = 0;

  private smoother = new Envelope(ATTACK, RELEASE);
  private time = 0;

  /**
   * @param dt      seconds
   * @param rawLevel 0..1 microphone amplitude
   * @param active  whether the microphone is live
   */
  step(dt: number, rawLevel: number, active: boolean): number {
    this.time += dt;
    const real = active ? Math.max(0, Math.min(1, rawLevel)) : 0;

    // AURA's synthetic pulse, ported from the music VU as a general
    // "never freeze" floor. Three incommensurate periods keep it from
    // reading as a fixed oscillation.
    const slow = (Math.sin((this.time / 0.31) * Math.PI * 2) + 1) * 0.5;
    const fast = (Math.sin((this.time / 0.105) * Math.PI * 2) + 1) * 0.5;
    let pulse = Math.sin((this.time / 0.072) * Math.PI * 2);
    if (pulse < 0) pulse = 0;
    pulse = pulse * pulse * pulse * pulse;
    const synthetic = 0.1 + slow * 0.16 + fast * 0.18 + pulse * 0.38;

    let target = real;
    if (target < 0.04) {
      target = synthetic * 0.72;
    } else {
      const floor = synthetic * 0.2;
      if (target < floor) target = floor;
    }

    this.envelope = this.smoother.step(Math.min(1, target), dt);
    return this.envelope;
  }

  reset(): void {
    this.smoother.set(0);
    this.envelope = 0;
  }
}
