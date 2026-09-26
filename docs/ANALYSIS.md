# Reference Project Analysis

Three projects were read in full — sources, not screenshots — before any code was
written. This document records what each actually contains, what was taken, and
what was deliberately rejected.

Line counts read: KK 2 724 lines (C++ + docs), Grok Orb 2 083 lines (TS/TSX),
AURA 7 344 lines (ESPHome YAML + README).

---

## 1. KK — `Trentct/m5stack-stopwatch-avatar`

**What it is.** A procedural avatar firmware for the M5Stack StopWatch: a
466×466 round AMOLED driven by an ESP32-S3 at a 60 fps target, drawing eyes,
eyelids, brows, keyframes and transitions in real time with no image-frame
animation. Licence: **AGPL-3.0**.

### 1.1 Expression system

Expressions are not keyframe tables and not parameter sets — they are
**procedural draw routines selected by an enum**. Each expression is a function
that computes eyelid aperture, brow angle, pupil offset and mouth curvature from
its own constants; there is no shared parameter vector to interpolate. This
matters for the port: KK's expression system is *code*, ours is *data*.

### 1.2 Timeline / animation scheduling

A fixed-cadence render tick. One-shot reactions are implemented as
scripted sequences of frame writes with `delay()` steps rather than as a
declarative timeline; looping motion is a `millis()`-driven phase accumulator.

### 1.3 Easing

KK carries a **hand-written easing table** rather than a generic cubic-bezier
solver. The stated reason is arithmetic budget on a 240 MHz MCU: named
closed-form functions (`sineInOut`, `cubicOut`, `backOut`, …) cost a `sinf` or a
`powf`, whereas a bezier solver costs an iteration loop per frame.

**Taken.** The whole vocabulary, reimplemented as `src/avatar/core/easing.ts`,
including the "closed-form only, no bezier solver" rule. This is the single most
directly portable idea in the project.

### 1.4 Procedural animation

Breathing is a long-period scale oscillation; idle motion is layered sine waves.
Amplitudes are small (well under 5% of the radius) and periods are long (multiple
seconds) — the explicit design goal being *never fully still* without ever being
busy.

**Taken.** Directly, in `states.ts` (`idle.modulate`) and `behaviors/ambient.ts`.

### 1.5 State machine and transitions

A discrete expression enum with **crossfade transitions of a fixed duration
driven by a named easing**. There is no spring integration anywhere.

**Taken.** `PoseBlender` in `core/transitions.ts` implements exactly this. We
*add* a spring (`Spring`) for continuous input channels, because a crossfade has
no notion of inertia and the gaze channel needs it.

### 1.6 Eye movement / gaze

Eyes are driven by touch and IMU input with limits, plus a gyro feed-forward
term. No random saccade model.

**Partially taken.** The *interface shape* (a normalised look vector feeding the
eye renderer) is ours; the IMU math is deferred to the StopWatch phase.

### 1.7 Blink

Present and procedural, but less developed than AURA's.

**Rejected in favour of AURA**, which has the more complete model (cadence
reseeding, double-blink probability).

### 1.8 Touch / IMU interaction

Tap, double-tap, long-press, drag-follow, and swipe gestures; tilt maps to screen
coordinates with a gyro feed-forward term; shake counting triggers a `DIZZY`
state.

**Noted for the migration phase.** The `GazeSource` interface in
`behaviors/gaze.ts` is deliberately the exact seam this will plug into.

### 1.9 Dirty rectangle / 60 FPS

This is KK's most valuable engineering contribution and it is a **hardware
constraint, not an animation idea**: a 466×466 16-bit PSRAM canvas plus
`pushSprite(0, 0)` costs about four frames' worth of budget, so the renderer
computes the union of changed regions and pushes only that.

**Rejected for the Web** (there is no transfer cost to avoid; a full Canvas 2D
redraw at 466 px is trivially fast) but **recorded as mandatory for the
StopWatch port** — see `docs/MIGRATION.md`.

### 1.10 Verification discipline

`docs/HARDWARE_BASELINE.md` separates *official specification*, *source
integration*, *successful compilation*, and *real-device verification* into
distinct evidence levels, and `AGENTS.md` forbids reporting device-verified
behaviour without having observed it on hardware.

**Taken as a documentation principle**, and mirrored in our
`docs/MIGRATION.md`: every claim is labelled with how it was verified.

### 1.11 Licence position

AGPL-3.0. **No KK code was copied.** What was taken is architecture and
mathematics — an easing vocabulary, a crossfade design, the "tiny amplitude, long
period" tuning rule. Those are ideas, and the file header of every module that
uses them says so. If KK code is ever reused directly in the StopWatch firmware,
that firmware inherits AGPL-3.0 and must be published accordingly.

---

