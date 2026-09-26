/**
 * behavior.ts — the AvatarEngine.
 *
 * The one object every consumer talks to. It owns:
 *
 *   - the AssistantState + its transition bookkeeping
 *   - the continuous AvatarInput
 *   - the four behaviour controllers (blink / gaze / ambient / mouth)
 *   - the pose blender that turns `currentPose` into `targetPose`
 *   - the derived AvatarSignals the renderer reads
 *
 * It does NOT own:
 *   - any drawing (that is renderer/web)
 *   - any React (that is components/)
 *   - any timer source (the caller passes `dt`)
 *
 * That last point is what makes the StopWatch port possible: a C++ port
 * constructs the same object, calls `step(dt)` from the render loop, and
 * reads `pose` — with zero Web dependencies.
 *
 * Fusion summary:
 *   KK       -> the pose/blend pipeline, easing vocabulary, procedural idle
 *   Grok     -> nothing structural; its influence lives in states.ts poses
 *   AURA     -> the state priority ladder, blink cadence, gesture table,
 *               mouth envelope, synthetic floor, sleep/wake behaviour
 */

import {
  NEUTRAL_INPUT,
  NEUTRAL_POSE,
  addPose,
  clamp01,
  type AvatarInput,
  type AvatarPose,
  type AvatarSignals,
} from './params';
import { STATE_PRIORITY, type AssistantState, type StateContext } from './state';
import { specFor } from './states';
import { PoseBlender, Spring } from './transitions';
import { Rng } from './timeline';

import { BlinkController } from '../behaviors/blink';
import { GazeController, PointerGazeSource, TargetGazeSource, type GazeSource } from '../behaviors/gaze';
import { AmbientController } from '../behaviors/ambient';
import { BodyController } from '../behaviors/body';
import { GestureController, type GestureKind } from '../behaviors/gestures';
import {
  DEFAULT_TUNING,
  TouchRecogniser,
  dragToTurn,
  type InteractionIntent,
  type InteractionTuning,
} from './interaction';
import { ListenChannel, MouthChannel } from '../behaviors/speaking';

/** A state request carrying an optional priority override. */
export interface StateRequest {
  state: AssistantState;
  context?: StateContext;
}

/** A listener notified whenever the committed state changes. */
export type StateListener = (state: AssistantState, previous: AssistantState, context: StateContext) => void;

/**
 * How long the short post-engagement blink cadence lasts after a busy state
 * ends. AURA reseeds the interval directly; because our blink controller owns
 * its own deadline we instead flag "recently engaged" for a few seconds after
 * the transition, which produces the same felt behaviour.
 */
const REENGAGE_WINDOW = 4.0;

export class AvatarEngine {
  // ── Public read-only state ─────────────────────────────────────────────
  /** The committed semantic state. */
  state: AssistantState = 'idle';
  /** Presentation metadata for the current state (never read by the renderer). */
  context: StateContext = {};

  /** The fully-resolved pose the renderer should draw, including all layers. */
  pose: AvatarPose = { ...NEUTRAL_POSE };

  /** Derived signals, exposed for the Lab's debug panel. */
  signals: AvatarSignals = {
    audioEnvelope: 0,
    mouthLevel: 0,
    blink: 0,
    lastSaccade: '',
    ambientDriftX: 0,
    ambientDriftY: 0,
    ambientSquash: 0,
    syntheticPulse: 0,
    stateTime: 0,
    gesture: '',
    gestureZzz: 0,
  };

  /** The target pose the blender is heading towards (before additive layers). */
  targetPose: AvatarPose = { ...NEUTRAL_POSE };

  readonly input: AvatarInput = { ...NEUTRAL_INPUT };

  // ── Behaviour controllers ──────────────────────────────────────────────
  readonly blink: BlinkController;
  readonly gaze: GazeController;
  readonly ambient: AmbientController;
  /** Whole-body motion: lean, drift, squash, hops. The head layer. */
  readonly body: BodyController;
  /**
   * One-shot and sustained gestures (wink, nod, laugh, sing, zzz…).
   *
   * Kept separate from the state machine on purpose: a gesture is something the
   * avatar *does*, a state is something it *is*. Any gesture can play over any
   * state without adding a case to `states.ts`.
   */
  readonly gestures: GestureController;

