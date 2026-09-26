/**
 * canvasRenderer.ts — the Web renderer.
 *
 * This is the ONLY module that knows about pixels, Canvas 2D or colours.
 * Everything above it speaks in the unitless `AvatarPose`. That boundary is
 * what lets the M5Stack StopWatch renderer replace this file and nothing else.
 *
 * ── The look ──────────────────────────────────────────────────────────────
 * A RESTRAINED SPHERE floating on a black round screen, carrying two
 * independent capsule eyes. No ring, no trail, no particles, no mouth, no
 * text, no logo. Two shapes and a gradient — that is the whole avatar.
 *
 *   1. THE SPHERE IS SHADED, NOT OUTLINED. A soft radial gradient lit from
 *      the upper-left gives volume. There is deliberately no stroke: an
 *      outline turns a sphere into a badge, and the reference device has no
 *      circle drawn on it at all.
 *   2. THE EYES ARE CAPSULES THAT MORPH. Each eye is a stadium whose aspect
 *      slides continuously from tall, through round, to flattened. The two
 *      eyes are driven INDEPENDENTLY, so "one eye narrower than the other"
 *      is expressible — which is where nearly all of the personality lives.
 *   3. THE EYES SIT ON THE SPHERE. They are placed by spherical projection,
 *      so a capsule near the limb foreshortens horizontally. That is the
 *      difference between eyes *on* a ball and eyes *in front of* one.
 *   4. BROWS ARE OPT-IN. Hidden by default; drawn only when a state raises
 *      `browOpen`. A permanent brow changes the character's whole face.
 *
 * ── Performance (from KK) ─────────────────────────────────────────────────
 * KK had to hit 60 fps on a 240 MHz MCU driving a QSPI AMOLED:
 *   - no retained scene graph; each frame rebuilds its paths
 *   - `shadowBlur` is never used
 *   - no per-frame allocation in the draw path
 *   - geometry is authored in one 466-unit design space and the context is
 *     scaled once, so it maps 1:1 onto the device framebuffer
 */

import type { AvatarPose, AvatarSignals } from '../../core/params';
import { paletteFor, withAlpha, type AvatarPalette } from './palette';
import {
  BALL_RADIUS_RATIO,
  projectPoint,
  sphereJacobian,
  type SphereView,
} from '../../core/sphere';

export interface RendererOptions {
  /** Design-space size. 466 = the M5Stack StopWatch's native round screen. */
  size?: number;
}

/**
 * Capsule geometry at the three reference aspects, as a fraction of the sphere
 * radius. Interpolating between these produces the continuous tall → round →
 * wide morph.
 *
 * Solved from the reference artwork. At the sphere radius this avatar uses
 * (0.44 of a 466 panel, so 205 units) the tall capsule lands at 36 x 125 units:
 * aspect 3.47, occupying 30.5% of the sphere's diameter.
 *
 * THE NUMBER THAT ACTUALLY MATTERS IS THE CAP SHARE. A capsule's two round caps
 * consume `width` of its total length, so the straight run — the part that
 * reads as a LINE — is only `1 - width/length` of it:
 *
 *     40 x 100  (aspect 2.50)  caps = 40% of the length   <- stubby pill
 *     36 x 125  (aspect 3.47)  caps = 29% of the length   <- reads as a capsule
 *
 * An earlier "reference-matched" 2.50 aspect was measured correctly but tuned
 * wrongly: matching the aspect while ignoring the cap share produced an eye
 * that was the right shape on paper and visibly too short in motion.
 *
 *   tall    0.088 x 0.305   (3.5:1 vertical)
 *   round   0.142 x 0.190   (1.3:1)
 *   wide    0.235 x 0.086   (0.4:1 horizontal)
 */
const EYE_TALL_W = 0.088;
const EYE_TALL_H = 0.305;
const EYE_ROUND_W = 0.142;
const EYE_ROUND_H = 0.19;
const EYE_WIDE_W = 0.235;
const EYE_WIDE_H = 0.086;

/**
 * The clear space BETWEEN the two capsules, as a fraction of the sphere radius.
 *
 * Expressed as a gap rather than a centre offset so it stays constant as the
 * capsules morph: a pair of tall needles and a pair of flat lozenges read as
 * equally separated, instead of the wide ones creeping together.
 */
