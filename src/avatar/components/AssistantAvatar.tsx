/**
 * AssistantAvatar.tsx — the canvas host.
 *
 * Responsibilities are deliberately narrow:
 *   1. own the `requestAnimationFrame` loop
 *   2. drive `AvatarEngine.step(dt)` and hand the result to the renderer
 *   3. forward pointer events into the gaze source
 *
 * It contains NO animation logic. If you deleted this file and wrote a
 * C++ equivalent that calls `engine.step(dt)` and blits, you would get the
 * same avatar — which is the test of whether the separation is real.
 */

import { useEffect, useRef } from 'react';
import type { AvatarEngine } from '../core/behavior';
import { CanvasAvatarRenderer } from '../renderer/web/canvasRenderer';

export interface AssistantAvatarProps {
  engine: AvatarEngine;
  /** Design-space size; 466 matches the M5Stack StopWatch panel. */
  size?: number;
  /** Called every frame with the live FPS, for the Lab's readout. */
  onFps?: (fps: number) => void;
  /** Extra class on the canvas element. */
  className?: string;
}

/**
 * Renders the avatar into a square canvas and runs its frame loop.
 *
 * The effect intentionally has NO dependencies beyond `engine`: changing
 * `size` resizes the backing store in place rather than restarting the loop,
 * so resizing the Lab never resets the animation state.
 */
export function AssistantAvatar({ engine, size = 466, onFps, className }: AssistantAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<CanvasAvatarRenderer | null>(null);
  const fpsRef = useRef(onFps);
  fpsRef.current = onFps;

  // ── Frame loop ────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new CanvasAvatarRenderer(canvas, engine.state, { size });
    rendererRef.current = renderer;
    // Size the backing store to the canvas's ACTUAL rendered size. Forcing the
    // nominal 466 would leave the canvas blurred whenever the responsive device
    // frame is narrower than that (i.e. on any phone).
    renderer.resize(canvas.clientWidth || size);

    let raf = 0;
    let last = performance.now();
    // FPS is accumulated over a 0.5 s window; reporting a per-frame 1/dt makes
    // the readout unreadable.
    let fpsAccum = 0;
    let fpsFrames = 0;

    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 15);
      last = now;
      engine.step(dt);
      renderer.render(engine.pose, engine.signals, engine.state, dt);

      fpsAccum += dt;
      fpsFrames += 1;
      if (fpsAccum >= 0.5) {
        if (fpsRef.current) fpsRef.current(fpsFrames / fpsAccum);
        fpsAccum = 0;
        fpsFrames = 0;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onResize = () => renderer.resize(canvas.clientWidth || undefined);
    window.addEventListener('resize', onResize);
    // ResizeObserver catches layout changes that never fire a window resize
    // (a parent reflow, a CSS variable change, an orientation flip).
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onResize);
      ro.observe(canvas);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      rendererRef.current = null;
    };
  }, [engine, size]);

  // ── Touch / pointer -> interaction ────────────────────────────────────
  // The host's ONLY job is to convert events into normalised positions and
  // hand them to the engine. Recognition — tap vs drag vs swipe vs long press —
  // lives in `core/interaction.ts`, so the StopWatch firmware gets identical
  // behaviour from the same recogniser fed by its touch controller.
  //
  // This is the seam that becomes a BMI270 IMU driver too: swapping the
  // producer of (x, y) changes nothing downstream.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Normalise a client position into the surface's -1..1 space.
    const norm = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * 2 - 1;
      const y = ((clientY - rect.top) / rect.height) * 2 - 1;
      // Small dead-zone so a finger resting near the middle does not make the
      // eyes twitch — the same reason the IMU driver will need a tilt
      // dead-zone.
      const dz = (v: number) => (Math.abs(v) < 0.05 ? 0 : (v - Math.sign(v) * 0.05) / 0.95);
      return { x: Math.max(-1, Math.min(1, dz(x))), y: Math.max(-1, Math.min(1, dz(y))) };
    };

    // The engine owns its own monotonic clock (advanced by `step(dt)`), so
    // gesture timing is frame-driven and identical on a 30 fps device and a
    // 120 fps one. The host supplies event ORDER only — no timestamps.

    const onDown = (e: PointerEvent) => {
      // Capture so a drag that leaves the canvas still delivers move/up, which
      // is what makes dragging the ball past its own edge feel continuous.
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      const p = norm(e.clientX, e.clientY);
      engine.touchDown(p.x, p.y);
      // Feed the gaze immediately so the eyes snap to the finger on contact
      // rather than waiting for the first move.
      engine.pointerSource?.set(p.x, p.y);
    };

    const onMove = (e: PointerEvent) => {
      const p = norm(e.clientX, e.clientY);
      engine.touchMove(p.x, p.y);
      // While the head is being dragged the eyes stay put relative to the face:
      // the turn itself is what moves them, which is what direct manipulation
      // should feel like. Otherwise the gaze follows the finger.
      if (!engine.touch.dragging) engine.pointerSource?.set(p.x, p.y);
    };

    const onUp = (e: PointerEvent) => {
      const p = norm(e.clientX, e.clientY);
      engine.touchMove(p.x, p.y);
      engine.touchUp();
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };

    const onCancel = () => engine.touchCancel();

    // `pointercancel` fires when the browser takes over the gesture (a scroll,
    // a system swipe). Treating it as a cancel rather than an up prevents a
    // half-finished drag from being reported as a tap.
    // NOTE: `pointerleave` is deliberately NOT wired to cancel. With pointer
    // capture a drag legitimately leaves the canvas, so cancelling there would
    // abort every drag that exits the ball. `pointercancel` is the correct
    // signal — it fires when the BROWSER takes the gesture over.
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    // Releasing outside the canvas must still end the press.
    canvas.addEventListener('lostpointercapture', onCancel);

    // Touch needs `touch-action: none` or the browser scrolls the page instead
    // of delivering move events. Set here rather than in CSS so the behaviour
    // travels with the component.
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'grab';

    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('lostpointercapture', onCancel);
    };
  }, [engine]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: '100%', height: '100%', display: 'block' }}
      aria-label="Personal Assistant avatar"
      role="img"
    />
  );
}