  /**
   * Touch / pointer interaction: taps, drags, swipes, long presses.
   *
   * Owned here rather than in the React layer so the recogniser is portable —
   * the StopWatch feeds it CST820B touch events and gets identical behaviour.
   */
  readonly touch: TouchRecogniser;
  readonly mouth = new MouthChannel();
  readonly listen = new ListenChannel();

  readonly rng: Rng;

  // ── Internals ──────────────────────────────────────────────────────────
  private blender: PoseBlender;
  private listeners = new Set<StateListener>();
  private stateElapsed = 0;
  private sinceEngaged = Infinity;
  /** Attention/activity/urgency springs: the *inputs* are smoothed too, so a
   * slider dragged quickly does not produce a step in the animation. */
  private attentionSpring: Spring;
  private activitySpring: Spring;
  private urgencySpring: Spring;
  private lookXSpring: Spring;
  private lookYSpring: Spring;
  /** Progress ring smoothing, so a jumpy progress value still reads cleanly. */
  private progressSpring: Spring;
  private gazeSource: GazeSource;

  /**
   * The pointer-driven gaze source, when one is installed.
   *
   * Exposed as a public readonly seam: the Lab's canvas forwards pointer
   * events straight into it. On the StopWatch this property is simply never
   * set, and an `ImuGazeSource` takes its place — no other code changes.
   */
  readonly pointerSource: PointerGazeSource | null;

  /** Set by `pulse()`; drives WAITING_APPROVAL's one-shot emphasis. */
  private emphasis = 0;

  /** Internal monotonic clock in ms, advanced by `step(dt)`. */
  private nowMs = 0;



  constructor(options: { seed?: number; gazeSource?: GazeSource } = {}) {
    this.rng = new Rng(options.seed ?? 0x5eed1234);
    this.blink = new BlinkController(this.rng);
    this.gazeSource = options.gazeSource ?? new PointerGazeSource();
    this.pointerSource = this.gazeSource instanceof PointerGazeSource ? this.gazeSource : null;
    this.gaze = new GazeController(this.rng, this.gazeSource);
    this.ambient = new AmbientController(this.rng);
    this.body = new BodyController(this.rng);
    this.gestures = new GestureController(this.rng);
    this.touch = new TouchRecogniser();
    this.blender = new PoseBlender(NEUTRAL_POSE, { duration: 1.1, easing: 'sineInOut' });
    this.attentionSpring = new Spring(NEUTRAL_INPUT.attention, 0.35);
    this.activitySpring = new Spring(NEUTRAL_INPUT.activity, 0.5);
    this.urgencySpring = new Spring(NEUTRAL_INPUT.urgency, 0.3);
    this.lookXSpring = new Spring(0, 0.22);
    this.lookYSpring = new Spring(0, 0.22);
    this.progressSpring = new Spring(0, 0.4);
  }

  /** Swap the gaze source (e.g. pointer -> a simulated IMU). */
  setGazeSource(source: GazeSource): void {
    this.gazeSource = source;
    // Rebuild the gaze controller so it picks up the new source cleanly.
    (this as { gaze: GazeController }).gaze = new GazeController(this.rng, source);
  }

  get gazeSourceKind(): string {
    return this.gazeSource.kind;
  }

  /**
   * Subscribe to recognised interaction intents.
   *
   * Exposed so a host can show or log what the user did — and, more usefully,
   * so the StopWatch firmware can mirror it (a buzz on a long press, say)
   * without duplicating the recognition.
   */
  onIntent(listener: (intent: InteractionIntent) => void): () => void {
    this.intentListeners.add(listener);
    return () => this.intentListeners.delete(listener);
  }

  private readonly intentListeners = new Set<(intent: InteractionIntent) => void>();

