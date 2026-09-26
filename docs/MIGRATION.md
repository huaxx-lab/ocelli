# Migration to M5Stack StopWatch

What follows is the concrete plan for phase 2: running this avatar on the real
device. It is written from the code as it exists, not from intent — every claim
about reusability was checked against the module it names.

---

## 0. Device baseline

| Item | Value | Source |
|---|---|---|
| Product | M5Stack StopWatch Dev Kit (SKU C152) | M5Stack docs |
| MCU | ESP32-S3R8, dual-core LX7 @ 240 MHz | M5Stack docs |
| Display | 1.75″ round AMOLED, **466 × 466**, CO5300, QSPI | M5Stack docs |
| Memory | 16 MB flash, 8 MB PSRAM | M5Stack docs |
| IMU | BMI270 (I²C `0x68`) | M5Stack docs |
| Touch | CST820B | M5Stack docs |
| Audio | ES8311 codec + MEMS mic + AW8737A amp | M5Stack docs |
| Haptics | Vibration motor via M5IOE1 PWM | M5Stack docs |
| Battery | 450 mAh | M5Stack docs |

**Why 466 matters here.** The whole Web renderer is authored in a 466-unit design
space (`CanvasAvatarRenderer.size = 466`), and the Lab's device frame is exactly
466 × 466 CSS px. There is therefore **no coordinate conversion in the port**: the
numbers in the renderer are already the device's pixel grid.

> KK separately documents that a 466 × 466 16-bit PSRAM canvas plus
> `pushSprite(0, 0)` costs roughly four frames of budget. That finding drives
> §3 below.

---

## 1. Module-by-module verdict

Legend: **PORT** = transliterate to C++ nearly line-for-line ·
**PORT+** = port with device-specific changes · **REWRITE** = new C++ ·
**DROP** = not applicable.

| Module | Lines | Verdict | Notes |
|---|---:|---|---|
| `core/state.ts` | 81 | **PORT** | String union → `enum class`. `STATE_PRIORITY` is already a plain table. |
| `core/params.ts` | 223 | **PORT** | `AvatarInput` / `AvatarPose` / `AvatarSignals` become POD structs. No allocation. |
| `core/easing.ts` | 98 | **PORT** | Every function is `sinf`/`powf`/arithmetic. Drop the unused entries to save flash. |
| `core/timeline.ts` | 224 | **PORT+** | `Rng` is mulberry32 — trivially portable and deterministic across platforms, which is what makes Web↔device A/B comparison possible. `Clock` → a FreeRTOS tick source. `Track` is unused by the current states; port only if needed. |
| `core/transitions.ts` | 271 | **PORT** | `Spring`, `PoseBlender`, `Pulse`, `Envelope` are all pure `step(dt)` math. `PoseBlender` becomes a per-field loop over the struct. |
| `core/states.ts` | 590 | **PORT** | This is the avatar's identity and the largest single asset. Data, not code. `modulate` callbacks become member functions or a switch. |
| `core/behavior.ts` | 412 | **PORT** | The frame order (smooth inputs → controllers → resolve → blend → layer) is the engine; keep it exactly. |
| `core/scenario.ts` | 396 | **PORT+** | Keep for the on-device demo/self-test, driven by the same beat tables. |
| `behaviors/blink.ts` | 234 | **PORT** | Pure timing. |
| `behaviors/gaze.ts` | 238 | **PORT+** | `PointerGazeSource` → `ImuGazeSource`. The controller itself is untouched — this is the seam the architecture was built around. |
| `behaviors/speaking.ts` | 158 | **PORT** | AURA's constants preserved verbatim. Needs a dB source (§4). |
| `behaviors/ambient.ts` | 223 | **PORT** | Pure math. |
| `renderer/web/*` | ~1 100 | **REWRITE** | Canvas 2D → M5GFX/Sprite. This is the only substantial rewrite. |
| `components/*` | ~800 | **DROP** | React. The Lab has no device counterpart. |
| `plugin/*` | ~330 | **DROP** | DSH-specific. |

**Net:** roughly **2 700 of 3 400 engine lines port directly** (≈80%), and the
~1 100-line renderer is the rewrite. That ratio is the architecture's payoff.

---

## 2. What ports directly, and why

The engine was written under three constraints that make the port mechanical:

1. **No time source inside the core.** `AvatarEngine.step(dt)` takes a delta. The
   browser supplies it from `requestAnimationFrame`; the device supplies it from
   the render loop. Nothing else changes.
2. **No output units inside the core.** `AvatarPose` is unitless; the renderer
   owns pixels and colour. So `orbScaleX = 1.05` means the same thing on both
   platforms.
3. **No allocation in the frame path.** Particle pools are fixed-size, poses are
   flat structs, and every controller is a long-lived object. This was done for
   the Web's GC but is exactly what an MCU needs.

### The `GazeSource` seam

```ts
export interface GazeSource {
  readonly kind: string;
  read(): { x: number; y: number };
}
```

`PointerGazeSource` is the Lab's implementation. The device implements the same
interface against the BMI270:

```cpp
struct ImuGazeSource : GazeSource {
  // Complementary filter on accel for absolute tilt, gyro for feed-forward
  // (this is what KK does — pure accel is too noisy, pure gyro drifts).
  void update(float ax, float ay, float gx, float gy, float dt);
  Vec2 read() const override { return { x, y }; }
};
```

Nothing in `GazeController` changes. The dead-zone, the spring, and the
attention-based centre bias all carry over as-is — and the dead-zone is *more*
necessary on the device than in the browser, because hand tremor is far larger
than pointer jitter.

### Verification tooling carries over too

`Rng` is seeded, and `AvatarEngine.reset(seed)` restores a known state, so the
device can replay a scenario and the browser can replay the same one. Comparing
a serial dump of `AvatarPose` per frame between the two is how the C++ port gets
validated without a camera.

---

## 3. The renderer: what the rewrite must do

This is the only genuinely new work, and KK's engineering notes are the spec.

### 3.1 Draw into a sprite, not the panel

```
M5Canvas canvas(&M5.Display);   // 466x466, 16-bit, PSRAM
canvas.setColorDepth(16);
canvas.createSprite(466, 466);
```

All `renderer/web/canvasRenderer.ts` draw calls map onto M5GFX:

| Canvas 2D | M5GFX |
|---|---|
| `ctx.createRadialGradient(...)` + `fillRect` | `canvas.fillSmoothRoundRect` won't do it — draw a software radial gradient into a small sprite once per state and blit, **or** approximate the bloom with 8–12 concentric `fillCircle` calls at decreasing alpha |
| `ctx.beginPath()` / `lineTo` / `fill` | `canvas.fillPolygon(points, count)` |
| `ctx.stroke()` with `lineWidth` | `canvas.drawPolygon` / `drawWideLine` |
| `ctx.globalCompositeOperation = 'lighter'` | **Not directly available.** Requires manual additive blending: read the destination pixel, add, clamp, write. Budget for this — it is used in 5 places (core, filaments, trail, particles, eyes) |
| `ctx.arc` | `canvas.fillCircle` / `drawCircle` |
| `ctx.clip()` | `canvas.setClipRect` (rectangular only — the orb's circular clip must instead be enforced by keeping geometry inside `r`) |

### 3.2 Mandatory optimisations

- **Dirty rectangles are not optional.** KK measured that a full 466 × 466
  `pushSprite` costs about four frames of budget. Compute the union bounding box
  of what changed this frame and push only that. In practice the avatar occupies
  a bounded region: the halo extent is
  `baseR * max(haloRadius, 1.2) * 1.55 ≈ 225 px` worst case, so a ~460 × 460
  region during state changes and much less while idling.
- **Pre-render the static layers.** The bloom gradients for each of the ten
  palettes never change shape — only colour and opacity. A 10-entry palette cache
  of small pre-rendered gradient sprites removes the per-frame gradient math
  entirely.
- **Reduce the body trace.** `BODY_SEGMENTS = 96` is comfortable at 240 MHz but
  is the single largest per-frame cost; 64 segments is visually identical at
  466 px and saves a third.
- **Cap the trail at 30 samples** and skip Catmull-Rom on-device (draw the
  ribbon as line segments). The resampling is a Web-luxury; at 466 px with a
  tapered ribbon the faceting is not visible.
- **Particles: 24 max** on-device versus 72 on the Web.

### 3.3 60 fps budget

KK's target is ~60 fps with dirty rectangles and partial updates. The engine's
own cost is negligible (all closed-form math, no allocation); the budget is
entirely in rasterisation and QSPI transfer. Plan to instrument early: a frame
timer that reports draw time and push time separately, plus the dirty-rect area
per frame, is the difference between a tuning session and guesswork.

---

## 4. Audio

The Web Lab fakes `audioLevel` with a slider. On the device:

- **Speaking.** AURA reads `playback_peak` from a `sound_level` sensor at 150 ms
  and normalises with `clamp((db + 68) / 45)` — because it has no access to the
  TTS PCM. The StopWatch *does* have the codec, so a real per-frame RMS from the
  ES8311 playback path is strictly better. `MouthChannel.step(dt, rawLevel,
  active)` already accepts a normalised 0..1 level, so only the producer changes:
  keep AURA's syllable/phrase/closure oscillators and the 4-step quantisation,
  replace the dB conversion.
- **Listening.** Feed the MEMS mic RMS through `ListenChannel`, which already
  implements AURA's asymmetric envelope and synthetic floor.

---

## 5. Haptics and input

| Web | StopWatch |
|---|---|
| Click avatar → blink / wake | Touch → blink / wake (CST820B) |
| Pointer move → gaze | BMI270 tilt → gaze |
| (none) | `WAITING_APPROVAL` → **vibration pulse**, matching the state's contract-pause-expand heartbeat |
| (none) | Buttons A/B → cycle states (already KK's pattern) |

The vibration is the one place where the device can exceed the Web: the brief
notes the StopWatch will buzz on approval, and the APPROVAL beat's 2.6 s
contract→pause→expand cycle is already the exact envelope to drive a
`M5IOE1_PWM_CH1` pulse train.

---

## 6. Suggested sequencing

1. **Port the core** (`core/` + `behaviors/`, ~2 700 lines) and validate it
   headlessly by replaying `assistantRun` and diffing `AvatarPose` dumps against
   the browser's. No display involved — this de-risks the whole phase.
2. **Minimal renderer**: body + eyes + halo only, full-screen push, no dirty
   rects. Confirm it looks right and measure the frame time.
3. **Add the trail and particles**, then dirty rectangles, then measure again.
4. **Wire the IMU** into `ImuGazeSource`; tune the dead-zone on real hardware.
5. **Wire the mic** and replace the fake `audioLevel`.
6. **Wire the vibration motor** to `WAITING_APPROVAL`.
7. **Verify on device** — and per KK's discipline, do not report touch, IMU,
   vibration or display quality as working until it has been observed on the
   physical unit.

---

## 7. Licence boundary

- **KK** is AGPL-3.0. **No KK code has been copied into this project.** What was
  taken is architecture and mathematics (an easing vocabulary, a crossfade
  design, amplitude/period tuning rules, and the dirty-rectangle finding). If KK
  source is ever copied into the StopWatch firmware, that firmware becomes an
  AGPL-3.0 derivative and must be published under those terms. As long as only
  the ideas are used, no obligation attaches.
- **Grok Bot Orb** is MIT, but its visual assets are its identity and the brief
  forbids reproducing them. None of its paths, colours or proportions are used.
- **AURA** is MIT. Its behaviour constants (blink timings, mouth envelope) are
  reproduced as mathematics with attribution in the file headers.
- **This project** is the original work: the orb, eyes, halo, trail, particles,
  palette, and the state/pose architecture that fuses the three.

---

## 8. Verification status of this document

Following KK's evidence-level discipline:

| Claim | Evidence level |
|---|---|
| Web Lab renders correctly at 466 × 466 | **Verified** — headless Chromium, screenshots, 25 automated checks |
| Web Lab runs inside the DSH GUI | **Verified** — 25 automated checks against the live GUI |
| All ten states are visually distinct | **Verified** — measured pairwise pixel differences |
| `Run Assistant Demo` plays end to end | **Verified** — observed state sequence in-browser |
| The engine is renderer-agnostic | **Design-verified** — the renderer is the only module importing Canvas 2D; no DOM reference exists above it |
| The core will compile and run on ESP32-S3 | **Not verified** — no C++ has been written or compiled |
| Dirty rectangles will hit 60 fps at 466 × 466 | **Not verified** — projected from KK's measurements, not from our own hardware run |
| IMU / mic / haptics behaviour | **Not verified** — requires the physical device |
