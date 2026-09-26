/**
 * AvatarLab.tsx — the interactive laboratory page.
 *
 * Layout mirrors the brief:
 *   - the avatar inside a 466×466 round device frame (same as the StopWatch)
 *   - state buttons for all ten states
 *   - continuous sliders (attention / activity / urgency / audio / look X / look Y)
 *   - an Auto Demo toggle
 *   - a "Run Assistant Demo" that plays the full scenario
 *   - a live debug panel reading the engine's actual pose values
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AvatarEngine } from '../core/behavior';
import { NEUTRAL_POSE } from '../core/params';
import { CanvasAvatarRenderer } from '../renderer/web/canvasRenderer';
import * as sphereMath from '../core/sphere';
import { GESTURE_KINDS, type GestureKind } from '../behaviors/gestures';
import { ASSISTANT_STATES, type AssistantState } from '../core/state';
import { STATE_SPECS } from '../core/states';
import {
  SCENARIOS,
  ScenarioRunner,
  assistantRun,
  autoDemo,
  type Beat,
} from '../core/scenario';
import { AssistantAvatar } from './AssistantAvatar';
import { DeviceFrame } from './DeviceFrame';
import styles from './AvatarLab.module.css';

/** Slider definitions — mirrors the brief's required control set exactly. */
const SLIDERS = [
  { key: 'attention', label: 'Attention', hint: 'How much of your attention it believes it has' },
  { key: 'activity', label: 'Activity', hint: 'General energy: raises cadence and deformation' },
  { key: 'urgency', label: 'Urgency', hint: 'How much this moment matters' },
  { key: 'audioLevel', label: 'Audio Level', hint: 'Simulated microphone / TTS amplitude' },
  { key: 'lookX', label: 'Look X', hint: 'Gaze bias — the seam that becomes BMI270 tilt' },
  { key: 'lookY', label: 'Look Y', hint: 'Gaze bias — the seam that becomes BMI270 tilt' },
] as const;

type SliderKey = (typeof SLIDERS)[number]['key'];

/** Human labels + one-line descriptions of what each state should feel like. */
const STATE_NOTES: Record<AssistantState, string> = {
  idle: "I'm here.",
  listening: "I'm listening to you.",
  thinking: "I'm reasoning.",
  working: "I've started doing it.",
  speaking: "I'm talking to you.",
  waiting_input: "I'm waiting for you.",
  waiting_approval: 'I need your decision.',
  success: 'Done — that went well.',
  error: "That didn't work.",
  sleeping: "I'm resting, but I'm still here.",
};

/** Display labels for the gesture buttons. */
const GESTURE_LABELS: Record<GestureKind, string> = {
  wink: 'Wink',
  nod: 'Nod',
  shake: 'Shake',
  laugh: 'Laugh',
  peek: 'Peek',
  dizzy: 'Dizzy',
  sneeze: 'Sneeze',
  heart: 'Heart',
  sing: 'Sing',
  zzz: 'Zzz',
};

export interface AvatarLabProps {
  /** Optional class so the host page can size the lab. */
  className?: string;
}