  /** Subscribe to committed state changes. */
  onStateChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Request a state change.
   *
   * Two guards, both borrowed from AURA's tiny priority ladder:
   *   1. A lower-priority request cannot interrupt a higher-priority state
   *      unless `force` is set. This stops a stray ambient 'idle' from
   *      cancelling 'waiting_approval'.
   *   2. Re-requesting the current state only refreshes the context (so the
   *      WORKING label can change without restarting the blend).
   */
  setState(next: AssistantState, context: StateContext = {}, force = false): void {
    if (next === this.state) {
      this.context = context;
      return;
    }
    if (!force && STATE_PRIORITY[next] < STATE_PRIORITY[this.state]) {
      // Exception: an explicit return to idle/sleeping is always honoured —
      // those are "the task finished" signals, not ambient noise.
      const settles = next === 'idle' || next === 'sleeping';
      if (!settles) return;
    }

    const previous = this.state;
    this.state = next;
    this.context = context;
    this.stateElapsed = 0;

    if (next === 'speaking' || next === 'working' || next === 'thinking') {
      this.sinceEngaged = 0;
    }

    // State entry can fire a gesture. SUCCESS winks (it is the one state where
    // a wink reads as genuine pleasure rather than as a tic), and SLEEPING
    // starts the floating "Z"s.
    if (next === 'success') {
      this.gestures.play('wink');
    } else if (next === 'sleeping') {
      this.gestures.play('zzz');
    } else if (this.gestures.sleeping) {
      // Leaving SLEEPING must stop the Z's, or they linger over a waking face.
      this.gestures.stop();
    }

    const spec = specFor(next);
    // Enter with this state's own duration/easing; the *exit* duration is
    // applied by the resolver when leaving, via `blendExit`.
    this.blender.setTarget(spec.pose, { duration: spec.enter.duration, easing: spec.enter.easing });

    for (const listener of this.listeners) listener(next, previous, context);
  }

  /** Force a one-shot emphasis pulse (Lab button; later, StopWatch buzz). */
  pulse(): void {
    this.emphasis = 1;
  }

  /**
   * Play a gesture. See `behaviors/gestures.ts` for the full list.
   *
   * @param kind - the gesture to play
   * @param side - for lateral gestures, which way; random by default
   */
  gesture(kind: GestureKind, side?: -1 | 1): void {
    this.gestures.play(kind, side);
  }

  // ── Touch surface ────────────────────────────────────────────────────
  // The host forwards raw positions; everything else lives here.

  /**
   * Pointer down at a normalised position.
   *
   * No timestamp is taken from the host. All gesture TIMING is measured against
   * the engine's own clock, which advances with `step(dt)` — so a gesture lasts
   * the same wall-clock time at 30 fps and at 120 fps, and the recogniser needs
   * no clock at all when it is ported.
   */
  touchDown(x: number, y: number): void {
    this.touch.down(x, y, this.nowMs);
  }

  /**
   * Pointer move. While a press is active the head is turned by the drag;
   * otherwise the eyes simply follow.
   */
  touchMove(x: number, y: number): void {
    const drag = this.touch.move(x, y);
    if (this.touch.pressing && this.touch.dragging) {
      // The drag turns the head. Accumulated from the ORIGIN of the press, so
      // the mapping is absolute and releasing cannot leave it offset.
      const turn = dragToTurn(this.touch.dragDX, this.touch.dragDY, this.touchTuning.dragTurnRange);
      this.body.setManualTurn(turn.yaw, turn.pitch);
      void drag;
    }
  }

  /** Pointer up; returns the recognised intent (may be null). */
  touchUp(): InteractionIntent | null {
    const intent = this.touch.up(this.nowMs);
    // A completed drag hands the head back to the gaze.
    if (!this.touch.pressing) this.body.clearManualTurn();
    if (intent) this.handleIntent(intent);
    return intent;
  }

  /**
   * Poll for a long press. Called every frame from `step`: a long press must
   * fire DURING the hold, not on release.
   */
  touchTick(): InteractionIntent | null {
    const intent = this.touch.tick(this.nowMs);
    if (intent) this.handleIntent(intent);
    return intent;
  }

  /** Cancel an in-flight press (pointer left the surface). */
  touchCancel(): void {
    this.touch.cancel();
    this.body.clearManualTurn();
  }

  /** Retune the recogniser (the Lab exposes drag range as a slider). */
  setTouchTuning(patch: Partial<InteractionTuning>): void {
    Object.assign(this.touchTuning, patch);
    this.touch.setTuning(patch);
  }

  readonly touchTuning: InteractionTuning = { ...DEFAULT_TUNING };