const EYE_GAP_GAP = 0.12;
const EYE_BASE_Y = -0.05;

export class CanvasAvatarRenderer {
  readonly size: number;
  private ctx: CanvasRenderingContext2D;

  /** Visual time, advanced by the renderer, used only for the light drift. */
  private time = 0;

  private currentPalette: AvatarPalette;
  private lastStateKey = '';

  constructor(
    private canvas: HTMLCanvasElement,
    initialStateKey: string,
    options: RendererOptions = {},
  ) {
    this.size = options.size ?? 466;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('CanvasAvatarRenderer: 2D context unavailable');
    this.ctx = ctx;
    this.currentPalette = paletteFor(initialStateKey);
    this.lastStateKey = initialStateKey;
    this.resize();
  }

  /**
   * Match the backing store to the canvas's CSS size.
   *
   * Reads `clientWidth` rather than trusting the constructor's `size`, so a
   * responsive device frame (narrower than 466 on a phone) still renders at
   * native sharpness instead of being upscaled and blurred.
   */
  resize(cssSize?: number): void {
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    const measured = cssSize ?? this.canvas.clientWidth;
    const target = measured && measured > 0 ? measured : this.size;
    const px = Math.round(target * dpr);
    if (this.canvas.width !== px || this.canvas.height !== px) {
      this.canvas.width = px;
      this.canvas.height = px;
    }
  }

  /** Render one frame. */
  render(pose: AvatarPose, signals: AvatarSignals, stateKey: string, dt: number): void {
    void signals;
    this.time += dt;

    // The palette changes only on a real state change, so the crossfade is
    // driven by a flag rather than by mixing every frame.
    if (stateKey !== this.lastStateKey) {
      this.lastStateKey = stateKey;
      this.currentPalette = paletteFor(stateKey);
    }
    const palette = this.currentPalette;

    const ctx = this.ctx;
    const S = this.size;

    // Reset to design space: every coordinate below is in 0..466 units.
    ctx.setTransform(this.canvas.width / S, 0, 0, this.canvas.height / S, 0, 0);
    ctx.globalCompositeOperation = 'source-over';

    // Pure black. An OLED round panel showing a sphere — no vignette, no
    // background gradient, nothing that would read as a drawn UI circle.
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, S, S);

    const baseR = S * 0.44;

    // ── Whole-body transform ────────────────────────────────────────────
    // The head leans, drifts and squashes as a unit, and the eyes ride inside
    // it. Applying the transform once here is why the sphere and eyes can
    // never drift apart.
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.rotate(pose.bodyRotation);
    ctx.translate(pose.bodyX * baseR, pose.bodyY * baseR);
    ctx.scale(pose.bodyScaleX, pose.bodyScaleY);

    const rx = baseR * pose.orbScaleX;
    const ry = baseR * pose.orbScaleY;

    this.drawSphere(ctx, rx, ry, pose, palette);
    this.drawEyes(ctx, rx, ry, pose, palette);

    ctx.restore();

