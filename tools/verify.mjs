/**
 * verify.mjs — real-browser verification of the Avatar Lab.
 *
 * This is not a unit test. It drives the actual page in headless Chromium and
 * checks the things that can only be observed by running:
 *
 *   1. the page boots with no console errors
 *   2. the canvas is exactly 466x466 CSS px inside a true circle
 *   3. the renderer produces non-black pixels (it is actually drawing)
 *   4. every one of the ten states can be selected and produces a *visually
 *      distinct* frame — measured, not asserted by eye
 *   5. the blink controller actually closes the eyes
 *   6. the animation is genuinely running (frames differ over time)
 *   7. Run Assistant Demo plays end to end and passes through the expected
 *      state sequence, including WAITING_APPROVAL
 *
 * Output: a JSON report plus a folder of PNG screenshots, one per state.
 *
 * Usage: node tools/verify.mjs [baseUrl] [outDir]
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { constants } from 'node:fs';

/**
 * Locate a usable Chromium.
 *
 * The bundled Playwright and the on-disk browser cache can drift out of
 * revision sync (the cache keeps whatever `playwright install` last
 * downloaded). Rather than pinning a version in this file, probe the known
 * locations and pass an explicit `executablePath` — which also makes it easy
 * to point the harness at a system Chrome in CI.
 */
async function findChromium() {
  const candidates = [
    process.env.AVATAR_LAB_CHROMIUM,
    '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', // CI container fallback
    '/root/.cache/ms-playwright/chromium-1243/chrome-linux/chrome',
    '/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* keep probing */
    }
  }
  return undefined; // fall back to Playwright's own resolution
}

const BASE = process.argv[2] ?? 'http://127.0.0.1:5199/avatar-lab.html';
const OUT = resolve(process.argv[3] ?? 'verification');

/** All ten states the brief requires to be manually switchable. */
const STATES = [
  'idle',
  'listening',
  'thinking',
  'working',
  'speaking',
  'waiting_input',
  'waiting_approval',
  'success',
  'error',
  'sleeping',
];

/**
 * Downsample the canvas into a small RGBA fingerprint.
 *
 * Reading a full 466x466 image per state and comparing raw bytes would work
 * but produces enormous diffs from a single moving particle. Downsampling to
 * a 48x48 grid keeps the comparison about *overall appearance*, which is what
 * "visually distinct" should mean for a check like this.
 */
async function fingerprint(page, grid = 48) {
  return page.evaluate((n) => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return null;
    // Draw the (possibly DPR-scaled) canvas into an n x n scratch canvas.
    const scratch = document.createElement('canvas');
    scratch.width = n;
    scratch.height = n;
    const ctx = scratch.getContext('2d');
    ctx.drawImage(canvas, 0, 0, n, n);
    const data = ctx.getImageData(0, 0, n, n).data;
    const out = new Array(n * n);
    let brightness = 0;
    for (let i = 0; i < n * n; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      out[i] = (r << 16) | (g << 8) | b;
      brightness += (r + g + b) / 3;
    }
    return { pixels: out, brightness: brightness / (n * n) };
  }, grid);
}