  /**
   * Route an intent to the behaviour it means.
   *
   * The mapping lives HERE, in the engine, so every host gets the same
   * vocabulary — the Web Lab and the StopWatch firmware cannot drift apart.
   */
  handleIntent(intent: InteractionIntent): void {
    for (const listener of this.intentListeners) listener(intent);
    switch (intent.kind) {
      case 'tap':
        // Tapping a sleeping avatar wakes it; otherwise it blinks.
        if (this.state === 'sleeping') this.wake();
        else this.blink.trigger();
        break;
      case 'doubleTap':
        // A wink is the friendly acknowledgement, and it is what a double tap
        // means on every messenger the user already knows.
        this.gestures.play('wink');
        break;
      case 'longPress':
        // Long press toggles sleep — the same gesture phones use for "off".
        if (this.state === 'sleeping') this.wake();
        else this.sleep();
        break;
      case 'swipe':
        switch (intent.dir) {
          case 'left':
          case 'right':
            // A deliberate glance in the swipe direction.
            this.gestures.play('peek', intent.dir === 'left' ? -1 : 1);
            break;
          case 'up':
            this.setInput({ activity: Math.min(1, this.input.activity + 0.2) });
            break;
          case 'down':
            this.setInput({ activity: Math.max(0, this.input.activity - 0.2) });
            break;
        }
        break;
    }
  }

  /** Wink. Convenience wrapper so callers need not import the kind union. */
  winkOnce(side?: -1 | 1): void {
    this.gestures.play('wink', side);
  }

  /** Whether a gesture is currently playing. */
  get gesturing(): boolean {
    return this.gestures.active;
  }

  /** Wake from SLEEPING with the proper transition. Returns true if it woke. */
  wake(): boolean {
    if (this.state !== 'sleeping') return false;
    this.setState('idle', {}, true);
    this.blink.reseedShort();
    this.gaze.reseed(9000, 20000);
    this.ambient.reseed(9000, 22000);
    return true;
  }

  /** Put the character to sleep (Lab button / inactivity timeout). */
  sleep(): void {
    if (this.state === 'sleeping') return;
    this.setState('sleeping', {}, true);
  }

  /** Direct write access to the continuous inputs. */
  setInput(patch: Partial<AvatarInput>): void {
    Object.assign(this.input, patch);
  }

