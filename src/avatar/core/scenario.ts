/**
 * scenario.ts — declarative demo timelines.
 *
 * A scenario is DATA, not code: a list of beats, each with a duration, a
 * target state, and optional input automation (audio level, activity…). The
 * runner advances through the beats against the engine's own frame clock.
 *
 * Why data: the brief's "Run Assistant Demo" must be inspectable and
 * editable without touching the engine, and a future StopWatch firmware will
 * want to replay the *same* scenario JSON to validate its C++ port against
 * the browser. Keeping it as a plain array of literals makes that possible.
 *
 * Two scenarios ship:
 *   `autoDemo`    — the state-cycle tour (idle -> ... -> idle)
 *   `assistantRun`— the full end-to-end "check my email" story
 */

import type { AssistantState, StateContext } from './state';

/**
 * One beat of a scenario.
 *
 * `state` is applied at the beat's start; `duration` is how long it holds;
 * `label` is presentation-only context for the surrounding UI.
 *
 * The `input` block is a *ramp target*: the runner lerps the engine's inputs
 * from their previous beat's values to these over the beat duration, so a
 * scenario never produces a step in the animation.
 */
export interface Beat {
  /** Seconds to hold this beat. */
  duration: number;
  state: AssistantState;
  context?: StateContext;
  /** Target continuous inputs for this beat. Unspecified fields hold. */
  input?: Partial<{
    attention: number;
    activity: number;
    urgency: number;
    audioLevel: number;
    lookX: number;
    lookY: number;
    progress: number;
    progressKnown: boolean;
  }>;
  /**
   * Narrator line shown in the Lab's scenario panel — the user's side of the
   * conversation, or a description of what the assistant is doing.
   */
  caption?: string;
  /** Who is "speaking" this beat: the user, the assistant, or nobody. */
  speaker?: 'user' | 'assistant' | 'system';
  /**
   * Audio automation shape within the beat. `'speech'` produces a realistic
   * syllable-burst envelope instead of a flat level.
   */
  audio?: 'speech' | 'ambient' | 'silent';
  /** Fire a one-shot emphasis pulse at the start of this beat. */
  pulse?: boolean;
  /** Trigger a blink immediately at the start of this beat. */
  blink?: boolean;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  beats: Beat[];
}

/**
 * A realistic speech amplitude curve.
 *
 * A flat `audioLevel` produces an obviously fake mouth. Real speech is bursty
 * at the syllable rate (~4 Hz) with longer phrase-level swells (~0.8 Hz) and
 * short gaps at word boundaries. This is the *source* signal; the engine's
 * AURA-derived envelope shapes it further.
 *
 * Deliberately deterministic (sum of sines, no RNG) so a replayed demo is
 * frame-identical — which matters when comparing the Web renderer against a
 * future StopWatch build.
 */
export function speechLevel(t: number, energy = 1): number {
  // Syllable-rate bursts, 3.7 Hz.
  const syllable = Math.pow(Math.max(0, Math.sin(t * Math.PI * 2 * 3.7)), 0.6);
  // Phrase-level swell, 0.62 Hz — sentences rise and fall.
  const phrase = 0.6 + 0.4 * ((Math.sin(t * Math.PI * 2 * 0.62 - 1.1) + 1) * 0.5);
  // Word-boundary gaps: a short dip every ~1.35 s.
  const gapPhase = (t % 1.35) / 1.35;
  const gap = gapPhase < 0.09 ? 0.12 : gapPhase < 0.16 ? 0.45 : 1;
  // Occasional longer pause, every ~5.2 s.
  const breath = t % 5.2 < 0.32 ? 0.08 : 1;
  return Math.min(1, syllable * phrase * gap * breath * energy);
}

