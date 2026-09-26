/**
 * styles.ts — the plugin's injected stylesheet.
 *
 * Injected from JS rather than shipped as a separate CSS file because a DSH
 * client plugin is loaded as a single module by the vendored Cordis loader;
 * a runtime `<style>` tag keeps the plugin one self-contained artifact.
 *
 * Everything is namespaced under `avatar-lab-` and scoped so the plugin cannot
 * leak styles into the host GUI.
 */

export const PLUGIN_CSS = `
/* ── Launcher ──────────────────────────────────────────────────────────── */
.avatar-lab-launcher {
  position: fixed;
  right: 18px;
  /* The bottom-right corner is already occupied by the DSH balance widget
     (a fixed 0/0 anchor with an edge of min(250px, min(100vw,100vh) * 0.28)).
     Rather than hard-coding a clearance that goes stale if that widget is
     resized, this repeats its exact sizing formula and sits one gap above it,
     so the two can never overlap at any viewport size. */
  bottom: calc(min(250px, min(100vw, 100vh) * 0.28) + 18px);
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 15px 6px 6px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 999px;
  background: rgba(10, 12, 17, 0.9);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: #c8d2e2;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  font-size: 12px;
  letter-spacing: 0.2px;
  cursor: pointer;
  pointer-events: auto;
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.55);
  transition: border-color 0.18s ease, transform 0.18s ease, background 0.18s ease;
}

.avatar-lab-launcher:hover {
  border-color: rgba(110, 168, 254, 0.42);
  background: rgba(14, 17, 24, 0.95);
  transform: translateY(-1px);
}

.avatar-lab-launcher[data-open] {
  border-color: rgba(110, 168, 254, 0.6);
}

.avatar-lab-launcher-label {
  font-weight: 500;
}

/* ── Overlay ───────────────────────────────────────────────────────────── */
.avatar-lab-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  background: #08090c;
  pointer-events: auto;
  animation: avatarLabIn 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}

@keyframes avatarLabIn {
  from { opacity: 0; transform: scale(0.995); }
  to   { opacity: 1; transform: scale(1); }
}

.avatar-lab-overlay-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 11px;
  height: 46px;
  padding: 0 8px 0 20px;
  border-bottom: 1px solid #171a20;
  background: #0b0d11;
}

.avatar-lab-overlay-title {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif;
  font-size: 13px;
  font-weight: 600;
  color: #e6e9ef;
  letter-spacing: 0.2px;
}

.avatar-lab-overlay-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: #5b6273;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid #1e222a;
}

.avatar-lab-close {
  margin-left: auto;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: #8b93a3;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.avatar-lab-close:hover {
  background: #171a20;
  color: #e6e9ef;
}

.avatar-lab-overlay-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

/* The Lab's own root already paints a full background; inside the overlay it
   only needs to fill the available height. */
.avatar-lab-overlay-body > * {
  min-height: 100%;
}

@media (prefers-reduced-motion: reduce) {
  .avatar-lab-overlay { animation: none; }
  .avatar-lab-launcher { transition: none; }
}

/* On narrow viewports the launcher shrinks to just the avatar. */
@media (max-width: 640px) {
  .avatar-lab-launcher { padding: 6px; }
  .avatar-lab-launcher-label { display: none; }
}

/* Short viewports: the widget's clearance would push the launcher off-screen,
   so dock it to the left edge instead of stacking. */
@media (max-height: 420px) {
  .avatar-lab-launcher {
    bottom: 14px;
    right: auto;
    left: 14px;
  }
}
`;

/** Inject the stylesheet once, tagged so a hot reload can find it again. */
export function injectStyles(id: string): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector(`style[data-plugin-css="${id}"]`)) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'avatar-lab';
  tag.dataset.pluginCss = id;
  tag.textContent = PLUGIN_CSS;
  document.head.appendChild(tag);
}