export function AvatarLab({ className }: AvatarLabProps) {
  // One engine for the lifetime of the page. Seeded so a demo replay is
  // reproducible — essential when comparing against a future C++ build.
  const engine = useMemo(() => new AvatarEngine({ seed: 0x5eed1234 }), []);

  const [state, setState] = useState<AssistantState>('idle');
  const [sliders, setSliders] = useState<Record<SliderKey, number>>(() => {
    const init = {} as Record<SliderKey, number>;
    for (const s of SLIDERS) {
      init[s.key] =
        s.key === 'lookX' || s.key === 'lookY'
          ? 0
          : s.key === 'attention'
            ? 0.35
            : s.key === 'activity'
              ? 0.25
              : s.key === 'urgency'
                ? 0.1
                : 0;
    }
    return init;
  });
  const [fps, setFps] = useState(60);
  const [runningScenario, setRunningScenario] = useState<string | null>(null);
  const [beat, setBeat] = useState<Beat | null>(null);
  const [progress, setProgress] = useState(0);
  const [showDebug, setShowDebug] = useState(true);
  const [autoBlink, setAutoBlink] = useState(true);
  // Gestures are transient, so they are polled rather than pushed: the engine
  // owns their lifetime and the UI only mirrors it.
  const [activeGesture, setActiveGesture] = useState<GestureKind | null>(null);
  const [gestureHistory, setGestureHistory] = useState<string[]>([]);
  // The last recognised interaction, shown so touch behaviour is observable
  // without watching the avatar.
  const [lastIntent, setLastIntent] = useState<string>('—');
  const [dragRange, setDragRange] = useState(0.9);
  const [longPressMs, setLongPressMs] = useState(520);

  const runnerRef = useRef<ScenarioRunner | null>(null);

  // Expose the live engine for the console and the verification harness. The
  // Lab exists to be poked at; hiding the engine would only make that harder.
  useEffect(() => {
    const w = window as unknown as {
      __avatarEngine?: AvatarEngine;
      __avatarRenderer?: typeof CanvasAvatarRenderer;
      __avatarPose?: typeof NEUTRAL_POSE;
      __avatarSphere?: typeof sphereMath;
    };
    w.__avatarEngine = engine;
    // The renderer class and the neutral pose are exposed too, so the geometry
    // can be swept from the console or a test harness without the state machine
    // overwriting the pose between frames.
    w.__avatarRenderer = CanvasAvatarRenderer;
    w.__avatarPose = NEUTRAL_POSE;
    w.__avatarSphere = sphereMath;
    return () => {
      delete w.__avatarEngine;
      delete w.__avatarRenderer;
      delete w.__avatarPose;
      delete w.__avatarSphere;
    };
  }, [engine]);

  // ── Engine <-> UI wiring ──────────────────────────────────────────────
  // The engine is the source of truth for `state`; React mirrors it so the
  // buttons can highlight. This one-way flow is why the state machine can
  // never get stuck inside a component.
  useEffect(() => {
    const off = engine.onStateChange((next) => setState(next));
    return () => {
      off();
    };
  }, [engine]);

  // Push slider values into the engine every time they change.
  useEffect(() => {
    engine.setInput({
      attention: sliders.attention,
      activity: sliders.activity,
      urgency: sliders.urgency,
      audioLevel: sliders.audioLevel,
      lookX: sliders.lookX,
      lookY: sliders.lookY,
    });
  }, [engine, sliders]);

  // ── Scenario runner ───────────────────────────────────────────────────
  // The runner is driven from the same rAF cadence as the avatar, but it is
  // simpler and safer to pump it from a light interval: a scenario beat is
  // seconds long, so 50 ms of resolution is invisible, and it keeps the
  // runner entirely out of the render loop's hot path.
  const host = useMemo(
    () => ({
      setState: (next: AssistantState, context = {}, force = false) => engine.setState(next, context, force),
      setInput: (patch: Record<string, number | boolean>) => {
        engine.setInput(patch as never);
        // Reflect scenario-driven inputs back into the sliders so the UI
        // always shows what the avatar is actually being fed.
        setSliders((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const key of Object.keys(patch)) {
            if ((SLIDERS as readonly { key: string }[]).some((s) => s.key === key)) {
              const v = patch[key];
              if (typeof v === 'number' && Math.abs(next[key as SliderKey] - v) > 0.001) {
                next[key as SliderKey] = v;
                changed = true;
              }
            }
          }
          return changed ? next : prev;
        });
      },
      pulse: () => engine.pulse(),
      blinkTrigger: () => engine.blink.trigger(),
    }),
    [engine],
  );

  // Surface every recognised intent so the interaction vocabulary is visible.
  useEffect(() => {
    return engine.onIntent((intent) => {
      setLastIntent(intent.kind === 'swipe' ? `swipe ${intent.dir}` : intent.kind);
    });
  }, [engine]);

  // Push the drag range into the engine as it changes.
  useEffect(() => {
    engine.setTouchTuning({ dragTurnRange: dragRange });
  }, [engine, dragRange]);

  // Poll the gesture controller on a light interval — a gesture lasts under two
  // seconds and the button highlight does not need frame accuracy.
  useEffect(() => {
    const id = window.setInterval(() => {
      setActiveGesture(engine.gestures.current);
      setGestureHistory((prev) => {
        const next = engine.gestures.history.slice(0, 4);
        return prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next;
      });
    }, 120);
    return () => window.clearInterval(id);
  }, [engine]);

  const stopScenario = useCallback(() => {
    runnerRef.current?.stop();
    runnerRef.current = null;
    setRunningScenario(null);
    setBeat(null);
    setProgress(0);
  }, []);

  const startScenario = useCallback(
    (id: string) => {
      const scenario = SCENARIOS.find((s) => s.id === id);
      if (!scenario) return;
      engine.reset();
      engine.setState('idle', {}, true);
      const runner = new ScenarioRunner(host);
      runnerRef.current = runner;
      runner.start(scenario, {
        attention: 0.35,
        activity: 0.25,
        urgency: 0.1,
        audioLevel: 0,
        lookX: 0,
        lookY: 0,
        progress: 0,
      });
      setRunningScenario(id);
      setBeat(runner.current);
      setProgress(0);
    },
    [engine, host],
  );

  useEffect(() => {
    if (!runningScenario) return;
    const id = window.setInterval(() => {
      const runner = runnerRef.current;
      if (!runner) return;
      const live = {
        attention: engine.input.attention,
        activity: engine.input.activity,
        urgency: engine.input.urgency,
        audioLevel: engine.input.audioLevel,
        lookX: engine.input.lookX,
        lookY: engine.input.lookY,
        progress: engine.input.progress,
      };
      const stillRunning = runner.step(0.05, live);
      setBeat(runner.current);
      setProgress(runner.progress);
      if (!stillRunning) {
        window.clearInterval(id);
        setRunningScenario(null);
        setBeat(null);
      }
    }, 50);
    return () => window.clearInterval(id);
  }, [runningScenario, engine]);

  // Space bar triggers a manual blink — a small affordance that makes the
  // blink controller easy to evaluate in isolation.
  useEffect(() => {
    if (!autoBlink) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault();
        engine.blink.trigger();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine, autoBlink]);

  const selectState = useCallback(
    (next: AssistantState) => {
      stopScenario();
      engine.setState(next, {}, true);
      // Selecting SLEEPING by hand should feel like falling asleep, and
      // selecting anything else should wake it — the same interaction the
      // brief specifies for clicking the avatar.
      if (next !== 'sleeping') engine.blink.reseedShort();
    },
    [engine, stopScenario],
  );

  // NOTE: there is deliberately no click handler on the avatar wrapper any
  // more. Tap and long-press are recognised by the engine's touch layer, so a
  // DOM click handler would fire a SECOND action for the same gesture.

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Avatar Lab</h1>
          <p className={styles.subtitle}>
            Personal Assistant Avatar Engine — procedural, renderer-agnostic, ported-ready.
          </p>
        </div>
        <div className={styles.headerMeta}>
          <span className={styles.badge}>466 × 466 round</span>
          <span className={styles.fps}>{fps.toFixed(0)} fps</span>
        </div>
      </header>

      <div className={styles.layout}>
        {/* ── Left: the device ─────────────────────────────────────── */}
        <section className={styles.stage}>
          {/* Clicking the avatar is the interaction the brief specifies:
              blink while awake, wake while asleep. `role="button"` + keyboard
              handling keep it reachable without a pointer. */}
          <div className={styles.clickTarget}>
            <DeviceFrame size={466}>
              <AssistantAvatar engine={engine} size={466} onFps={setFps} />
            </DeviceFrame>
          </div>

          <div className={styles.stageCaption}>
            <div className={styles.stateName}>{state}</div>
            <div className={styles.stateNote}>{STATE_NOTES[state]}</div>
            {engine.context.label ? <div className={styles.contextLabel}>{engine.context.label}</div> : null}
            <div className={styles.stageHint}>
              <strong>Drag the ball</strong> to turn its head · tap to blink · double-tap to wink ·
              long-press to sleep · swipe for a glance
            </div>
          </div>
        </section>

        {/* ── Right: controls ──────────────────────────────────────── */}
        <section className={styles.controls}>
          {/* State buttons */}
          <div className={styles.panel}>
            <div className={styles.panelTitle}>State</div>
            <div className={styles.stateGrid}>
              {ASSISTANT_STATES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`${styles.stateButton} ${state === s ? styles.stateButtonActive : ''}`}
                  onClick={() => selectState(s)}
                  title={STATE_SPECS[s].note}
                >
                  {s.replace(/_/g, ' ')}
                </button>
              ))}
            </div>
          </div>

          {/* Continuous parameters */}
          <div className={styles.panel}>
            <div className={styles.panelTitle}>Continuous Parameters</div>
            {SLIDERS.map((s) => (
              <label key={s.key} className={styles.sliderRow} title={s.hint}>
                <span className={styles.sliderLabel}>{s.label}</span>
                <input
                  type="range"
                  min={s.key === 'lookX' || s.key === 'lookY' ? -1 : 0}
                  max={1}
                  step={0.01}
                  value={sliders[s.key]}
                  onChange={(e) => {
                    stopScenario();
                    setSliders((prev) => ({ ...prev, [s.key]: Number(e.target.value) }));
                  }}
                  className={styles.slider}
                />
                <span className={styles.sliderValue}>{sliders[s.key].toFixed(2)}</span>
              </label>
            ))}
          </div>

          {/* Scenarios */}
          <div className={styles.panel}>
            <div className={styles.panelTitle}>Scenarios</div>
            <div className={styles.scenarioRow}>
              <button
                type="button"
                className={`${styles.scenarioButton} ${runningScenario === autoDemo.id ? styles.scenarioActive : ''}`}
                onClick={() => (runningScenario === autoDemo.id ? stopScenario() : startScenario(autoDemo.id))}
              >
                {runningScenario === autoDemo.id ? 'Stop Auto Demo' : 'Auto Demo'}
              </button>
              <button
                type="button"
                className={`${styles.scenarioButton} ${styles.scenarioPrimary} ${
                  runningScenario === assistantRun.id ? styles.scenarioActive : ''
                }`}
                onClick={() =>
                  runningScenario === assistantRun.id ? stopScenario() : startScenario(assistantRun.id)
                }
              >
                {runningScenario === assistantRun.id ? 'Stop Assistant Demo' : 'Run Assistant Demo'}
              </button>
            </div>

            {runningScenario ? (
              <div className={styles.progressWrap}>
                <div className={styles.progressBar}>
                  <div className={styles.progressFill} style={{ width: `${progress * 100}%` }} />
                </div>
                <div className={styles.beatCaption}>
                  {beat?.caption ? (
                    <>
                      {beat.speaker === 'user' ? <span className={styles.speakerUser}>You</span> : null}
                      {beat.speaker === 'assistant' ? (
                        <span className={styles.speakerAssistant}>Assistant</span>
                      ) : null}
                      <span>{beat.caption}</span>
                    </>
                  ) : (
                    'Finishing…'
                  )}
                </div>
              </div>
            ) : (
              <div className={styles.scenarioHint}>
                Run Assistant Demo plays the full “check my email” story end to end.
              </div>
            )}
          </div>

          {/* Touch interaction */}
          <div className={styles.panel}>
            <div className={styles.panelTitle}>Touch Interaction</div>
            <div className={styles.scenarioHint} style={{ marginTop: 0 }}>
              <strong>Drag the ball</strong> to turn its head · <strong>tap</strong> to blink ·{' '}
              <strong>double-tap</strong> to wink · <strong>long-press</strong> to sleep ·{' '}
              <strong>swipe</strong> for a glance or to nudge activity.
            </div>
            <label className={styles.sliderRow} title="How far a full-width drag turns the head">
              <span className={styles.sliderLabel}>Drag Turn</span>
              <input
                type="range"
                min={0.3}
                max={1.3}
                step={0.01}
                value={dragRange}
                onChange={(e) => setDragRange(Number(e.target.value))}
                className={styles.slider}
              />
              <span className={styles.sliderValue}>{dragRange.toFixed(2)}</span>
            </label>
            <label className={styles.sliderRow} title="How long a press must last to toggle sleep">
              <span className={styles.sliderLabel}>Long Press</span>
              <input
                type="range"
                min={300}
                max={1200}
                step={10}
                value={longPressMs}
                onChange={(e) => {
                  setLongPressMs(Number(e.target.value));
                  engine.setTouchTuning({ longPressMs: Number(e.target.value) });
                }}
                className={styles.slider}
              />
              <span className={styles.sliderValue}>{(longPressMs / 1000).toFixed(2)}s</span>
            </label>
            <div className={styles.behaviourRow}>
              <span className={styles.behaviourTag}>last input: {lastIntent}</span>
            </div>
          </div>

          {/* Gestures — what the avatar DOES, independent of what it IS */}
          <div className={styles.panel}>
            <div className={styles.panelTitle}>Gestures</div>
            <div className={styles.stateGrid}>
              {GESTURE_KINDS.map((g) => (
                <button
                  key={g}
                  type="button"
                  className={`${styles.stateButton} ${activeGesture === g ? styles.stateButtonActive : ''}`}
                  onClick={() => engine.gesture(g)}
                  title={`Play the "${g}" gesture`}
                >
                  {GESTURE_LABELS[g]}
                </button>
              ))}
            </div>
            <div className={styles.scenarioRow} style={{ marginTop: 10 }}>
              <button type="button" className={styles.ghostButton} onClick={() => engine.blink.trigger()}>
                Blink
              </button>
              <button type="button" className={styles.ghostButton} onClick={() => engine.gaze.poke()}>
                Glance
              </button>
              <button type="button" className={styles.ghostButton} onClick={() => engine.ambient.poke()}>
                Micro-reaction
              </button>
              <button type="button" className={styles.ghostButton} onClick={() => engine.pulse()}>
                Pulse
              </button>
            </div>
            <div className={styles.behaviourRow}>
              <span className={styles.behaviourTag}>now: {activeGesture ?? '—'}</span>
              <span className={styles.behaviourTag}>recent: {gestureHistory.join(' › ') || '—'}</span>
            </div>
            <label className={styles.toggleRow}>
              <input type="checkbox" checked={autoBlink} onChange={(e) => setAutoBlink(e.target.checked)} />
              <span>Space bar triggers a blink</span>
            </label>
            <label className={styles.toggleRow}>
              <input type="checkbox" checked={showDebug} onChange={(e) => setShowDebug(e.target.checked)} />
              <span>Show live pose values</span>
            </label>
          </div>
        </section>
      </div>

      {/* ── Debug + documentation ─────────────────────────────────── */}
      {showDebug ? <DebugPanel engine={engine} /> : null}
    </div>
  );
}