/** A gentle ambient murmur, for LISTENING beats (the user talking). */
export function ambientLevel(t: number): number {
  return Math.min(
    1,
    0.34 +
      0.3 * ((Math.sin(t * Math.PI * 2 * 1.15) + 1) * 0.5) +
      0.18 * ((Math.sin(t * Math.PI * 2 * 2.9 + 0.7) + 1) * 0.5),
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Scenario 1 — Auto Demo
// ══════════════════════════════════════════════════════════════════════════

/**
 * The state-cycle tour the brief asks for:
 *   idle -> listening -> thinking -> working -> speaking -> success -> idle
 *
 * Each beat is long enough to actually observe the state's signature motion
 * (the brief's point is to judge whether the animation *language* is
 * coherent), but short enough to watch end-to-end without boredom.
 */
export const autoDemo: Scenario = {
  id: 'auto-demo',
  name: 'Auto Demo',
  description: 'Cycles idle → listening → thinking → working → speaking → success → idle.',
  beats: [
    {
      duration: 4.0,
      state: 'idle',
      caption: 'At rest. Slow breathing, faint halo, occasional blink.',
      speaker: 'system',
      audio: 'silent',
      input: { attention: 0.35, activity: 0.25, urgency: 0.05, progressKnown: false },
    },
    {
      duration: 4.5,
      state: 'listening',
      caption: 'Listening. Eyes focus, halo ripples with your voice.',
      speaker: 'user',
      audio: 'ambient',
      input: { attention: 0.8, activity: 0.45, urgency: 0.1, lookX: 0, lookY: 0 },
    },
    {
      duration: 4.0,
      state: 'thinking',
      caption: 'Thinking. The orb churns, the trail orbits, the eyes narrow.',
      speaker: 'assistant',
      audio: 'silent',
      input: { attention: 0.6, activity: 0.6, urgency: 0.2 },
    },
    {
      duration: 4.5,
      state: 'working',
      context: { label: 'Searching…' },
      caption: 'Working. Motion becomes directional; a progress ring appears.',
      speaker: 'assistant',
      audio: 'silent',
      input: { attention: 0.5, activity: 0.7, urgency: 0.25, progress: 0.55, progressKnown: true },
    },
    {
      duration: 5.0,
      state: 'speaking',
      caption: 'Speaking. Amplitude drives the lower-wave; eyes stay engaged.',
      speaker: 'assistant',
      audio: 'speech',
      input: { attention: 0.7, activity: 0.6, urgency: 0.2 },
    },
    {
      duration: 2.6,
      state: 'success',
      caption: 'Success. The orb expands, particles release, the eyes smile.',
      speaker: 'assistant',
      audio: 'silent',
      pulse: true,
      input: { attention: 0.6, activity: 0.5, urgency: 0.1, progressKnown: false },
    },
    {
      duration: 3.2,
      state: 'idle',
      caption: 'Settling back to rest.',
      speaker: 'system',
      audio: 'silent',
      input: { attention: 0.35, activity: 0.25, urgency: 0.05 },
    },
  ],
};

// ══════════════════════════════════════════════════════════════════════════
// Scenario 2 — Run Assistant Demo
// ══════════════════════════════════════════════════════════════════════════

/**
 * The full story from the brief:
 *
 *   Idle
 *   -> user wakes it
 *   Listening           "Check if my professor replied to my email."
 *   Thinking
 *   Working             "Reading Gmail…"
 *   Waiting Approval    "Reply to Professor Xu?"
 *   -> user approves
 *   Working             "Sending…"
 *   Success
 *   Idle
 *
 * This is the beat that matters most: the brief asks to see "一个 AI 助理从
 * 听到执行完整工作的生命感" — the *continuity* of a working assistant, not a
 * set of isolated animations. Getting the WAITING_APPROVAL beat right is what
 * carries it: high attention, a clear heartbeat, and absolutely no error
 * semantics.
 */
export const assistantRun: Scenario = {
  id: 'assistant-run',
  name: 'Run Assistant Demo',
  description: 'Idle → wake → listening → thinking → working → approval → working → success → idle.',
  beats: [
    {
      duration: 3.0,
      state: 'idle',
      caption: 'Idle. Nothing is happening yet.',
      speaker: 'system',
      audio: 'silent',
      input: { attention: 0.3, activity: 0.22, urgency: 0.05, progressKnown: false },
    },
    {
      duration: 1.6,
      state: 'listening',
      caption: '“Hey — you there?”',
      speaker: 'user',
      audio: 'ambient',
      blink: true,
      input: { attention: 0.95, activity: 0.5, urgency: 0.15, lookX: 0.12, lookY: -0.08 },
    },
    {
      duration: 6.5,
      state: 'listening',
      caption: '“Check if my professor replied to my email.”',
      speaker: 'user',
      audio: 'ambient',
      input: { attention: 0.9, activity: 0.55, urgency: 0.2, lookX: 0.05, lookY: 0 },
    },
    {
      duration: 4.2,
      state: 'thinking',
      caption: 'Reasoning about which account and which thread.',
      speaker: 'assistant',
      audio: 'silent',
      input: { attention: 0.6, activity: 0.65, urgency: 0.25 },
    },
    {
      duration: 3.4,
      state: 'working',
      context: { label: 'Reading Gmail…' },
      caption: 'Tool call: reading the mailbox.',
      speaker: 'assistant',
      audio: 'silent',
      input: { attention: 0.5, activity: 0.7, urgency: 0.3, progress: 0.35, progressKnown: true },
    },
    {
      duration: 3.2,
      state: 'working',
      context: { label: 'Scanning thread…' },
      caption: 'Found the thread. Reading the latest reply.',
      speaker: 'assistant',
      audio: 'silent',
      input: { progress: 0.72 },
    },
    {
      // The decisive beat. Longer than the others so its signature
      // contract-pause-expand heartbeat plays at least twice.
      duration: 5.5,
      state: 'waiting_approval',
      context: { label: 'Reply to Professor Xu?' },
      caption: '“Reply to Professor Xu?” — waiting for your decision.',
      speaker: 'assistant',
      audio: 'silent',
      pulse: true,
      input: { attention: 1.0, activity: 0.35, urgency: 0.8, progressKnown: false },
    },
    {
      duration: 1.2,
      state: 'working',
      context: { label: 'Sending…' },
      caption: 'You tapped Approve.',
      speaker: 'system',
      audio: 'silent',
      pulse: true,
      input: { attention: 0.55, activity: 0.8, urgency: 0.4, progress: 0.2, progressKnown: true },
    },
    {
      duration: 2.6,
      state: 'working',
      context: { label: 'Sending…' },
      caption: 'Delivering the reply.',
      speaker: 'assistant',
      audio: 'silent',
      input: { progress: 0.95 },
    },
    {
      duration: 2.8,
      state: 'success',
      caption: 'Sent. The orb releases and the eyes smile.',
      speaker: 'assistant',
      audio: 'silent',
      pulse: true,
      input: { attention: 0.6, activity: 0.55, urgency: 0.1, progressKnown: false },
    },
    {
      duration: 4.0,
      state: 'idle',
      caption: 'Back to rest. Waiting.',
      speaker: 'system',
      audio: 'silent',
      input: { attention: 0.35, activity: 0.25, urgency: 0.05 },
    },
  ],
};

export const SCENARIOS: Scenario[] = [autoDemo, assistantRun];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

// ══════════════════════════════════════════════════════════════════════════
// The runner
// ══════════════════════════════════════════════════════════════════════════

export interface ScenarioRunnerHost {
  setState(state: AssistantState, context?: StateContext, force?: boolean): void;
  setInput(patch: Record<string, number | boolean>): void;
  pulse(): void;
  blinkTrigger(): void;
}

/**
 * Plays a scenario against an engine.
 *
 * The runner is intentionally dumb: it owns only "which beat am I on and how
 * far into it", and lerps the inputs. All animation stays in the engine.
 *
 * It stops on its own at the end of the last beat rather than looping, so a
 * viewer can see the final resting state.
 */
export class ScenarioRunner {
  /** 0-based index of the current beat, or -1 when not running. */
  beatIndex = -1;
  /** Seconds elapsed within the current beat. */
  beatTime = 0;
  /** Total seconds elapsed across the whole run. */
  elapsed = 0;
  running = false;

  private scenario: Scenario | null = null;
  /** The input values we are lerping *from* at the start of this beat. */
  private from: Record<string, number | boolean> = {};

  constructor(private readonly host: ScenarioRunnerHost) {}

  get current(): Beat | null {
    if (!this.scenario || this.beatIndex < 0) return null;
    return this.scenario.beats[this.beatIndex] ?? null;
  }

  /** Total run length in seconds. */
  get totalDuration(): number {
    return this.scenario?.beats.reduce((sum, b) => sum + b.duration, 0) ?? 0;
  }

  /** 0..1 progress through the whole scenario. */
  get progress(): number {
    if (!this.scenario || this.totalDuration <= 0) return 0;
    let before = 0;
    for (let i = 0; i < this.beatIndex; i++) before += this.scenario.beats[i]!.duration;
    return Math.min(1, (before + this.beatTime) / this.totalDuration);
  }

  start(scenario: Scenario, initialInput: Record<string, number | boolean> = {}): void {
    this.scenario = scenario;
    this.beatIndex = -1;
    this.beatTime = 0;
    this.elapsed = 0;
    this.running = true;
    this.from = { ...initialInput };
    this.advance();
  }

  stop(): void {
    this.running = false;
    this.beatIndex = -1;
    this.beatTime = 0;
    this.elapsed = 0;
    this.scenario = null;
  }

  private advance(): void {
    if (!this.scenario) return;
    this.beatIndex += 1;
    this.beatTime = 0;
    const beat = this.scenario.beats[this.beatIndex];
    if (!beat) {
      this.running = false;
      return;
    }

    // Apply the beat's discrete actions once, at its start.
    this.host.setState(beat.state, beat.context ?? {}, true);
    if (beat.pulse) this.host.pulse();
    if (beat.blink) this.host.blinkTrigger();

    // Snapshot the *current* input values so the ramp starts from reality
    // rather than from the previous beat's target — this is what keeps a
    // scenario from snapping when beats are shorter than the input springs.
    this.from = {};
  }

  /**
   * Advance the runner.
   *
   * @param dt seconds
   * @param currentInput the engine's live inputs, used as the ramp origin
   * @returns whether the run is still active
   */
  step(dt: number, currentInput: Record<string, number | boolean>): boolean {
    if (!this.running || !this.scenario) return false;

    this.beatTime += dt;
    this.elapsed += dt;
    const beat = this.scenario.beats[this.beatIndex];
    if (!beat) {
      this.running = false;
      return false;
    }

    // ── Input automation ────────────────────────────────────────────────
    const target = beat.input ?? {};
    const keys = Object.keys(target);

    // The ramp origin: on the first frame of a beat we capture the live
    // engine inputs; afterwards we use the captured snapshot.
    if (this.beatTime <= dt * 1.5) {
      for (const key of keys) {
        if (!(key in this.from)) this.from[key] = currentInput[key] ?? 0;
      }
    }
    const t = Math.min(1, this.beatTime / Math.min(1.2, beat.duration));

    const patch: Record<string, number | boolean> = {};

    // Audio is driven by the beat's shape, not by a static value.
    if (beat.audio === 'speech') {
      patch.audioLevel = speechLevel(this.beatTime, 0.95);
    } else if (beat.audio === 'ambient') {
      patch.audioLevel = ambientLevel(this.beatTime);
    } else if (beat.audio === 'silent') {
      patch.audioLevel = 0;
    }

    for (const key of keys) {
      const to = target[key as keyof typeof target];
      if (typeof to === 'boolean') {
        patch[key] = to;
        continue;
      }
      if (typeof to !== 'number') continue;
      const from = typeof this.from[key] === 'number' ? (this.from[key] as number) : to;
      patch[key] = from + (to - from) * t;
    }

    this.host.setInput(patch);

    // ── Beat advance ────────────────────────────────────────────────────
    if (this.beatTime >= beat.duration) {
      this.advance();
      if (!this.running) return false;
    }
    return true;
  }
}