## 2. Grok Bot Orb — `ngocdevv/grok-bot-emoji`

**What it is.** A React Native / Expo Skia orb with a path-based expression
system. Licence: MIT (as inherited from the Expo template it is built on).

### 2.1 Orb geometry

`GROK_BODY_PATH` is a **single authored SVG path that is a true circle** — a
228.5-unit diameter drawn as four cubic Béziers with the control-point
`k = 0.5523` (the standard circle approximation). It is scaled by
`(min(w,h) * 0.36) / 114.2705` and centred.

This is the finding that corrected our first implementation: we had built the
body as a `sin(3.1θ)`-modulated polar curve, which produced a visibly
three-lobed blob. Grok's orb is *round*, and all of its motion is elsewhere.

### 2.2 Rendering order — the body is WHITE, the eyes are DARK

The scene draws, in order: trails (back) → two white particle circles → the
white body path → a group **clipped to the body path** containing the two eye
paths filled `#1a1a1a` → trails (front).

So the eyes are **holes of near-black cut into a white disc**, not lights on a
dark orb. That inversion is the source of the look.

### 2.3 Eye shape — thin tapered strokes

`GROK_ORB_POSES` holds 25 authored poses, each defining a `left` and a `right`
path, and each eye path is built from two sub-paths (`UPPER` + `LOWER`). Measured
directly from the path data:

| Path | Bounding box | Area | Mean thickness | Aspect |
|---|---|---|---|---|
| `EYE_UPPER_LEFT` | 31.4 × 41.9 | 821.7 | 15.7 | ~3:1 |
| `EYE_LOWER_LEFT` | 37.0 × 47.7 | 883.9 | 14.7 | ~4:1 |

These are **long, thin, pointed lenses** — the "horizontal line" eyes. They are
rotated by ±0.46 rad (`leftEyeTransform`/`rightEyeTransform`) from an origin at
`(114.27, 92)`, i.e. above the body centre, and the pair is clipped to the body.

### 2.4 Eye / path morphing

Two independent morph systems:
- **Ambient two-state cycle** over `EYE_CYCLE_DURATION = 13.6 s`: morph up at
  3.35–4.15 s, hold, morph down at 9.25–10.05 s, both `smoothstep`-eased.
- **Expression pose morphing**: each expression names a sequence of pose indices
  (`focused: [8, 16, 14, 17, 5]`) with a per-expression cadence range from
  `GROK_ORB_EXPRESSION_TIMING_RANGES`; morph duration is
  `min(0.72, segment * 0.42)`, eased with `Easing.bezier(0.77, 0, 0.175, 1)`.
  `CADENCE_VARIATIONS = [0.18, 0.72, 0.42, 0.9, 0.58]` desynchronises the
  segments so the loop never feels metronomic.

Interpolation is `usePathInterpolation` over paths with matching point counts.

### 2.3 Expression system

`grok-orb-expressions.ts` is a table of named expressions, each a full set of
geometry/animation parameters (eye path selection, colour, glow, trail
behaviour). Expressions are **discrete named states**, closer to KK's enum than
to a continuous parameter space.

### 2.4 Elliptical trail

A ribbon parameterised by ellipse axes, rotation and phase, with a taper and an
opacity ramp along its length — an *authored ornament*, not a motion trail.

### 2.5 Glow

Layered strokes with blur, colour stops and additive blending.

### 2.6 Controlled expression API

A clean prop/handle surface: the outside world selects an expression by name and
the scene handles the transition. This is the project's best structural idea.

### 2.7 Trail and particles

`grok-orb-trails.tsx` renders two layers (front and back) driven by one shared
clock. The orbit is parameterised as an ellipse about
`(114.25, 106.25)` with `ORBIT_RADIUS_X = 148.45`, `ORBIT_RADIUS_Y = 56.45` and
`ORBIT_SPEED = 1.55096587` — a flattened ellipse that passes *behind* and *in
front of* the body. Two white particles ride it at `PARTICLE_MIN_RADIUS = 4.13`
± `3.37`, with opacity `0.685` ± `0.315`.

### 2.8 What we took

- **The controlled expression API idea** → our `AvatarEngine.setState()` plus the
  `StateContext` label channel. One call, no animation detail crossing the
  boundary.
- **The thin tapered stroke eye** — measured from the reference (3-4:1, pointed
  ends), reimplemented parametrically as `(1-u²)^0.85` thickness. This was the
  single largest correction to our visual language.
- **The round body** — Grok's orb is a true circle; ours now is too.
- **The orbital trail** — a tapered ribbon whose ellipse passes outside the body,
  with `trailIntensity / trailSpeed / trailTaper / trailDirectional` as controls.
- **Cadence desynchronisation** — `CADENCE_VARIATIONS` inspired the
  incommensurate frequencies in our `drawFilaments` and `ambient` drift.