    // The sleep glyphs are drawn in SCREEN space, not body space: they rise
    // from the head rather than being attached to it, so they should not
    // inherit the body's lean or squash.
    if (signals.gestureZzz > 0.01) {
      this.drawSleepGlyphs(ctx, S / 2, S / 2, rx, ry, signals, palette);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Sphere
  // ══════════════════════════════════════════════════════════════════════

  /**
   * The sphere: a soft volume with no outline.
   *
   * Three passes:
   *   1. the main body gradient, lit from the upper-left
   *   2. a small specular highlight (this is what makes it read as a *ball*
   *      rather than as a flat disc — the eye needs the highlight even though
   *      it never consciously notices it)
   *   3. a rim light on the lower-right, which stops the edge dissolving into
   *      the black background
   *
   * `orbDeform` shifts the highlight slightly, giving the impression of light
   * moving inside the sphere. That is the only "fluid" motion left, and it is
   * deliberately internal — the silhouette stays a clean ellipse.
   */
  private drawSphere(
    ctx: CanvasRenderingContext2D,
    rx: number,
    ry: number,
    pose: AvatarPose,
    palette: AvatarPalette,
  ): void {
    // The light source drifts a little so the sphere is never a static image.
    const driftX = Math.sin(this.time * 0.31) * 0.05 * (0.4 + pose.orbDeform);
    const driftY = Math.cos(this.time * 0.24) * 0.04 * (0.4 + pose.orbDeform);

    const lx = -rx * (0.3 + driftX);
    const ly = -ry * (0.34 + driftY);

    // 1. Body volume.
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    const body = ctx.createRadialGradient(lx, ly, rx * 0.04, 0, 0, Math.max(rx, ry) * 1.18);
    // Fall off toward BLACK, not toward `palette.background`. The background
    // is a warm near-black, and mixing a blue into a warm grey desaturates it
    // into slate-brown — which is what made ERROR and THINKING look muddy.
    // Scaling luminance to zero preserves the hue.
    body.addColorStop(0, palette.coreInner);
    body.addColorStop(0.45, palette.coreOuter);
    // Fall off toward black but not ALL the way: a sphere whose edge reaches
    // the background exactly has no silhouette, and on a black panel it reads
    // as a floating highlight rather than as a ball.
    body.addColorStop(0.78, mixHex(palette.coreOuter, '#000000', 0.42));
    body.addColorStop(1, mixHex(palette.coreOuter, '#000000', 0.62));
    ctx.fillStyle = body;
    ctx.fill();

    // 2. Specular highlight, clipped to the sphere.
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.clip();
    const specR = Math.max(rx, ry) * 0.5;
    const spec = ctx.createRadialGradient(lx, ly, 0, lx, ly, specR);
    spec.addColorStop(0, withAlpha(palette.rim, 0.26));
    spec.addColorStop(0.45, withAlpha(palette.rim, 0.07));
    spec.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = spec;
    ctx.fillRect(-rx * 1.5, -ry * 1.5, rx * 3, ry * 3);

    // 3. Rim light on the far side, so the edge reads against black.
    const rimX = rx * 0.42;
    const rimY = ry * 0.46;
    const rim = ctx.createRadialGradient(rimX, rimY, Math.max(rx, ry) * 0.55, rimX, rimY, Math.max(rx, ry) * 1.05);
    rim.addColorStop(0, 'rgba(0,0,0,0)');
    rim.addColorStop(0.72, withAlpha(palette.rim, 0.06));
    rim.addColorStop(1, withAlpha(palette.rim, 0.18));
    ctx.fillStyle = rim;
    ctx.fillRect(-rx * 1.5, -ry * 1.5, rx * 3, ry * 3);
    ctx.restore();
  }

  // ══════════════════════════════════════════════════════════════════════
  // Sleep glyphs
  // ══════════════════════════════════════════════════════════════════════

  /**
   * The floating "Z"s shown while sleeping.
   *
   * Lives in the renderer, not the engine, because typography is a rendering
   * concern — the engine only publishes an intensity and stays free of fonts.
   *
   * Three glyphs, each on its own cycle and phase offset, rising from the
   * upper-right of the sphere while growing slightly and fading out. Their
   * drift is driven by `this.time`, so they keep moving even though the pose is
   * almost perfectly still while asleep.
   */
  private drawSleepGlyphs(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    signals: AvatarSignals,
    palette: AvatarPalette,
  ): void {
    const intensity = clamp(signals.gestureZzz, 0, 1);
    // Glyphs sit off the upper-right shoulder of the sphere.
    const originX = cx + rx * 0.42;
    const originY = cy - ry * 0.42;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let i = 0; i < 3; i++) {
      // Each glyph has its own period and offset, so they never sync up.
      const period = 2.9 + i * 0.45;
      const offset = i * 0.9;
      const local = ((this.time + offset) % period) / period;

      // A single glyph fades in, travels, and fades out.
      let alpha: number;
      if (local < 0.18) alpha = local / 0.18;
      else if (local < 0.75) alpha = 1;
      else alpha = 1 - (local - 0.75) / 0.25;
      alpha *= intensity;
      if (alpha <= 0.01) continue;

      // Travel up and to the right, with a slow lateral sway.
      const travel = local;
      const gx = originX + rx * (0.16 * travel + 0.05 * Math.sin(this.time * 0.8 + i));
      const gy = originY - ry * (0.62 * travel);
      // Glyphs grow as they rise, which reads as drifting away from the head.
      const size = ry * (0.1 + i * 0.028 + travel * 0.05);

      ctx.save();
      ctx.translate(gx, gy);
      ctx.globalAlpha = alpha * 0.85;
      ctx.strokeStyle = palette.eye;
      ctx.lineWidth = Math.max(1.5, size * 0.17);

      // A "Z" as four strokes: top bar, diagonal, bottom bar.
      ctx.beginPath();
      ctx.moveTo(-size * 0.5, -size * 0.5);
      ctx.lineTo(size * 0.5, -size * 0.5);
      ctx.lineTo(-size * 0.5, size * 0.5);
      ctx.lineTo(size * 0.5, size * 0.5);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  // ══════════════════════════════════════════════════════════════════════
  // Eyes
  // ══════════════════════════════════════════════════════════════════════

  /**
   * The eyes: two independently morphing capsules.
   *
   * ── The morph ─────────────────────────────────────────────────────────────
   * `eyeRound` slides the aspect continuously:
   *
   *     -1  ▮  tall and narrow    alert, listening, waiting
   *      0  ◉  round             neutral, calm
   *     +1  ▬  short and wide    sleepy, content, amused
   *
   * `eyeRoundL` / `eyeRoundR` offset that per eye, which is the channel that
   * produces "thinking" (one eye subtly narrower) instead of merely "a mood".
   *
   * ── On the sphere ─────────────────────────────────────────────────────────
   * Each eye is projected onto the sphere face: the further it sits from the
   * centre, the more its width foreshortens. Without this the eyes read as
   * stickers on a flat disc; with it they read as marks on a curved surface.
   *
   * ── Brows ─────────────────────────────────────────────────────────────────
   * Drawn only when `browOpen > 0`. At rest there are no brows at all — the
   * face is two capsules and nothing else.
   */
  private drawEyes(
    ctx: CanvasRenderingContext2D,
    rx: number,
    ry: number,
    pose: AvatarPose,
    palette: AvatarPalette,
  ): void {
    const baseOpen = clamp(pose.eyeOpen, 0, 1);

    // ── Pass 1: measure both capsules ───────────────────────────────────
    // The separation has to be computed from BOTH eyes before either is drawn.
    // An earlier revision derived the gap from each eye's own width, which had
    // two faults: wide capsules (SUCCESS) drifted toward each other until they
    // merged, and an asymmetric pair (THINKING, a wink) sat off-centre because
    // the two halves disagreed about where the middle of the face was.
    const geo = ([-1, 1] as const).map((side) => {
      const round = clamp(pose.eyeRound + (side < 0 ? pose.eyeRoundL : pose.eyeRoundR), -1, 1);
      const sizeTrim = 1 + (side < 0 ? pose.eyeSizeL : pose.eyeSizeR);
      let wFrac: number;
      let hFrac: number;
      if (round <= 0) {
        const k = -round;
        wFrac = lerp(EYE_ROUND_W, EYE_TALL_W, k);
        hFrac = lerp(EYE_ROUND_H, EYE_TALL_H, k);
      } else {
        const k = round;
        wFrac = lerp(EYE_ROUND_W, EYE_WIDE_W, k);
        hFrac = lerp(EYE_ROUND_H, EYE_WIDE_H, k);
      }
      const open = clamp(baseOpen * (side < 0 ? pose.eyeOpenL : pose.eyeOpenR), 0, 1);
      const w = rx * wFrac * pose.eyeSize * sizeTrim * lerp(0.66, 1, open);
      const h = Math.max(ry * hFrac * pose.eyeSize * sizeTrim * open, w * 0.1);
      return { side, open, w, h, round };
    });

    // ── Gap ─────────────────────────────────────────────────────────────
    // Held at a CONSTANT number of pixels between the two capsules, so it
    // reads the same whether they are tall needles or flat lozenges. Derived
    // from the widest eye so a wink never lets the pair collide, and shared by
    // both eyes so the pair stays centred on the face.
    const widest = Math.max(geo[0]!.w, geo[1]!.w);
    const halfGap = (widest + rx * EYE_GAP_GAP) * pose.eyeDistance;

    for (const { side, w, h, round } of geo) {
      const lift = side < 0 ? pose.eyeLiftL : pose.eyeLiftR;
      const tilt = side < 0 ? pose.eyeTiltL : pose.eyeTiltR;

      // ── REST ANCHOR ───────────────────────────────────────────────────
      // Where this eye lives at rest, on the flat face. The sphere projection
      // is measured HERE and nowhere else.
      //
      // Gaze is deliberately NOT folded in. An earlier version added the full
      // gaze offset to the anchor, which pushed it to 105% of the ball radius
      // on states that hold extreme look directions (THINKING looks 0.85 up) —
      // past the limb, where the projection clamps and the Jacobian diverges.
      // The capsule smeared. The reference is explicit about this: the ball is
      // pinned in artboard space, so moving an element slides it across the
      // ball rather than dragging the ball with it.
      const anchorX = side * halfGap;
      const anchorY = ry * EYE_BASE_Y - lift * ry;

      // ── Project onto the virtual ball ─────────────────────────────────
      // The eye is placed on a sphere and the head's yaw/pitch rotate it. Two
      // things come out of this, and together they are what sells a head turn:
      //
      //   * `project` moves the eye along a CURVED path, so a turn is an arc
      //     rather than a slide;
      //   * `jacobian` scales it — the near eye swells, the far one shrinks,
      //     and one approaching the limb compresses.
      //
      // This replaces an ad-hoc cosine falloff that only squashed an eye as it
      // neared the edge and did nothing at all for depth.
      const ball: SphereView = {
        cx: 0,
        cy: 0,
        radius: rx * BALL_RADIUS_RATIO,
        yaw: pose.headYaw,
        pitch: pose.headPitch,
      };
      const proj = projectPoint(ball, anchorX, anchorY);
      const jac = sphereJacobian(ball, anchorX, anchorY);

      // Independent x/y scales from the Jacobian's diagonal. Clamped: at the
      // limb the surface is vertical and the terms diverge.
      // Tighter than the raw Jacobian range: near the limb the terms diverge
      // and an eye would smear rather than foreshorten.
      const sx = clamp(Math.abs(jac.j11), 0.55, 1.35);
      const sy = clamp(Math.abs(jac.j22), 0.55, 1.35);

      // An eye rotated behind the ball is hidden rather than mirrored inside
      // out, which is what the reference does.
      if (proj.depth <= 0) continue;

      // `w` is the shared measurement used for the gap; the drawn half-width is
      // scaled by the projection.
      const dw = w * sx;
      const dh = h * sy;

      ctx.save();
      // Position = projection of the ANCHOR, plus a bounded gaze offset applied
      // AFTER projection. The offset is capped so no combination of state and
      // gaze can walk an eye onto the limb.
      const gazeMax = rx * 0.3;
      const gazeX = clamp(pose.eyeOffsetX * rx * 0.62, -gazeMax, gazeMax);
      const gazeY = clamp(pose.eyeOffsetY * ry * 0.52, -gazeMax, gazeMax);
      ctx.translate(proj.x + gazeX, proj.y + gazeY);
      // Perspective lean: an eye away from the centre also tips slightly.
      // A hint of lean, not a twist: a large value rotates the capsule enough
      // to read as a glitch rather than as perspective.
      ctx.rotate(tilt + (jac.j12 - jac.j21) * 0.05);

      // ── Draw the capsule ─────────────────────────────────────────────
      // STAMPED CIRCLES along the centreline.
      //
      // Three earlier attempts built the bowed capsule as a path — a filled
      // polygon, a stroked arc, and a crescent between two concentric arcs —
      // and each produced a different artifact (a notch, a cloud, a donut, a
      // wedge). Every one of those failed on the same thing: a variable-width
      // band around a tight curve needs correct winding, and the winding flips
      // as the curvature passes through the stroke radius.
      //
      // Stamping removes the problem entirely. Filling a circle of radius `r`
      // at each point along the centreline produces a mathematically exact
      // capsule at ANY curvature, with perfect round caps, and there is no
      // winding rule to get wrong. It is also ~24 fills, which is trivial, and
      // it ports to a C++ renderer as a plain loop.
      const bow = clamp(side < 0 ? pose.eyeBowL : pose.eyeBowR, -1, 1);

      // ── The capsule's axis ────────────────────────────────────────────
      // The capsule runs along its OWN LONG AXIS and the bow is always
      // PERPENDICULAR to it:
      //
      //   tall  ▮   runs vertically,  bows sideways    ( )
      //   wide  ▬   runs horizontally, bows vertically ^ v
      //
      // (Hard-coding the axis to horizontal collapsed every tall eye into a
      // circle, because a tall capsule's horizontal span is smaller than its
      // stroke radius.)
      // Which axis the capsule runs along is a property of the STATE, not of
      // the projected pixels. Deciding it from `dw >= dh` was unstable: a
      // turned head squeezes an eye's width, `dw` drops below `dh`, and the
      // capsule flips axis mid-turn — rendering as a smeared blob. `round` is
      // what the designer set, so it cannot flip.
      const horizontal = round >= 0;
      const halfLong = horizontal ? dw : dh;

      // Stroke radius = half the SHORT axis, which makes the caps perfect
      // semicircles. Thinned as the capsule bows, with a floor so a tall eye on
      // a modest bow never collapses to a thread.
      const halfShort = horizontal ? dh : dw;
      const r = Math.max(halfShort * (1 - 0.55 * Math.abs(bow)), halfShort * 0.45);

      // Straight run along the long axis; the round caps supply the rest.
      const seg = Math.max(0, halfLong - r);
      // Sagitta: peak offset perpendicular to the long axis.
      const sag = bow * seg * 0.5;

      // ── Draw it as one STROKED path ───────────────────────────────────
      // A stroked polyline with round joins and round caps is exactly the
      // Minkowski sum of the centreline with a disc, so the result is a
      // mathematically perfect capsule at any curvature. The rasteriser does
      // the union, which means there is no winding rule to get wrong — the
      // failure mode that produced a notch, then a cloud, then a donut, then a
      // wedge across four earlier attempts at hand-filling an outline.
      ctx.beginPath();
      const steps = 16;
      for (let i = 0; i <= steps; i++) {
        const u = -1 + (i / steps) * 2; // -1 .. 1 along the long axis
        const offset = sag * (1 - u * u); // parabolic centreline
        const px = horizontal ? u * seg : -offset;
        const py = horizontal ? -offset : u * seg;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = palette.eye;
      ctx.lineWidth = r * 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();

      // ── Brow: only when the state asks for one ────────────────────────
      // Drawn BEFORE the restore, so it shares the eye's projected frame. It
      // was previously emitted after the restore, which measured its offset
      // from the sphere's centre instead of from the eye — the brow floated
      // above and between the two eyes rather than sitting over one of them.
      const browOpen = clamp(pose.browOpen, 0, 1);
      if (browOpen > 0.02) {
        const browTilt = side < 0 ? pose.browTiltL : pose.browTiltR;
        const browLift = side < 0 ? pose.browLiftL : pose.browLiftR;
        // A brow is SHORTER than the eye and sits just above it. Making it
        // long and floating detached it from the face and it read as a
        // separate mark rather than as part of the expression.
        const browLen = Math.min(dw * 0.78, rx * 0.105);

        // Drawn in the same projected frame as the eye, but lifted clear of it
        // so a bowed or thinned capsule never touches its own brow.
        ctx.save();
        ctx.translate(0, -Math.max(dh, ry * 0.12) - r - ry * 0.085 - browLift * ry);
        ctx.rotate(browTilt * side);
        ctx.beginPath();
        ctx.moveTo(-browLen, 0);
        ctx.lineTo(browLen, 0);
        ctx.strokeStyle = withAlpha(palette.eye, browOpen * 0.85);
        ctx.lineWidth = Math.max(1.4, ry * 0.016);
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.restore();
      }

      // Close the eye's projected frame (opened with ctx.save() above).
      ctx.restore();
    }
  }

  /** No transient pools remain; kept so callers need not change. */
  reset(): void {
    this.time = 0;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Blend two hex colours. */
function mixHex(a: string, b: string, t: number): string {
  const av = parseInt(a.slice(1), 16);
  const bv = parseInt(b.slice(1), 16);
  const r = Math.round((((av >> 16) & 255) + (((bv >> 16) & 255) - ((av >> 16) & 255)) * t));
  const g = Math.round((((av >> 8) & 255) + (((bv >> 8) & 255) - ((av >> 8) & 255)) * t));
  const bl = Math.round(((av & 255) + ((bv & 255) - (av & 255)) * t));
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}