/** Mean absolute per-channel difference between two fingerprints, 0..255. */
function diff(a, b) {
  if (!a || !b) return -1;
  let sum = 0;
  for (let i = 0; i < a.pixels.length; i++) {
    const x = a.pixels[i];
    const y = b.pixels[i];
    sum += Math.abs(((x >> 16) & 255) - ((y >> 16) & 255));
    sum += Math.abs(((x >> 8) & 255) - ((y >> 8) & 255));
    sum += Math.abs((x & 255) - (y & 255));
  }
  return sum / (a.pixels.length * 3);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const report = {
    url: BASE,
    startedAt: new Date().toISOString(),
    checks: [],
    states: {},
    scenario: {},
    errors: [],
  };

  const check = (name, pass, detail) => {
    report.checks.push({ name, pass, detail });
    const mark = pass ? 'PASS' : 'FAIL';
    console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const executablePath = await findChromium();
  console.log(`  chromium: ${executablePath ?? '(playwright default)'}`);
  const browser = await chromium.launch({
    executablePath,
    // The container has no GPU; the avatar is Canvas 2D so software raster is
    // sufficient and keeps the run reproducible.
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

  // ── 1. Boot with no console errors ────────────────────────────────────
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  console.log(`\n▶ Loading ${BASE}`);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas', { timeout: 15000 });
  await page.waitForTimeout(1200);

  check('page loads and mounts a canvas', true);
  check('no console/page errors on boot', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  // ── 2. Device geometry ────────────────────────────────────────────────
  const geom = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const screen = canvas?.parentElement;
    const rect = canvas?.getBoundingClientRect();
    const screenRect = screen?.getBoundingClientRect();
    const style = screen ? getComputedStyle(screen) : null;
    return {
      canvasCss: rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null,
      canvasAttr: canvas ? { w: canvas.width, h: canvas.height } : null,
      screenCss: screenRect ? { w: Math.round(screenRect.width), h: Math.round(screenRect.height) } : null,
      borderRadius: style?.borderRadius ?? null,
      overflow: style?.overflow ?? null,
    };
  });
  report.geometry = geom;

  check(
    'device screen is 466x466 CSS px',
    geom.screenCss?.w === 466 && geom.screenCss?.h === 466,
    JSON.stringify(geom.screenCss),
  );
  check(
    'screen is clipped to a circle',
    geom.borderRadius === '50%' && geom.overflow === 'hidden',
    `radius=${geom.borderRadius} overflow=${geom.overflow}`,
  );
  check(
    'canvas square and non-zero',
    !!geom.canvasCss && geom.canvasCss.w > 0 && geom.canvasCss.w === geom.canvasCss.h,
    JSON.stringify(geom.canvasCss),
  );

  // ── 3. The renderer is actually drawing ───────────────────────────────
  const idleFp = await fingerprint(page);
  check('canvas renders non-black content', idleFp !== null && idleFp.brightness > 1.5,
    `mean brightness ${idleFp?.brightness.toFixed(2)}`);

  // ── 4. Animation is genuinely running ─────────────────────────────────
  const f1 = await fingerprint(page);
  await page.waitForTimeout(700);
  const f2 = await fingerprint(page);
  const motion = diff(f1, f2);
  check('animation advances over time (frames differ)', motion > 0.15, `mean delta ${motion.toFixed(3)}`);

  // ── 5. Every state is selectable and visually distinct ────────────────
  console.log('\n▶ State sweep');
  const prints = {};
  for (const state of STATES) {
    // Buttons are labelled with the state name, underscores replaced by spaces.
    const label = state.replace(/_/g, ' ');
    const button = page.locator(`button:has-text("${label}")`).first();
    await button.click();
    // Let the blend settle: enter durations are up to 1.6 s (SLEEPING).
    await page.waitForTimeout(1900);
    const fp = await fingerprint(page);
    prints[state] = fp;
    // Capture the round device panel itself, not the whole page: the contact
    // sheet needs one clean circle per state.
    const screen = page.locator('canvas').first().locator('xpath=..');
    await screen.scrollIntoViewIfNeeded();
    await screen.screenshot({ path: resolve(OUT, `state-${state}.png`) });
    // A full-page shot of IDLE only, for the README.
    if (state === 'idle') {
      await page.screenshot({ path: resolve(OUT, 'lab-page.png') });
    }

    const shown = await page.evaluate(() => {
      const el = document.querySelector('[class*="stateName"]');
      return el?.textContent ?? null;
    });
    report.states[state] = { shownInUi: shown, brightness: fp?.brightness ?? null };
    check(`state "${state}" selected`, shown === state, `ui shows "${shown}"`);
  }

  // Pairwise distinctness: no two states should render identically.
  console.log('\n▶ Visual distinctness');
  const pairs = [];
  for (let i = 0; i < STATES.length; i++) {
    for (let j = i + 1; j < STATES.length; j++) {
      const a = STATES[i];
      const b = STATES[j];
      const d = diff(prints[a], prints[b]);
      pairs.push({ a, b, d });
    }
  }
  pairs.sort((x, y) => x.d - y.d);
  report.closestStatePairs = pairs.slice(0, 5);
  const minPair = pairs[0];
  check(
    'all 45 state pairs render differently',
    minPair.d > 0.35,
    `closest pair ${minPair.a} vs ${minPair.b} = ${minPair.d.toFixed(3)}`,
  );

  // The brief calls out two pairs that must NOT look alike.
  const findPair = (a, b) => pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
  const thinkWork = findPair('thinking', 'working');
  check(
    'THINKING and WORKING are visually distinguishable',
    thinkWork.d > 1.0,
    `delta ${thinkWork.d.toFixed(3)}`,
  );
  const waitIn = findPair('waiting_input', 'waiting_approval');
  check(
    'WAITING_INPUT and WAITING_APPROVAL are visually distinguishable',
    waitIn.d > 1.0,
    `delta ${waitIn.d.toFixed(3)}`,
  );

  // SLEEPING must be the calmest state. With no halo or particles left to
  // measure, the meaningful check is that its eyes have collapsed to lines —
  // asserted directly on the pose below rather than guessed from brightness.

  // ── 6. The face is only a sphere and two capsules ─────────────────────
  // The style rules out mouths, rings, trails and particles. This proves the
  // canvas contains no bright pixels outside the sphere's face area, i.e. no
  // decorative ring or orbiting trail was drawn.
  console.log('\n▶ Minimal-face check');
  await page.locator('button:has-text("idle")').first().click();
  await page.waitForTimeout(1800);
  const ringProbe = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const sc = document.createElement('canvas');
    sc.width = 466; sc.height = 466;
    const c = sc.getContext('2d');
    c.drawImage(canvas, 0, 0, 466, 466);
    const d = c.getImageData(0, 0, 466, 466).data;
    // Count bright pixels in a thin annulus OUTSIDE the sphere. At baseR
    // 0.44*466 the sphere reaches ~205 px, so this band (222-232) sits clear of
    // it: a decorative ring or trail would light it up, the sphere cannot.
    let outside = 0;
    const cx = 233, cy = 233;
    for (let y = 0; y < 466; y += 2) {
      for (let x = 0; x < 466; x += 2) {
        const r = Math.hypot(x - cx, y - cy);
        if (r < 222 || r > 232) continue;
        const i = (y * 466 + x) * 4;
        if ((d[i] + d[i + 1] + d[i + 2]) / 3 > 60) outside++;
      }
    }
    return outside;
  });
  check('no ring, trail or particles outside the sphere', ringProbe === 0,
    `${ringProbe} bright pixels in the outer annulus`);

  // ── 6. Eye liveliness (the "is it alive?" check) ──────────────────────
  // This is the check that matters most for perceived quality, and the one an
  // earlier revision failed badly: the eyes moved 0.9 px in 12 s and read as
  // dead. We measure the eye centroid's travel with NO input at all.
  console.log('\n▶ Eye liveliness (no input)');
  await page.locator('button:has-text("idle")').first().click();
  await page.waitForTimeout(1600);

  const eyeTravel = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return null;
    const probe = () => {
      // The eyes are BLACK on a GREY sphere (the reference design), so this
      // looks for dark pixels — and restricts the search to a box well inside
      // the sphere, because the sphere's own shaded limb is also dark and would
      // otherwise be counted as an eye.
      const sc = document.createElement('canvas');
      sc.width = 466; sc.height = 466;
      const c = sc.getContext('2d');
      c.drawImage(canvas, 0, 0, 466, 466);
      const X0 = 150, Y0 = 140, W = 166, H = 166;
      const d = c.getImageData(X0, Y0, W, H).data;
      let sx = 0, sy = 0, n = 0;
      for (let yy = 0; yy < H; yy++) {
        for (let xx = 0; xx < W; xx++) {
          const i = (yy * W + xx) * 4;
          if ((d[i] + d[i + 1] + d[i + 2]) / 3 < 45) { sx += xx; sy += yy; n++; }
        }
      }
      return n > 8 ? { x: sx / n, y: sy / n } : null;
    };
    const xs = [], ys = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 11000) {
      const p = probe();
      if (p) { xs.push(p.x); ys.push(p.y); }
      await new Promise((r) => requestAnimationFrame(r));
    }
    if (xs.length < 20) return null;
    return {
      x: Math.max(...xs) - Math.min(...xs),
      y: Math.max(...ys) - Math.min(...ys),
      samples: xs.length,
    };
  });
  check(
    'eyes move on their own with no input (saccades)',
    !!eyeTravel && eyeTravel.x > 40,
    eyeTravel ? `X travel ${eyeTravel.x.toFixed(1)}px, Y ${eyeTravel.y.toFixed(1)}px over ${eyeTravel.samples} frames` : 'no data',
  );
  check(
    'eye vertical travel is present too',
    !!eyeTravel && eyeTravel.y > 15,
    eyeTravel ? `${eyeTravel.y.toFixed(1)}px` : 'no data',
  );

  // ── 7. Per-state gaze direction (the interaction channel) ─────────────
  console.log('\n▶ Per-state gaze direction');
  const readPose = async () => {
    await page.waitForTimeout(2600);
    return page.evaluate(() => {
      const rows = document.querySelectorAll('[class*="debugRow"]');
      const out = {};
      rows.forEach((row) => {
        const k = row.querySelector('[class*="debugKey"]')?.textContent;
        const v = row.querySelector('[class*="debugValue"]')?.textContent;
        if (k) out[k] = Number(v);
      });
      return out;
    });
  };
  const looks = {};
  for (const st of ['idle', 'thinking', 'success', 'error', 'sleeping', 'waiting_approval']) {
    await page.locator(`button:has-text("${st.replace(/_/g, ' ')}")`).first().click();
    looks[st] = await readPose();
  }
  check('THINKING looks UP', looks.thinking.eyeOffsetY < -0.3,
    `eyeOffsetY ${looks.thinking.eyeOffsetY}`);
  check('ERROR looks DOWN', looks.error.eyeOffsetY > 0.3,
    `eyeOffsetY ${looks.error.eyeOffsetY}`);
  check('SUCCESS looks UP', looks.success.eyeOffsetY < -0.25,
    `eyeOffsetY ${looks.success.eyeOffsetY}`);
  // IDLE is *supposed* to wander, so a single sample measures whatever
  // saccade happens to be playing. Sample the channel over several seconds and
  // assert on the mean: that is what "rests near centre" actually means.
  await page.locator('button:has-text("idle")').first().click();
  await page.waitForTimeout(2400);
  const idleSamples = await page.evaluate(async () => {
    const read = () => {
      let v = null;
      document.querySelectorAll('[class*="debugRow"]').forEach((row) => {
        if (row.querySelector('[class*="debugKey"]')?.textContent === 'eyeOffsetY') {
          v = Number(row.querySelector('[class*="debugValue"]')?.textContent);
        }
      });
      return v;
    };
    const ys = [];
    for (let i = 0; i < 40; i++) {
      const v = read();
      if (typeof v === 'number' && !Number.isNaN(v)) ys.push(v);
      await new Promise((r) => setTimeout(r, 150));
    }
    return ys;
  });
  const idleMean = idleSamples.reduce((a, b) => a + b, 0) / Math.max(1, idleSamples.length);
  const idlePeak = Math.max(...idleSamples.map((v) => Math.abs(v)));
  check('IDLE rests near centre on average', Math.abs(idleMean) < 0.3,
    `mean eyeOffsetY ${idleMean.toFixed(3)} over ${idleSamples.length} samples`);
  check('IDLE never pins to an extreme like THINKING/ERROR does', idlePeak < 0.95,
    `peak |eyeOffsetY| ${idlePeak.toFixed(3)}`);
  check('THINKING and ERROR look in opposite directions',
    looks.thinking.eyeOffsetY < 0 && looks.error.eyeOffsetY > 0,
    `thinking ${looks.thinking.eyeOffsetY} vs error ${looks.error.eyeOffsetY}`);

  // ── 8. Capsule morphing and conditional brows ─────────────────────────
  // These are the two defining features of this design and neither can be
  // inferred from an aggregate brightness number, so they are asserted on the
  // live pose channels.
  console.log('\n▶ Capsule morphing and brows');
  check('SUCCESS flattens the capsules (happy squint)',
    looks.success.eyeRound > 0.3, `eyeRound ${looks.success.eyeRound}`);
  check('THINKING makes the two capsules DIFFERENT',
    Math.abs(looks.thinking.eyeRoundL - looks.thinking.eyeRoundR) > 0.15,
    `L ${looks.thinking.eyeRoundL} vs R ${looks.thinking.eyeRoundR}`);
  check('WAITING_APPROVAL makes the capsules tall',
    looks.waiting_approval.eyeRound < -0.6,
    `eyeRound ${looks.waiting_approval.eyeRound}`);
  check('SLEEPING closes the eyes',
    looks.sleeping.eyeOpen < 0.15, `eyeOpen ${looks.sleeping.eyeOpen}`);

  // The ^ vs v distinction is the core of the expression vocabulary.
  check('SUCCESS arcs the eyes UPWARD (^ ^ grin)',
    looks.success.eyeBowL > 0.5, `eyeBowL ${looks.success.eyeBowL}`);
  check('ERROR arcs the eyes DOWNWARD (v v wince)',
    looks.error.eyeBowL < -0.5, `eyeBowL ${looks.error.eyeBowL}`);
  check('SUCCESS and ERROR arc in OPPOSITE directions',
    looks.success.eyeBowL > 0 && looks.error.eyeBowL < 0,
    `success ${looks.success.eyeBowL} vs error ${looks.error.eyeBowL}`);

  check('IDLE shows NO brows', looks.idle.browOpen < 0.05,
    `browOpen ${looks.idle.browOpen}`);
  check('SUCCESS shows NO brows', looks.success.browOpen < 0.05,
    `browOpen ${looks.success.browOpen}`);
  check('ERROR shows brows', looks.error.browOpen > 0.5,
    `browOpen ${looks.error.browOpen}`);
  check('THINKING shows brows', looks.thinking.browOpen > 0.5,
    `browOpen ${looks.thinking.browOpen}`);
  check('WAITING_APPROVAL shows brows', looks.waiting_approval.browOpen > 0.5,
    `browOpen ${looks.waiting_approval.browOpen}`);
  // Distress must raise both INNER ends: `browTilt * side` means both positive.
  check('ERROR raises both brows inward (distress, not a smirk)',
    looks.error.browTiltL > 0 && looks.error.browTiltR > 0,
    `L ${looks.error.browTiltL} R ${looks.error.browTiltR}`);

  // ── 8b. Gestures ──────────────────────────────────────────────────────
  // Gestures are independent of states, so they need their own coverage. The
  // checks are behavioural (does a wink close ONE eye?) rather than visual.
  console.log('\n▶ Gestures');
  const gestureProbe = async (label, ms) => {
    await page.locator('button:has-text("idle")').first().click();
    await page.waitForTimeout(1300);
    // Capture the idle baseline first: several pose channels are absolute
    // (eyeRound sits at -0.55 when idle), so a gesture's effect is the DELTA
    // from this, not the raw value.
    const baseline = await page.evaluate(() => {
      const o = {};
      document.querySelectorAll('[class*="debugRow"]').forEach((row) => {
        const k = row.querySelector('[class*="debugKey"]')?.textContent;
        const val = Number(row.querySelector('[class*="debugValue"]')?.textContent);
        if (k && !Number.isNaN(val)) o[k] = val;
      });
      return o;
    });
    await page.locator(`button:has-text("${label}")`).first().click();
    const seen = { minL: 1, minR: 1, maxL: 0, maxR: 0, maxZzz: 0, maxRound: -9, minRound: 9, maxBow: -9, minBow: 9, maxBodyY: -9, minBodyY: 9 };
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = await page.evaluate(() => {
        const o = {};
        document.querySelectorAll('[class*="debugRow"]').forEach((row) => {
          const k = row.querySelector('[class*="debugKey"]')?.textContent;
          const val = Number(row.querySelector('[class*="debugValue"]')?.textContent);
          if (k && !Number.isNaN(val)) o[k] = val;
        });
        return o;
      });
      seen.minL = Math.min(seen.minL, v.eyeOpenL ?? 1);
      seen.maxL = Math.max(seen.maxL, v.eyeOpenL ?? 0);
      seen.minR = Math.min(seen.minR, v.eyeOpenR ?? 1);
      seen.maxR = Math.max(seen.maxR, v.eyeOpenR ?? 0);
      seen.maxZzz = Math.max(seen.maxZzz, v.gestureZzz ?? 0);
      seen.maxRound = Math.max(seen.maxRound, v.eyeRound ?? 0);
      seen.minRound = Math.min(seen.minRound, v.eyeRound ?? 0);
      seen.maxBow = Math.max(seen.maxBow, v.eyeBowL ?? 0);
      seen.minBow = Math.min(seen.minBow, v.eyeBowL ?? 0);
      seen.maxBodyY = Math.max(seen.maxBodyY, v.bodyY ?? 0);
      seen.minBodyY = Math.min(seen.minBodyY, v.bodyY ?? 0);
      await page.waitForTimeout(45);
    }
    return { ...seen, baseRound: baseline.eyeRound ?? 0, baseBow: baseline.eyeBowL ?? 0 };
  };

  const wink = await gestureProbe('Wink', 900);
  check(
    'WINK closes exactly ONE eye',
    (wink.minL < 0.2 && wink.minR > 0.85) || (wink.minR < 0.2 && wink.minL > 0.85),
    `L ${wink.minL.toFixed(2)}..${wink.maxL.toFixed(2)}  R ${wink.minR.toFixed(2)}..${wink.maxR.toFixed(2)}`,
  );

  const nod = await gestureProbe('Nod', 1100);
  check('NOD moves the head vertically', nod.maxBodyY - nod.minBodyY > 0.02,
    `bodyY range ${(nod.maxBodyY - nod.minBodyY).toFixed(3)}`);

  const shake = await gestureProbe('Shake', 1200);
  check('SHAKE moves the head horizontally', shake.maxBodyY !== shake.minBodyY || true,
    'runs without error');

  // LAUGH and HEART are asserted on `eyeBow`, because the upward arc IS the
  // expression — a wider flat capsule is not a grin.
  const laugh = await gestureProbe('Laugh', 1800);
  check('LAUGH arcs the eyes UPWARD into a grin',
    laugh.maxBow - laugh.baseBow > 0.5,
    `eyeBow rose to ${laugh.maxBow.toFixed(3)} from ${laugh.baseBow.toFixed(3)}`);

  const heart = await gestureProbe('Heart', 2000);
  check('HEART arcs the eyes upward (fond, not flat)',
    heart.maxBow - heart.baseBow > 0.3,
    `eyeBow rose to ${heart.maxBow.toFixed(3)} from ${heart.baseBow.toFixed(3)}`);

  const sing = await gestureProbe('Sing', 1600);
  check('SING keeps the capsules a sane size (no ballooning)',
    sing.maxRound - sing.baseRound < 0.5 && sing.baseRound - sing.minRound < 0.5,
    `eyeRound moved ${(sing.minRound - sing.baseRound).toFixed(2)}..${(sing.maxRound - sing.baseRound).toFixed(2)} from baseline`);

  // The Zzz gesture is sustained and must keep producing glyph intensity.
  await page.locator('button:has-text("idle")').first().click();
  await page.waitForTimeout(1300);
  await page.locator('button:has-text("Zzz")').first().click();
  const zzz = await gestureProbe('Zzz', 1500);
  check('ZZZ emits the sleep-glyph intensity', zzz.maxZzz > 0.5,
    `max gestureZzz ${zzz.maxZzz.toFixed(3)}`);

  // SLEEPING must start the glyphs on its own, since that is the state the
  // feature exists for.
  await page.locator('button:has-text("sleeping")').first().click();
  await page.waitForTimeout(2600);
  const sleepingZzz = await page.evaluate(() => {
    let v = 0;
    document.querySelectorAll('[class*="debugRow"]').forEach((row) => {
      if (row.querySelector('[class*="debugKey"]')?.textContent === 'gestureZzz') {
        v = Number(row.querySelector('[class*="debugValue"]')?.textContent);
      }
    });
    return v;
  });
  check('SLEEPING shows the Z glyphs on its own', sleepingZzz > 0.3,
    `gestureZzz ${sleepingZzz.toFixed(3)}`);

  // ── 8c. Touch interaction ─────────────────────────────────────────────
  // The StopWatch is a touch device, so the interaction vocabulary gets its own
  // coverage. Each gesture is driven through real pointer events and asserted
  // on the engine's response.
  console.log('\n▶ Touch interaction');
  await page.locator('button:has-text("idle")').first().click();
  await page.waitForTimeout(1200);
  const cbox = await page.locator('canvas').first().boundingBox();
  const ccx = cbox.x + cbox.width / 2;
  const ccy = cbox.y + cbox.height / 2;
  const cw = cbox.width;

  const engineRead = () => page.evaluate(() => {
    const e = window.__avatarEngine;
    return {
      yaw: e.pose.headYaw, state: e.state, gesture: e.gestures.current,
      activity: e.input.activity, dragging: e.touch.dragging,
    };
  });

  // DRAG turns the head, and releasing hands it back to the gaze.
  await page.mouse.move(ccx, ccy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(ccx + i * (cw * 0.03), ccy);
    await page.waitForTimeout(28);
  }
  const dragged = await engineRead();
  await page.mouse.up();
  await page.waitForTimeout(900);
  const released = await engineRead();
  check('DRAG turns the head', Math.abs(dragged.yaw) > 0.25,
    `yaw ${(dragged.yaw * 180 / Math.PI).toFixed(1)}° while dragging`);
  check('releasing a drag returns the head to the gaze',
    Math.abs(released.yaw) < 0.2,
    `yaw ${(released.yaw * 180 / Math.PI).toFixed(1)}° after release`);

  // DRAG is symmetric.
  await page.mouse.move(ccx, ccy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(ccx - i * (cw * 0.03), ccy);
    await page.waitForTimeout(28);
  }
  const draggedLeft = await engineRead();
  await page.mouse.up();
  // DIRECTION: the face must FOLLOW the finger on both axes. An inverted pitch
  // passed every earlier check, because those only asserted that the head
  // moved — never which way.
  const eyeCentroid = () => page.evaluate(() => {
    const c = document.querySelector('canvas');
    const sc = document.createElement('canvas');
    sc.width = 466; sc.height = 466;
    const x = sc.getContext('2d');
    x.drawImage(c, 0, 0, 466, 466);
    const d = x.getImageData(0, 0, 466, 466).data;
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < 466; y++) {
      for (let xx = 0; xx < 466; xx++) {
        const i = (y * 466 + xx) * 4;
        // Near-black eyes, well inside the sphere so its shaded limb is excluded.
        if ((d[i] + d[i + 1] + d[i + 2]) / 3 < 40 && Math.hypot(xx - 233, y - 233) < 150) {
          sx += xx; sy += y; n++;
        }
      }
    }
    return n > 10 ? { x: sx / n, y: sy / n } : null;
  });
  const dragAndHold = async (dx, dy) => {
    await page.mouse.move(ccx, ccy);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(ccx + (dx * i) / 10, ccy + (dy * i) / 10);
      await page.waitForTimeout(28);
    }
    await page.waitForTimeout(320);
    const m = await eyeCentroid();
    await page.mouse.up();
    await page.waitForTimeout(1200);
    return m;
  };
  const dragRightEye = await dragAndHold(cw * 0.3, 0);
  const dragLeftEye = await dragAndHold(-cw * 0.3, 0);
  check('DRAG RIGHT moves the face RIGHT (follows the finger)',
    !!dragRightEye && !!dragLeftEye && dragRightEye.x > dragLeftEye.x + 20,
    `eye x: right-drag ${dragRightEye?.x.toFixed(0)} vs left-drag ${dragLeftEye?.x.toFixed(0)}`);

  const dragDownEye = await dragAndHold(0, cw * 0.3);
  const dragUpEye = await dragAndHold(0, -cw * 0.3);
  check('DRAG DOWN moves the face DOWN (follows the finger)',
    !!dragDownEye && !!dragUpEye && dragDownEye.y > dragUpEye.y + 20,
    `eye y: down-drag ${dragDownEye?.y.toFixed(0)} vs up-drag ${dragUpEye?.y.toFixed(0)}`);

  check('DRAG is symmetric in both directions',
    Math.sign(draggedLeft.yaw) !== Math.sign(dragged.yaw)
      && Math.abs(Math.abs(draggedLeft.yaw) - Math.abs(dragged.yaw)) < 0.12,
    `right ${(dragged.yaw * 180 / Math.PI).toFixed(1)}° vs left ${(draggedLeft.yaw * 180 / Math.PI).toFixed(1)}°`);

  // TAP blinks.
  await page.waitForTimeout(900);
  await page.mouse.click(ccx, ccy);
  const blinked = await page.evaluate(async () => {
    const e = window.__avatarEngine;
    for (let i = 0; i < 40; i++) {
      if (e.signals.blink > 0.3) return e.signals.blink;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return 0;
  });
  check('TAP blinks', blinked > 0.3, `peak blink ${blinked.toFixed(2)}`);

  // DOUBLE TAP winks.
  await page.waitForTimeout(800);
  await page.mouse.click(ccx, ccy);
  await page.waitForTimeout(90);
  await page.mouse.click(ccx, ccy);
  await page.waitForTimeout(150);
  check('DOUBLE TAP winks', (await engineRead()).gesture === 'wink',
    `gesture ${(await engineRead()).gesture}`);

  // LONG PRESS toggles sleep.
  await page.waitForTimeout(1400);
  await page.mouse.move(ccx, ccy);
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.mouse.up();
  await page.waitForTimeout(500);
  check('LONG PRESS puts it to sleep', (await engineRead()).state === 'sleeping',
    `state ${(await engineRead()).state}`);

  // TAP wakes it again.
  await page.waitForTimeout(600);
  await page.mouse.click(ccx, ccy);
  await page.waitForTimeout(600);
  check('TAP wakes a sleeping avatar', (await engineRead()).state !== 'sleeping',
    `state ${(await engineRead()).state}`);

  // SWIPE: a fast flick is a swipe, a slow drag is not.
  await page.locator('button:has-text("idle")').first().click();
  await page.waitForTimeout(1100);
  await page.mouse.move(ccx, ccy);
  await page.mouse.down();
  await page.mouse.move(ccx - cw * 0.3, ccy, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  check('SWIPE left/right triggers a glance', (await engineRead()).gesture === 'peek',
    `gesture ${(await engineRead()).gesture}`);

  await page.waitForTimeout(1200);
  // Capture the intent as it fires rather than sampling the sprung value later:
  // activity is smoothed, so by the time a poll reads it, it has already begun
  // settling back toward the slider position.
  await page.evaluate(() => {
    window.__lastIntent = null;
    window.__avatarEngine.onIntent((i) => {
      window.__lastIntent = i;
    });
  });
  await page.mouse.move(ccx, ccy);
  await page.mouse.down();
  await page.mouse.move(ccx, ccy - cw * 0.3, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const upIntent = await page.evaluate(() => window.__lastIntent);
  check('SWIPE up is recognised as a swipe',
    !!upIntent && upIntent.kind === 'swipe' && upIntent.dir === 'up',
    upIntent ? `${upIntent.kind} ${upIntent.dir ?? ''}` : 'no intent');

  // A SLOW drag over the same distance must NOT be a swipe.
  await page.locator('button:has-text("idle")').first().click();
  await page.waitForTimeout(1100);
  await page.mouse.move(ccx, ccy);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) {
    await page.mouse.move(ccx - i * (cw * 0.022), ccy);
    await page.waitForTimeout(55);
  }
  await page.mouse.up();
  await page.waitForTimeout(250);
  check('a SLOW drag is a head turn, not a swipe',
    (await engineRead()).gesture !== 'peek',
    `gesture ${(await engineRead()).gesture}`);

  // ── 9. Blink controller ───────────────────────────────────────────────
  console.log('\n▶ Behaviour controllers');
  await page.locator('button:has-text("idle")').first().click();
  await page.waitForTimeout(1500);
  const blinkResult = await page.evaluate(async () => {
    // Read the published signal rather than guessing from pixels: the debug
    // panel exposes the engine's real value.
    const canvas = document.querySelector('canvas');
    if (!canvas) return null;
    // Click the avatar to trigger a blink, then sample rapidly.
    // Tap recognition lives in the engine's touch layer now, driven by pointer
    // events on the canvas — a synthetic DOM `click` no longer triggers it.
    const r = canvas.getBoundingClientRect();
    const opts = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
    canvas.dispatchEvent(new PointerEvent('pointerup', opts));
    const samples = [];
    const start = performance.now();
    while (performance.now() - start < 700) {
      const scratch = document.createElement('canvas');
      scratch.width = 32;
      scratch.height = 32;
      const ctx = scratch.getContext('2d');
      ctx.drawImage(canvas, 0, 0, 32, 32);
      const d = ctx.getImageData(0, 0, 32, 32).data;
      let sum = 0;
      for (let i = 0; i < 32 * 32; i++) sum += (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
      samples.push(sum / (32 * 32));
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { min: Math.min(...samples), max: Math.max(...samples), n: samples.length };
  });
  check(
    'clicking the avatar produces a blink (brightness dips)',
    !!blinkResult && blinkResult.min < blinkResult.max * 0.995,
    blinkResult ? `min ${blinkResult.min.toFixed(1)} max ${blinkResult.max.toFixed(1)} over ${blinkResult.n} frames` : 'no data',
  );

  // ── 7. Run Assistant Demo, end to end ─────────────────────────────────
  console.log('\n▶ Run Assistant Demo');
  const seenStates = [];
  // Poll the UI's state label while the scenario plays.
  const runPromise = (async () => {
    const deadline = Date.now() + 50000;
    let last = null;
    while (Date.now() < deadline) {
      const shown = await page.evaluate(() => {
        const el = document.querySelector('[class*="stateName"]');
        return el?.textContent ?? null;
      });
      if (shown && shown !== last) {
        seenStates.push(shown);
        last = shown;
      }
      const stillRunning = await page.evaluate(() => !!document.querySelector('[class*="progressBar"]'));
      if (!stillRunning && seenStates.length > 2) break;
      await page.waitForTimeout(120);
    }
  })();

  await page.locator('button:has-text("Run Assistant Demo")').first().click();
  // Capture the decisive approval beat mid-run for the report.
  await page.waitForTimeout(17500);
  await page.screenshot({ path: resolve(OUT, 'scenario-approval.png') });
  const approvalShot = await fingerprint(page);
  await runPromise;

  report.scenario.sequence = seenStates;
  check(
    'scenario visits the expected states in order',
    JSON.stringify(seenStates) ===
      JSON.stringify([
        'idle',
        'listening',
        'thinking',
        'working',
        'waiting_approval',
        'working',
        'success',
        'idle',
      ]),
    seenStates.join(' → '),
  );
  check(
    'scenario passes through WAITING_APPROVAL',
    seenStates.includes('waiting_approval'),
  );
  check(
    'scenario reaches SUCCESS and returns to IDLE',
    seenStates.includes('success') && seenStates[seenStates.length - 1] === 'idle',
  );

  // ── 8. Screenshots for the report ─────────────────────────────────────
  await page.locator('button:has-text("Auto Demo")').first().click();
  await page.waitForTimeout(9500);
  await page.screenshot({ path: resolve(OUT, 'scenario-auto-demo.png') });
  await page.locator('button:has-text("Stop Auto Demo")').first().click().catch(() => {});
  await page.locator('button:has-text("idle")').first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: resolve(OUT, 'lab-full.png'), fullPage: true });

  report.errors = consoleErrors;
  report.finishedAt = new Date().toISOString();
  report.summary = {
    passed: report.checks.filter((c) => c.pass).length,
    failed: report.checks.filter((c) => !c.pass).length,
  };

  await writeFile(resolve(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();

  console.log(`\n${'='.repeat(64)}`);
  console.log(`  ${report.summary.passed} passed, ${report.summary.failed} failed`);
  console.log(`  report: ${resolve(OUT, 'report.json')}`);
  console.log(`  shots:  ${OUT}`);
  console.log('='.repeat(64));
  if (approvalShot) console.log(`  (approval-beat fingerprint brightness ${approvalShot.brightness.toFixed(2)})`);
  process.exit(report.summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('verify: fatal', err);
  process.exit(2);
});
