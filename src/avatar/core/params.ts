/**
 * Continuous parameter layers.
 *
 * Three distinct layers, deliberately separated (this is the single most
 * important architectural decision in this engine):
 *
 *   AvatarInput   — what the outside world knows. Written by the Lab, the
 *                   real agent bridge, or (later) the BMI270 IMU.
 *   AvatarPose    — what the renderer draws. A flat, unitless description of
 *                   the current visual configuration.
 *   AvatarSignals — the behaviour layer's scratch space: derived, smoothed
 *                   quantities the renderer may read but nothing external sets.
 *
 * Only `AvatarPose` reaches `renderer/web`. A StopWatch C++ renderer
 * implements exactly the same flat struct, so the whole core can be ported
 * while the renderer is rewritten.
 *
 * All values are nominally 0..1 unless documented otherwise. Nothing here
 * holds a pixel, a duration or a colour: the renderer owns all output units.
 */

export interface AvatarInput {
  /** How much of the user's attention the assistant believes it has. */
  attention: number;
  /** General arousal / energy level. Raises cadence and deformation. */
  activity: number;
  /** How much this moment matters. Sharpens motion, strengthens pulses. */
  urgency: number;
  /** 0..1 "the assistant is producing sound right now". */
  speaking: number;

  /** Microphone (LISTENING) or TTS (SPEAKING) amplitude, 0..1. */
  audioLevel: number;

  /** Gaze target in normalised device space, -1..1. */
  lookX: number;
  lookY: number;

  /** Optional 0..1 determinate progress (WORKING's ring). */
  progress: number;
  /** Whether `progress` is meaningful; when false the ring is indeterminate. */
  progressKnown: boolean;
}

/**
 * The renderer contract. Flat, unitless, no nesting — one struct that a
 * 240 MHz MCU can memcpy per frame.
 */
export interface AvatarPose {
  // ── Whole-body motion ─────────────────────────────────────────────────
  // THE HEAD MOVES. This layer is what separates a living character from a
  // face pinned to a sphere: the entire orb leans, drifts, bobs and squashes,
  // and the eyes ride along inside it.
  //
  // Technique borrowed from a spring-driven character study (the whole rig —
  // body transform + eye transform + blink + hop — is four springs layered).
  // Our values are derived independently for our own palette and proportions.
  /** Body rotation in radians. Leaning is the strongest "attention" cue. */
  bodyRotation: number;
  /** Body translation, as a fraction of the body radius. */
  bodyX: number;
  bodyY: number;
  /** Body scale, 1 = neutral. Squash on impact, stretch on the way up. */
  bodyScaleX: number;
  bodyScaleY: number;

  // ── Eyes: TWO CAPSULES, BLACK SCREEN ─────────────────────────────────
  //
  // The reference device is the whole specification: a pure-black round
  // screen with two white capsule eyes and, optionally, a thin angled line
  // above each. Nothing else. No sphere shading, no ring, no glow, no
  // mouth, no particles.
  //
  // The capsules are LIVE SHAPES. Expression comes from six per-eye channels
  // plus two shared ones, and the important word is *per-eye* — a symmetric
  // change is a mood, an asymmetric one is a thought.
  //
  //   round  ◉        eyeRound 0     -> neutral, calm
  //   tall   ▮        eyeRound -1    -> alert, surprised, listening
  //   flat   ▬        eyeRound +1    -> sleepy, content, amused
  //   ◉  ▬            different rounds -> skeptical, quizzical, winking
  //   ▮  ▮  raised    lift > 0       -> happy, proud
  //   ▬  ▬  dropped   lift < 0       -> sad, deflated
  //
  /** 0 = shut, 1 = fully open. The BASE aperture; blink multiplies this. */
  eyeOpen: number;
  /**
   * Per-eye aperture multiplier, 1 = unaffected.
   *
   * This is what makes a WINK possible: closing one capsule while the other
   * stays open. A single `eyeOpen` cannot express it, and a wink is one of the
   * most readable friendly gestures there is — it is worth a dedicated channel.
   */
  eyeOpenL: number;
  eyeOpenR: number;
  /**
   * Capsule aspect: -1 = tall and narrow, 0 = round, +1 = short and wide.
   * This single channel is what makes the eye "变圆变扁".
   */
  eyeRound: number;
  /** Per-eye trim on `eyeRound`. The asymmetric-expression channel. */
  eyeRoundL: number;
  eyeRoundR: number;
  /** Overall capsule size multiplier. */
  eyeSize: number;
  /** Per-eye size trim — one eye larger reads as a reaction. */
  eyeSizeL: number;
  eyeSizeR: number;
  /** Distance between the capsules, as a fraction of nominal. */
  eyeDistance: number;
  /**
   * Where the pair sits on the face, -1..1. The gaze channel: this is what
   * lets the bot look up, down, left and right.
   */
  eyeOffsetX: number;
  eyeOffsetY: number;
  /** Per-eye vertical nudge, as a fraction of the body radius. */
  eyeLiftL: number;
  eyeLiftR: number;
  /** Per-eye rotation in radians. */
  eyeTiltL: number;
  eyeTiltR: number;
  /**
   * Per-eye BOW: how far the capsule's centreline arcs away from straight.
   *
   * -1 = sags downward (a frown/wince), 0 = straight, +1 = arcs upward.
   *
   * This is the channel that produces the classic "happy eyes" — two upward
   * arcs (^ ^), the shape every grinning emoji uses. Flat capsules alone cannot
   * express it, which is why SUCCESS looked merely squinting rather than
   * delighted. The arc is perpendicular to the capsule's long axis, so a tall
   * capsule bows sideways and a wide one bows vertically.
   */
  eyeBowL: number;
  eyeBowR: number;