### 2.9 What we deliberately rejected

- **The published vector paths and the 25 poses.** These are Grok's visual
  identity, and the brief explicitly forbids a 1:1 copy. Our eye is a closed-form
  parametric curve driven by `eyeOpen / eyeSquint / eyeScaleY / eyeTilt`, which
  is also the only version affordable on a 240 MHz MCU: a 25-pose path library
  needs all 25 shapes resident plus a per-vertex lerp, whereas ours needs four
  floats and a `powf`.
- **The white-body / dark-eye inversion.** It is Grok's signature and copying it
  would be exactly the 1:1 imitation the brief rules out. We keep a dark body and
  make the strokes *emissive*, which preserves our own identity while adopting
  the shape language.
- **Path morphing as the primary motion.** Morphing the *silhouette* is what
  makes an orb read as a "face shape" the moment the deformation gets large. Our
  renderer keeps the silhouette a circle and puts the fluid motion *inside* the
  sphere (see `drawFilaments`).
- **Any Grok colour, proportion or asset.**

---

## 3. AURA — `MarcoFre/AURA---ESP32-S3-1.85inch-Round-LCD-Development-Board`

**What it is.** A complete voice assistant on a 360×360 round LCD (ESPHome +
LVGL + Home Assistant). Licence: MIT. It is **not a visual reference** — it is a
*behaviour* reference, and by far the richest of the three.

### 3.1 State model

Seven voice-assistant phases (`idle 1`, `waiting 2`, `listening 3`, `thinking 4`,
`replying 5`, `not_ready 10`, `error 11`) plus a strict override ladder: timer
ringing outranks everything, an emotion override outranks auto-expression,
speaking outranks music.

**Taken.** `STATE_PRIORITY` in `core/state.ts` is the same idea with our own
vocabulary. The "settling states (`idle`, `sleeping`) are always honoured"
exception is ours — added because a Web avatar driven by real agent events needs
a way to return to rest that ambient noise cannot cancel.

### 3.2 Blink — the best model of the three

230 ms three-frame blink (70 / 90 / 70 ms), uniform-random 6–20 s interval, 20%
chance of a 320 ms double-blink. The detail that matters: **the interval is
reseeded to 2.5–6 s immediately after the character stops speaking, stops music,
or wakes.** Blinking sooner right after engagement is the highest
life-feel-per-line behaviour in the file.

**Taken verbatim** into `behaviors/blink.ts`, including the 70/90/70 shape, the
20% double-blink with its 120 ms gap, and the post-engagement reseed. We *add*
KK-style easing to the eyelid (closing faster than opening) because AURA hard-cuts
between frames and a symmetric blink reads as a camera shutter.

AURA's gate requires `phase == idle` for blinking at all. We relax that — a Web
avatar that cannot blink while thinking looks frozen — but keep the *cadence
bands* per state, which is the part that carries meaning.

### 3.3 Gaze

AURA has **no gaze model**: five fixed poses chosen from a weighted table every
18–45 s, with per-gesture hold times of 320–1300 ms. No saccades, no look-at
target, no spring.

**Taken as the idle-gesture table** (`behaviors/gaze.ts`), weights and hold times
preserved, but re-represented as gaze *offsets* rather than pre-rendered images.
**Added:** the spring, because the brief requires inertia and AURA simply has none.

### 3.4 Sleep / wake

6 s of inactivity → eyes-closed pose + `"Zzz..."` + a 32% dim veil + four rising
`z` glyphs on staggered 3.0/3.2/3.5/3.9 s cycles. Wake on any of touch, wake
word, noise, phase change, media, or page change. Both transitions are
**instantaneous** — no tween at all.

**Adapted.** The dim veil and staggered rising glyphs are excellent and were the
direct inspiration for SLEEPING's near-total stillness. We **reject the 6 s
timeout** (with a mouse present it is jarring; it exists because a wall-mounted
device must not burn its 450 mAh battery) and **reject the instant transitions**
(falling asleep should be gradual, waking should be quick — our SLEEPING uses a
1.6 s enter and a 0.55 s exit).

### 3.5 Audio-reactive mouth — ported with constants intact

```
peak dB → clamp((db + 68) / 45, 0, 1), hard gate below -62 dB
        → one-pole smoothing, attack 0.55 / release 0.18
        → × syllable (452 ms) × phrase (1319 ms) × closure (640 ms cycle)
        → QUANTISE TO 4 STEPS
```

**Taken essentially verbatim** into `behaviors/speaking.ts`. The 4-step
quantisation is the part that is easy to get wrong: smoothing it away produces an
equaliser, keeping it produces a character. AURA reads this from the microphone
because it has no access to the TTS stream; in the browser we feed the same
pipeline from a normalised amplitude, so the Web Lab's Audio Level slider drives
the identical math a future `AnalyserNode` will.

