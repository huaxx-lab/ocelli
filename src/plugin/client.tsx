/**
 * client.tsx — the DSH Web client half of the Avatar Lab plugin.
 *
 * Registers two things into the Harness GUI:
 *
 *   1. `shell.overlay` — a floating launcher (a *live miniature avatar*) plus
 *      the full-screen Avatar Lab overlay it opens. The launcher runs the same
 *      engine at 64 px, so the assistant is visibly present in the GUI even
 *      when the Lab is closed.
 *   2. Nothing else. The brief is explicit that this round must not refactor
 *      the existing Harness UI, so the plugin is purely additive: it never
 *      touches an existing slot's occupant.
 *
 * The overlay is `pointer-events: none` by default (that is the shell.overlay
 * contract) and opts back in only on its own children, so the underlying GUI
 * stays fully interactive around it.
 */

import * as React from 'react';
import { AvatarLab } from '../avatar/components/AvatarLab';
import { AvatarEngine } from '../avatar/core/behavior';
import { CanvasAvatarRenderer } from '../avatar/renderer/web/canvasRenderer';
import { injectStyles } from './styles';

/** The overlay's own minimal style sheet, injected once. */
const STYLE_ID = 'avatar-lab-plugin-styles';

/**
 * The live miniature avatar shown in the launcher button.
 *
 * A second, independent engine instance running at 64 px. It exists so the GUI
 * has a *resident* assistant rather than an icon — which is the whole premise
 * of the project. It is deliberately cheap: 64 px, no interaction.
 */
function MiniAvatar({ engine }: { engine: AvatarEngine }) {
  const ref = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const renderer = new CanvasAvatarRenderer(canvas, engine.state, { size: 64 });
    renderer.resize(64);
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 15);
      last = now;
      engine.step(dt);
      renderer.render(engine.pose, engine.signals, engine.state, dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  return React.createElement('canvas', {
    ref,
    width: 64,
    height: 64,
    style: { width: 64, height: 64, display: 'block', borderRadius: '50%' },
    'aria-hidden': true,
  });
}

/**
 * The floating launcher + overlay.
 *
 * Kept as one component so the open/closed state lives beside the launcher
 * that toggles it.
 */
function AvatarLabOverlay() {
  const [open, setOpen] = React.useState(false);
  // The launcher's own engine: seeded differently from the Lab's so the two
  // are not visibly in lockstep, which would look like a mirror rather than
  // two creatures.
  const miniEngine = React.useMemo(() => {
    const engine = new AvatarEngine({ seed: 0xa9a71c });
    // A slow ambient cycle keeps the miniature interesting without input.
    engine.setState('idle', {}, true);
    return engine;
  }, []);

  // Reflect the open state onto <html> so the shell can suppress scrolling.
  React.useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return React.createElement(
    React.Fragment,
    null,
    // ── Launcher ──────────────────────────────────────────────────────
    React.createElement(
      'button',
      {
        type: 'button',
        className: 'avatar-lab-launcher',
        onClick: () => setOpen((v) => !v),
        title: open ? 'Close Avatar Lab' : 'Open Avatar Lab',
        'aria-label': open ? 'Close Avatar Lab' : 'Open Avatar Lab',
        'aria-expanded': open,
        'data-open': open || undefined,
      },
      React.createElement(MiniAvatar, { engine: miniEngine }),
      React.createElement(
        'span',
        { className: 'avatar-lab-launcher-label' },
        open ? 'Close' : 'Avatar',
      ),
    ),

    // ── Full Lab overlay ──────────────────────────────────────────────
    open
      ? React.createElement(
          'div',
          {
            className: 'avatar-lab-overlay',
            role: 'dialog',
            'aria-modal': true,
            'aria-label': 'Avatar Lab',
          },
          React.createElement(
            'div',
            { className: 'avatar-lab-overlay-bar' },
            React.createElement('span', { className: 'avatar-lab-overlay-title' }, 'Avatar Lab'),
            React.createElement(
              'span',
              { className: 'avatar-lab-overlay-path' },
              '/avatar-lab',
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'avatar-lab-close',
                onClick: () => setOpen(false),
                'aria-label': 'Close Avatar Lab',
              },
              '✕',
            ),
          ),
          React.createElement(
            'div',
            { className: 'avatar-lab-overlay-body' },
            React.createElement(AvatarLab, null),
          ),
        )
      : null,
  );
}

export default {
  /**
   * `slots` is a HARD dependency, declared here rather than probed with
   * `ctx.get('slots')`.
   *
   * This matters: a plugin whose `apply` runs before the slot registry exists
   * would take the "absent service" branch, return without registering
   * anything, and never be retried — the launcher would simply never appear.
   * Declaring the injection makes Cordis park this package until the service
   * is provided, then activate it. (The probe-and-bail form is correct only
   * for genuinely optional capabilities.)
   */
  inject: ['slots'],
  apply(ctx: {
    slots: {
      inject(name: string, cb: () => unknown): void;
      register(options: Record<string, unknown>, component: unknown): () => void;
    };
  }) {
    injectStyles(STYLE_ID);

    const slots = ctx.slots;
    if (!slots) return;

    // `shell.overlay` is a list slot rendered above the AppFrame. It is
    // click-through until an entry opts into pointer events, which the CSS
    // above does per-child.
    slots.inject('shell.overlay', () =>
      slots.register(
        {
          name: 'shell.overlay',
          id: 'avatar-lab',
          // Above the whale widget (which uses default ordering) so the Lab
          // is never trapped behind another overlay.
          order: 60,
        },
        AvatarLabOverlay,
      ),
    );
  },
};