  /**
   * Advance one frame.
   *
   * Order matters and mirrors the reference projects:
   *   1. smooth the continuous inputs (nothing downstream sees a step)
   *   2. run the behaviour controllers (they read the smoothed inputs)
   *   3. resolve the target pose for the current state
   *   4. blend current -> target
   *   5. layer the additive behaviours (blink, gaze, ambient)
   *
   * There is no clock parameter on purpose: the caller owns time, and the
   * engine only ever sees a delta. That is what lets the same code run off a
   * browser rAF and an ESP32 FreeRTOS tick.
   */
  step(dt: number): void {
    // A monotonic millisecond clock for the touch recogniser, derived from the
    // deltas the caller supplies. Kept internal so the core never reads a real
    // clock — the StopWatch supplies its own ticks and gets the same result.
    this.nowMs += dt * 1000;
    this.touchTick();
    this.stateElapsed += dt;
    this.sinceEngaged += dt;
    if (this.emphasis > 0) this.emphasis = Math.max(0, this.emphasis - dt * 1.6);

    // ── 1. Smooth the continuous inputs ─────────────────────────────────
    // A slider is a step function; the avatar must never see one.
    this.input.attention = this.attentionSpring.step(clamp01(this.input.attention), dt);
    this.input.activity = this.activitySpring.step(clamp01(this.input.activity), dt);
    this.input.urgency = this.urgencySpring.step(clamp01(this.input.urgency), dt);
    const lookX = this.lookXSpring.step(clamp(this.input.lookX, -1, 1), dt);
    const lookY = this.lookYSpring.step(clamp(this.input.lookY, -1, 1), dt);
    this.input.progress = this.progressSpring.step(clamp01(this.input.progress), dt);

    // ── 2. Behaviour controllers ────────────────────────────────────────
    const rawAudio = clamp01(this.input.audioLevel);
    const isSpeaking = this.state === 'speaking';
    const isListening = this.state === 'listening';

    // AURA's synthetic floor keeps the orb breathing in near-silence; it is
    // only meaningful for the reactive states.
    this.listen.step(dt, rawAudio, isListening);
    this.mouth.step(dt, rawAudio, isSpeaking);
    const envelope = isSpeaking ? this.mouth.envelope : isListening ? this.listen.envelope : 0;
    this.signals.audioEnvelope = envelope;
    this.signals.mouthLevel = this.mouth.level;
    this.signals.syntheticPulse = isListening && rawAudio < 0.04 ? this.listen.envelope : 0;

    this.signals.stateTime = this.stateElapsed;

    // Idle gestures (blink cadence, gaze gestures, micro-reactions) are
    // allowed only when the character is not actively engaged. This is
    // AURA's single shared `canDoIdleGesture()` predicate, kept in one place
    // so the three controllers can never disagree.
    const idleGestures = this.canDoIdleGesture();

    // Blink: always steps (so a blink can finish cleanly), but the cadence
    // band changes with state.
    this.signals.blink = this.blink.step(dt, this.state, this.sinceEngaged < REENGAGE_WINDOW);

    // The gaze controller smooths its own output; we feed it the *unsmoothed*
    // pointer value plus the smoothed lookX/lookY slider bias, so a slider
    // and a mouse can drive it simultaneously without double-smoothing.
    this.applyGazeSource(lookX, lookY);
    const gaze = this.gaze.step(dt, this.state, this.input.attention, idleGestures);

    // The body consumes the gaze output, because the lean follows the eyes.
    this.body.step(dt, this.state, gaze.x, gaze.y, this.input.activity, !this.blender.done);

    this.ambient.step(dt, this.state, this.input.activity, !this.blender.done || this.state === 'waiting_approval');
    this.signals.ambientDriftX = this.ambient.driftX;
    this.signals.ambientDriftY = this.ambient.driftY;
    this.signals.ambientSquash = (this.ambient.squashX + this.ambient.squashY) * 0.5;

    // ── 3. Resolve the target pose ──────────────────────────────────────
    // The BLEND targets the state's fixed pose only. Continuous modulation is
    // added *after* the blend (step 5) rather than blended into it.
    //
    // This ordering is load-bearing and was wrong in an earlier revision:
    // feeding a per-frame-changing wave into `setTarget` re-triggered the
    // transition on every frame, so the pose never converged and state changes
    // read as mush instead of as authored moves.
    const spec = specFor(this.state);
    this.targetPose = spec.pose;

    // ── 4. Blend ────────────────────────────────────────────────────────
    // Re-targeting every frame is safe: PoseBlender.setTarget is a no-op when
    // the pose is unchanged, so this only fires on a real state change.
    this.blender.setTarget(spec.pose, { duration: spec.enter.duration, easing: spec.enter.easing });
    const blended = this.blender.step(dt);

    // ── 5. Additive behaviour layers ────────────────────────────────────
    // Live motion on top of the settled pose: the state's own modulation, then
    // blink, gaze, and the whole-body springs.
    const level = isSpeaking ? this.signals.mouthLevel : envelope;
    const modulation = spec.modulate ? spec.modulate(spec.pose, this.input, this.stateElapsed, level) : {};
    const modulated = addPose(blended, modulation, 1);

    // Blink is applied multiplicatively to eyeOpen (it *is* the eyelid).
    const blink = this.signals.blink;
    modulated.eyeOpen = modulated.eyeOpen * (1 - blink);

    // Gaze: the controller's springed output plus the ambient micro-glance.
    // These drive WHERE THE EYES SIT ON THE FACE, which is the channel that
    // carries almost all of the perceived liveliness.
    //
    // NOTE: these write into `modulated`, the pose that actually ships. Writing
    // them into `blended` (the pre-modulation snapshot) silently discarded the
    // whole gaze channel — the eyes moved but the published pose always read
    // eyeOffsetY 0, which the verification harness caught.
    modulated.eyeOffsetX = clamp(gaze.x + this.ambient.glanceX, -1, 1);
    modulated.eyeOffsetY = clamp(gaze.y + this.ambient.glanceY, -1, 1);
    this.signals.lastSaccade = this.gaze.lastSaccade;

    // Whole-body motion. Applied AFTER the state/ambient layers so the head
    // motion is authoritative: this is the layer that makes the orb a
    // creature rather than a badge with eyes on it.
    modulated.bodyRotation = this.body.rotation;
    modulated.bodyX = this.body.x;
    modulated.bodyY = this.body.y;
    modulated.bodyScaleX = this.body.scaleX;
    modulated.bodyScaleY = this.body.scaleY;

    // Head turn: drives the sphere projection, so the eyes travel on a curve
    // and scale with depth rather than sliding across a flat disc.
    modulated.headYaw = this.body.yaw;
    modulated.headPitch = this.body.pitch;

    // ── Gestures ────────────────────────────────────────────────────────
    // Two passes, because motion and shape compose differently:
    //
    //   1. `pose` — additive deltas. A nod displaces the head; a glance
    //      offsets the eyes. These layer on top of the state.
    //   2. `set`  — absolute overrides blended in by `setWeight`. A laugh does
    //      not "add squint" to whatever the state had; it *makes* the eyes
    //      squint. Without this, LAUGH/HEART/PEEK all rendered with round eyes,
    //      because a delta added to IDLE's tall baseline stayed tall.
    const gesture = this.gestures.step(dt, this.blender.done);
    for (const key of Object.keys(gesture.pose) as (keyof AvatarPose)[]) {
      const delta = gesture.pose[key];
      if (delta !== undefined) modulated[key] += delta;
    }
    if (gesture.set) {
      const w = clamp01(gesture.setWeight ?? 0);
      for (const key of Object.keys(gesture.set) as (keyof AvatarPose)[]) {
        const target = gesture.set[key];
        if (target === undefined) continue;
        // Ease toward the override so the shape transition is continuous
        // rather than a jump on the gesture's first frame.
        modulated[key] = modulated[key] + (target - modulated[key]) * w;
      }
    }
    this.signals.gestureZzz = gesture.zzz;
    this.signals.gesture = this.gestures.label ?? '';

    // A one-shot emphasis (approval pulse / manual poke) briefly swells the
    // capsules — the visual equivalent of a sharp intake of breath.
    if (this.emphasis > 0) {
      const e = this.emphasis * this.emphasis;
      modulated.eyeSize += e * 0.09;
      modulated.orbDeform += e * 0.5;
    }

    this.pose = modulated;
  }