  /**
   * Head rotation in RADIANS, driving the sphere projection.
   *
   * These are the two numbers that turn a flat face into one painted on a ball:
   * the eyes travel along a curve, the near one swells, the far one shrinks.
   * `bodyRotation` is a 2D lean; these are actual 3D turns.
   */
  headYaw: number;
  headPitch: number;

  // ── Brows ─────────────────────────────────────────────────────────────
  // The thin angled line above each eye seen on the reference device. Held at
  // 0 most of the time so the face stays minimal; raised for the states where
  // an eyebrow carries meaning that the eyes alone cannot.
  /** 0 = hidden, 1 = fully drawn. */
  browOpen: number;
  /** Per-brow angle in radians. Positive tips the inner end up. */
  browTiltL: number;
  browTiltR: number;
  /** Per-brow vertical offset, as a fraction of the body radius. */
  browLiftL: number;
  browLiftR: number;

  // ── Orb body ──────────────────────────────────────────────────────────
  /** Base radius multiplier. */
  orbScaleX: number;
  orbScaleY: number;
  /** Body rotation in radians; drives the inner flow direction. */
  orbRotation: number;
  /** 0..1 amount of low-frequency surface deformation (the "fluid" look). */
  orbDeform: number;
  /** 0..1 secondary wobble; the high-frequency component of the deformation. */
  orbWobble: number;

  // ── Halo ──────────────────────────────────────────────────────────────
  /** Halo radius multiplier (1 = nominal). */
  haloRadius: number;
  /** 0..1 halo brightness. */
  haloOpacity: number;
  /** 0..1 tightness of the halo falloff; high = crisp ring, low = soft bloom. */
  haloSharpness: number;
  /** 0..1 ripple emission on top of the halo (LISTENING / APPROVAL pulse). */
  haloRipple: number;

  // ── Trail ─────────────────────────────────────────────────────────────
  /** 0..1 trail presence. */
  trailIntensity: number;
  /** Angular speed multiplier of the trail orbit. */
  trailSpeed: number;
  /** 0..1 how much the trail collapses into a directional comet. */
  trailDirectional: number;
  /** 0..1 trail taper; high = needle-like. */
  trailTaper: number;

  // ── Glow / energy ─────────────────────────────────────────────────────
  /** 0..1 outer bloom strength. */
  glowIntensity: number;
  /** 0..1 inner core brightness. */
  coreIntensity: number;

  // ── Particles ─────────────────────────────────────────────────────────
  /** 0..1 particle emission/spread. */
  particleIntensity: number;
  /** 0..1 outward drift speed of the particles. */
  particleDrift: number;

