/**
 * banner.mjs — compose the README header image.
 *
 * Built from the REAL renderer rather than drawn by hand: the sphere in the
 * banner is the actual avatar, rendered by the same code path the Lab uses. A
 * hand-drawn hero would drift from the product the first time the palette or
 * proportions changed.
 *
 * Output: docs/banner.png (1280x400, the size GitHub renders header images at
 * without downscaling).
 */

import { chromium } from 'playwright';
import { resolve } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5199/avatar-lab.html';
const OUT = resolve(process.argv[3] ?? 'docs/banner.png');

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 400 }, deviceScaleFactor: 2 });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// Render the hero avatar and a small strip of expression states, all through
// the real renderer so the banner cannot fall out of sync with the product.
const images = await page.evaluate(async () => {
  const R = window.__avatarRenderer;
  const P = window.__avatarPose;
  const sig = {
    audioEnvelope: 0, mouthLevel: 0, blink: 0, lastSaccade: '', ambientDriftX: 0,
    ambientDriftY: 0, ambientSquash: 0, syntheticPulse: 0, stateTime: 0,
    gesture: '', gestureZzz: 0,
  };
  const scratch = document.createElement('canvas');

  /** Render one pose at `px` and return a data URL. */
  const draw = (px, patch, stateKey = 'idle') => {
    scratch.width = px;
    scratch.height = px;
    const r = new R(scratch, stateKey, { size: 466 });
    r.resize(px);
    r.render({ ...P, ...patch }, sig, stateKey, 1 / 60);
    return scratch.toDataURL('image/png');
  };

  // The hero: the REAL idle pose (a tall capsule, `eyeRound -0.55`) with a
  // gentle turn so the sphere warp reads even in a still. Two earlier attempts
  // failed here — a bare NEUTRAL_POSE has round eyes and no capsule character,
  // and a large yaw rotated the face too far to read as an expression.
  const hero = draw(560, {
    eyeRound: -0.55,
    headYaw: 0.16,
    headPitch: -0.03,
    eyeOffsetX: 0.14,
    eyeOffsetY: -0.05,
  });

  // The strip: one frame per expression, the range of the character at a glance.
  const strip = [
    ['idle', { eyeRound: -0.55 }],
    ['listening', { eyeRound: -0.78, eyeSize: 1.08 }],
    ['thinking', { eyeRound: -0.5, eyeRoundL: 0.3, eyeRoundR: -0.05, browOpen: 1, browTiltL: 0.16, browTiltR: -0.06 }],
    ['waiting_approval', { eyeRound: -0.95, eyeSize: 1.1, browOpen: 1, browLiftL: 0.08, browLiftR: 0.08 }],
    ['speaking', { eyeRound: -0.15, eyeSize: 1.03, eyeBowL: 0.2, eyeBowR: 0.2 }],
    ['success', { eyeRound: 1, eyeBowL: 0.85, eyeBowR: 0.85, eyeLiftL: 0.05, eyeLiftR: 0.05 }],
    ['error', { eyeRound: 0.9, eyeBowL: -0.85, eyeBowR: -0.85, browOpen: 1, browTiltL: 0.34, browTiltR: 0.34 }],
    ['sleeping', { eyeOpen: 0, eyeRound: 1, eyeBowL: -0.3, eyeBowR: -0.3 }],
  ].map(([key, patch]) => draw(150, patch, key));

  return { hero, strip };
});

const stripCells = images.strip
  .map((png) => `<img src="${png}" style="width:100%;display:block;border-radius:50%"/>`)
  .join('');

await page.setContent(`
<body style="margin:0;background:#08080a">
<div style="width:1280px;height:400px;position:relative;overflow:hidden;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;
            background:radial-gradient(720px 460px at 84% 46%, #16171c 0%, #0b0b0e 58%, #08080a 100%)">

  <!-- The hero avatar. Rendered by the real renderer, so it can never disagree
       with the product. Sized and placed so the FACE is fully visible — the
       eyes are the product, and a cropped sphere is just a grey blob. -->
  <img src="${images.hero}" style="position:absolute;right:46px;top:38px;width:324px;height:324px"/>

  <!-- Left column: wordmark and the one-line description. -->
  <div style="position:absolute;left:64px;top:92px;width:700px">
    <div style="font-size:74px;font-weight:680;letter-spacing:-2.4px;color:#f2f4f8;line-height:1">ocelli</div>
    <div style="margin-top:20px;font-size:19px;line-height:1.55;color:#9aa3b4;max-width:520px">
      A procedural Personal&nbsp;Assistant avatar with two independently
      morphing capsule eyes, projected onto a virtual sphere.
    </div>
    <!-- One line, no wrap: a wrapped feature list reads as broken layout. -->
    <div style="margin-top:20px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
                font-size:12.5px;letter-spacing:0.3px;color:#5f6878;white-space:nowrap">
      renderer-agnostic core&nbsp; ·&nbsp; 10 states&nbsp; ·&nbsp; 10 gestures&nbsp; ·&nbsp; canvas 2D&nbsp; ·&nbsp; 466 × 466 round AMOLED
    </div>
  </div>

  <!-- Bottom strip: the expression range, left to right. -->
  <div style="position:absolute;left:64px;bottom:30px;display:grid;
              grid-template-columns:repeat(8,44px);gap:14px;opacity:0.95">
    ${stripCells}
  </div>
</div>
</body>`);

await page.waitForTimeout(600);
await page.screenshot({ path: OUT });
await browser.close();
console.log(`banner written -> ${OUT}`);