  /**
   * Feed the gaze controller.
   *
   * The pointer source and the Look X/Y sliders are INDEPENDENT inputs and
   * must not overwrite each other. An earlier revision called
   * `pointerSource.set(lookX, lookY)` every frame, which meant the mouse
   * position was clobbered 60 times a second and pointer tracking never
   * worked. Instead the sliders become a *bias* added by the gaze controller,
   * and the pointer stays authoritative.
   */
  private applyGazeSource(biasX: number, biasY: number): void {
    this.gaze.setBias(biasX, biasY);
  }

  /**
   * AURA's shared idle-gesture predicate, ported as one function so blink,
   * gaze and ambient can never disagree about whether idle behaviour is
   * permitted.
   */
  private canDoIdleGesture(): boolean {
    if (this.state === 'sleeping') return false;
    // AURA's gate requires phase == idle; we additionally allow THINKING to
    // keep a slow gaze drift, because a thinking avatar that stares fixedly
    // looks broken rather than focused.
    if (this.state === 'thinking') return true;
    return this.state === 'idle';
  }

  /** Read-only snapshot for the Lab's debug panel and the test harness. */
  snapshot() {
    return {
      state: this.state,
      stateTime: this.stateElapsed,
      pose: { ...this.pose },
      signals: { ...this.signals },
      input: { ...this.input },
      gazeSource: this.gazeSource.kind,
      lastGesture: this.gaze.lastGesture,
      lastReaction: this.ambient.lastReaction,
      lastMove: this.body.lastMove,
      gesture: this.gestures.label,
      gestureHistory: [...this.gestures.history],
      emphasis: this.emphasis,
    };
  }

  /** Restore to a clean idle state — used when restarting a demo run. */
  reset(seed = 0x5eed1234): void {
    this.rng.reset(seed);
    this.blender.snap(NEUTRAL_POSE);
    this.state = 'idle';
    this.context = {};
    this.stateElapsed = 0;
    this.sinceEngaged = Infinity;
    this.emphasis = 0;
    this.mouth.reset();
    this.listen.reset();
    this.gestures.stop();
    this.blink.value = 0;
    this.gaze.x = 0;
    this.gaze.y = 0;
    this.pose = { ...NEUTRAL_POSE };
    this.targetPose = { ...NEUTRAL_POSE };
  }
}

/** Local clamp that accepts arbitrary bounds (params.clamp is 0..1 only). */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export { PointerGazeSource, TargetGazeSource };
export type { GazeSource };