/**
 * Live readout of the engine's actual pose.
 *
 * This exists because the brief's real goal is to *evaluate* the animation
 * language: seeing `orbDeform` move while `eyeOpen` stays put is how you tell
 * whether a state is actually doing something distinct.
 */
function DebugPanel({ engine }: { engine: AvatarEngine }) {
  const [snap, setSnap] = useState(() => engine.snapshot());
  const [openSpec, setOpenSpec] = useState<AssistantState | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setSnap(engine.snapshot()), 100);
    return () => window.clearInterval(id);
  }, [engine]);

  const groups = useMemo(
    () => [
      {
        name: 'Eyes — shape',
        keys: ['eyeOpen', 'eyeOpenL', 'eyeOpenR', 'eyeRound', 'eyeRoundL', 'eyeRoundR', 'eyeSize', 'eyeBowL', 'eyeBowR'],
      },
      {
        name: 'Eyes — placement',
        keys: ['eyeOffsetX', 'eyeOffsetY', 'eyeDistance', 'eyeLiftL', 'eyeLiftR', 'eyeTiltL', 'eyeTiltR'],
      },
      {
        name: 'Brows (opt-in)',
        keys: ['browOpen', 'browTiltL', 'browTiltR', 'browLiftL', 'browLiftR'],
      },
      {
        name: 'Body — head motion',
        keys: ['bodyRotation', 'bodyX', 'bodyY', 'bodyScaleX', 'bodyScaleY'],
      },
      { name: 'Sphere', keys: ['orbScaleX', 'orbScaleY', 'orbDeform'] },
      { name: 'Gesture (live)', keys: ['gestureZzz'], fromSignals: true },
    ],
    [],
  );

  return (
    <section className={styles.debug}>
      <div className={styles.debugColumn}>
        <div className={styles.panelTitle}>Live Pose</div>
        <div className={styles.debugGrid}>
          {groups.map((g) => (
            <div key={g.name} className={styles.debugGroup}>
              <div className={styles.debugGroupName}>{g.name}</div>
              {g.keys.map((k) => {
                // Signal-backed groups read from `signals`; everything else is a
                // pose channel. Reading a signal out of `pose` silently showed 0.
                const source = (g as { fromSignals?: boolean }).fromSignals
                  ? (snap.signals as unknown as Record<string, number>)
                  : (snap.pose as unknown as Record<string, number>);
                const v = source[k] ?? 0;
                return (
                  <div key={k} className={styles.debugRow}>
                    <span className={styles.debugKey}>{k}</span>
                    <span className={styles.debugBar}>
                      {/* Normalised around 1.0 by 0.5 so orb scales near 1 read centred. */}
                      <span
                        className={styles.debugBarFill}
                        style={{ width: `${Math.min(100, Math.abs(v) * 100)}%` }}
                      />
                    </span>
                    <span className={styles.debugValue}>{v.toFixed(3)}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className={styles.debugColumn}>
        <div className={styles.panelTitle}>Signals &amp; Behaviours</div>
        <div className={styles.debugGroup}>
          {(
            [
              ['audioEnvelope', snap.signals.audioEnvelope],
              ['mouthLevel', snap.signals.mouthLevel],
              ['blink', snap.signals.blink],
              ['ambientDriftX', snap.signals.ambientDriftX],
              ['ambientDriftY', snap.signals.ambientDriftY],
              ['syntheticPulse', snap.signals.syntheticPulse],
              ['stateTime', snap.stateTime],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className={styles.debugRow}>
              <span className={styles.debugKey}>{k}</span>
              <span className={styles.debugBar}>
                <span className={styles.debugBarFill} style={{ width: `${Math.min(100, Math.abs(v) * 100)}%` }} />
              </span>
              <span className={styles.debugValue}>{v.toFixed(3)}</span>
            </div>
          ))}
        </div>

        <div className={styles.behaviourRow}>
          <span className={styles.behaviourTag}>gaze: {snap.gazeSource}</span>
          <span className={styles.behaviourTag}>last gesture: {snap.lastGesture || '—'}</span>
          <span className={styles.behaviourTag}>last micro-reaction: {snap.lastReaction || '—'}</span>
          <span className={styles.behaviourTag}>last body move: {snap.lastMove || '—'}</span>
        </div>

        {/* The state spec table, rendered straight from the engine's data. */}
        <div className={styles.panelTitle} style={{ marginTop: 18 }}>
          State Pose Specs
        </div>
        <div className={styles.specList}>
          {ASSISTANT_STATES.map((s) => (
            <button
              key={s}
              type="button"
              className={`${styles.specRow} ${openSpec === s ? styles.specRowOpen : ''}`}
              onClick={() => setOpenSpec(openSpec === s ? null : s)}
            >
              <span className={styles.specName}>{s}</span>
              <span className={styles.specNote}>{STATE_SPECS[s].note}</span>
              {openSpec === s ? (
                <span className={styles.specDetail}>
                  enter {STATE_SPECS[s].enter.duration}s · {STATE_SPECS[s].enter.easing} · exit{' '}
                  {STATE_SPECS[s].exit}s
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