  // ── Mouth (SPEAKING only) ─────────────────────────────────────────────
  /** 0 = absent, 1 = fully present lower-wave deformation. */
  mouthOpen: number;
  /** 0..1 horizontal spread of the lower-wave. */
  mouthWidth: number;
}

/** Derived signals produced by the behaviour layer and read by the renderer. */
export interface AvatarSignals {
  /** Smoothed audio envelope with AURA's attack/release asymmetry, 0..1. */
  audioEnvelope: number;
  /**
   * The mouth channel: `audioEnvelope` run through AURA's syllable/phrase/
   * closure oscillators and quantised to 4 steps. Kept separate from
   * `audioEnvelope` because LISTENING wants the plain envelope while
   * SPEAKING wants the stylised one.
   */
  mouthLevel: number;
  /** 0 = not blinking, 1 = fully closed. Owned by BlinkController. */
  blink: number;
  /** Name of the saccade currently playing, for the Lab's readout. */
  lastSaccade: string;
  /** Slow ambient life (tilt / drift), -1..1. */
  ambientDriftX: number;
  ambientDriftY: number;
  /** Micro-compression from the ambient controller, 0..1. */
  ambientSquash: number;
  /** AURA's "synthetic pulse": keeps the character alive in silence. */
  syntheticPulse: number;
  /** Seconds since the current AssistantState was entered. */
  stateTime: number;
  /** Name of the gesture currently playing, or ''. */
  gesture: string;
  /** 0..1 intensity of the sleeping "Z" glyphs. Drawn by the renderer. */
  gestureZzz: number;
}

export const NEUTRAL_POSE: AvatarPose = {
  bodyRotation: 0,
  bodyX: 0,
  bodyY: 0,
  bodyScaleX: 1,
  bodyScaleY: 1,

  eyeOpen: 1,
  eyeOpenL: 1,
  eyeOpenR: 1,
  eyeRound: 0,
  eyeRoundL: 0,
  eyeRoundR: 0,
  eyeSize: 1,
  eyeSizeL: 0,
  eyeSizeR: 0,
  eyeDistance: 1,
  eyeOffsetX: 0,
  eyeOffsetY: 0,
  eyeLiftL: 0,
  eyeLiftR: 0,
  eyeTiltL: 0,
  eyeTiltR: 0,
  eyeBowL: 0,
  eyeBowR: 0,
  headYaw: 0,
  headPitch: 0,
  browOpen: 0,
  browTiltL: 0,
  browTiltR: 0,
  browLiftL: 0,
  browLiftR: 0,

  orbScaleX: 1,
  orbScaleY: 1,
  orbRotation: 0,
  orbDeform: 0.15,
  orbWobble: 0.1,

  haloRadius: 1,
  haloOpacity: 0.3,
  haloSharpness: 0.5,
  haloRipple: 0,

  trailIntensity: 0.25,
  trailSpeed: 0.3,
  trailDirectional: 0,
  trailTaper: 0.4,

  glowIntensity: 0.35,
  coreIntensity: 0.6,

  particleIntensity: 0.15,
  particleDrift: 0.2,

  mouthOpen: 0,
  mouthWidth: 0,
};

export const NEUTRAL_INPUT: AvatarInput = {
  attention: 0.35,
  activity: 0.25,
  urgency: 0.1,
  speaking: 0,
  audioLevel: 0,
  lookX: 0,
  lookY: 0,
  progress: 0,
  progressKnown: false,
};

/** Structural clone helpers — kept explicit so a C++ port is mechanical. */
export function clonePose(pose: AvatarPose): AvatarPose {
  return { ...pose };
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Linear interpolation across two poses, field by field. */
export function lerpPose(from: AvatarPose, to: AvatarPose, t: number): AvatarPose {
  const out = {} as AvatarPose;
  for (const key of Object.keys(from) as (keyof AvatarPose)[]) {
    out[key] = from[key] + (to[key] - from[key]) * t;
  }
  return out;
}

/** Additive blend used for layering reactions (blink, micro-reactions). */
export function addPose(base: AvatarPose, delta: Partial<AvatarPose>, weight = 1): AvatarPose {
  const out = { ...base };
  for (const key of Object.keys(delta) as (keyof AvatarPose)[]) {
    const value = delta[key];
    if (value !== undefined) out[key] += value * weight;
  }
  return out;
}