We also ported AURA's **synthetic energy floor** (`0.10 + slow·0.16 + fast·0.18 +
pulse⁴·0.38`, periods 310/105/72 ms) as the LISTENING channel's "never freeze in
silence" guarantee.

### 3.6 Attack / release asymmetry

0.55/0.18 (mouth) and 0.58/0.14 (music VU). Fast in, slow out is what separates a
living response from a twitchy one. Ported as the `Envelope` primitive in
`core/transitions.ts` and used for **every** level-driven parameter.

### 3.7 Colour-coded aura ring

Four 28° arcs at 90° spacing, colour-coded by phase. Cheap, instantly readable,
and independent of the face art.

**Adapted** into the state palette system — same idea (a cheap colour channel that
communicates state at a glance), but our own palette. AURA's cyan/green/purple
set is exactly the "cyberpunk neon" the brief rejects, so none of its hex values
survive.

### 3.8 What we rejected outright

LVGL, the ESP32/LVGL widget vocabulary, the `online_image` 16-asset PSRAM
pipeline, microWakeWord, the Home Assistant API plumbing, the media-player
ducking, the RTC/timer internals, and the several pieces of dead config the
analysis found (`aura_register_activity` never called, `display_awake_until`
written 8× and never read, three declared-but-unreferenced fonts).

---

## 3b. SphereWarp / DelayedFollow — the Rive effects

Supplied later by the user as a Rive reference (AB at Novra; the author's own
README states free to use). Two scripts, and both were ported into the engine
rather than approximated:

**`rive-sphere-warp/SphereWarp.luau`** — projects a flat face onto a virtual
ball. Each element gets the position, lean and foreshortening it would have if
it were painted on that ball, driven by two numbers (yaw and pitch). Two
properties were preserved deliberately:

1. *It does not bend the artwork.* Each element moves as one piece, so a capsule
   stays a capsule. The README is explicit: "No blobs."
2. *Front-facing is a no-op.* At yaw = pitch = 0 the output equals the input, so
   an existing rig plays untouched.

Ported to `core/sphere.ts` as `projectPoint` + `sphereJacobian`. The Jacobian is
the part that carries the turn: it scales an element by how much a step on the
flat face stretches once mapped onto the rotated ball, which is what makes the
near eye swell and the far one shrink. The reference measured a 1.28x near/far
ratio at its settings; ours measures 1.30x at full yaw.

**`rive-delayed-follow/DelayedFollow.lua`** — a second-order spring follower.
Ported into `BodyController` to drive the head turn: the head *chases* the gaze
with `lag = 0.25 s` and `bounce = 0.2` rather than copying it, integrated in
fixed 1/240 s slices so the feel is identical at 30/60/120 fps. Copying the gaze
exactly makes the head feel welded to the eyes; the lag is what reads as a head
being turned by attention.

**The lesson that mattered most** came from the reference's own gotcha list:
*"The ball is pinned to artboard coordinates, so animating an eye's position
slides it across the ball instead of dragging the ball along with it."* Our
first port folded the gaze offset into the projection anchor, which pushed the
anchor to 105% of the ball radius on THINKING (a state that looks 0.85 up) —
past the limb, where the projection clamps and the Jacobian diverges. The
capsule smeared. Separating the rest anchor from the gaze offset fixed it, and
every anchor now sits at ~31% of the ball radius.

## 4. The fusion, stated plainly

| Contribution | Source | Where it lives |
|---|---|---|
| Easing vocabulary; crossfade transitions; procedural idle tuning | KK | `core/easing.ts`, `core/transitions.ts`, `core/states.ts` |
| Renderer discipline for a small MCU; verification-level documentation | KK | `renderer/web/canvasRenderer.ts` comments, `docs/MIGRATION.md` |
| Controlled expression API; orbital tapered trail | Grok | `core/behavior.ts`, `renderer/web/canvasRenderer.ts` |
| State priority ladder; blink model; gesture table; mouth envelope; asymmetric envelope; synthetic floor | AURA | `core/state.ts`, `behaviors/*` |
| Sphere projection (yaw/pitch warp) and the delayed-follow head spring | **SphereWarp + DelayedFollow, AB at Novra** | `core/sphere.ts`, `behaviors/body.ts` |
| Grey material, capsule eyes, per-eye channels, conditional brows | **Ours** | `renderer/web/*` |

The brief's one-line summary — *KK provides the animation engineering, Grok the
visual language, AURA the life* — is accurate, with one correction worth stating:
Grok's contribution is mostly **negative**. Its most useful lesson was which
choices *not* to copy (authored paths, silhouette morphing, a fixed violet
identity), and the visual language that actually shipped is our own construction
built on the principles Grok demonstrates rather than on its assets.
