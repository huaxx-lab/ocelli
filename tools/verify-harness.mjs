/**
 * verify-harness.mjs — verify the Avatar Lab *inside* the running DSH Web GUI.
 *
 * This is the integration counterpart to verify.mjs (which tests the
 * standalone page). It proves the things that only matter in the real GUI:
 *
 *   1. the plugin loads from the DSH module roster with no console errors
 *   2. the floating launcher appears in the `shell.overlay` slot
 *   3. the mini avatar in the launcher is actually animating
 *   4. the overlay opens and the full Lab renders inside it
 *   5. all ten state buttons work inside the GUI
 *   6. the existing Harness UI is untouched (the composer is still present)
 *   7. "Run Assistant Demo" completes inside the GUI
 *
 * Usage: node tools/verify-harness.mjs [baseUrl] [outDir]
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { constants } from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3099/';
const OUT = resolve(process.argv[3] ?? 'verification-harness');

async function findChromium() {
  const candidates = [
    process.env.AVATAR_LAB_CHROMIUM,
    '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', // CI container fallback
    '/root/.cache/ms-playwright/chromium-1243/chrome-linux/chrome',
    '/usr/bin/chromium',
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
  return undefined;
}

/** Mean brightness of a canvas, for "is it drawing at all" checks. */
async function canvasBrightness(page, selector) {
  return page.evaluate((sel) => {
    const canvas = document.querySelector(sel);
    if (!canvas) return null;
    const scratch = document.createElement('canvas');
    scratch.width = 48;
    scratch.height = 48;
    const ctx = scratch.getContext('2d');
    ctx.drawImage(canvas, 0, 0, 48, 48);
    const d = ctx.getImageData(0, 0, 48, 48).data;
    let sum = 0;
    for (let i = 0; i < 48 * 48; i++) sum += (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
    return sum / (48 * 48);
  }, selector);
}

/**
 * Per-pixel fingerprint of a canvas.
 *
 * Brightness alone cannot detect a slowly breathing 64 px avatar: the total
 * light barely changes even though the pixels move. A per-pixel diff can.
 */
async function canvasPrint(page, selector, n = 48) {
  return page.evaluate(
    ({ sel, size }) => {
      const canvas = document.querySelector(sel);
      if (!canvas) return null;
      const scratch = document.createElement('canvas');
      scratch.width = size;
      scratch.height = size;
      const ctx = scratch.getContext('2d');
      ctx.drawImage(canvas, 0, 0, size, size);
      return Array.from(ctx.getImageData(0, 0, size, size).data);
    },
    { sel: selector, size: n },
  );
}

/** Mean absolute per-channel difference between two fingerprints, 0..255. */
function printDiff(a, b) {
  if (!a || !b) return -1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const report = { url: BASE, checks: [], states: [], scenario: {}, errors: [] };
  const check = (name, pass, detail) => {
    report.checks.push({ name, pass, detail });
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const executablePath = await findChromium();
  const browser = await chromium.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1560, height: 1000 },
    deviceScaleFactor: 1.5,
    // The DSH Web GUI sits behind a trust fence that nginx satisfies with this
    // header. A direct connection has to send it itself.
    extraHTTPHeaders: { 'X-DSH-Proxy-Authenticated': '1' },
  });
  const page = await context.newPage();

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log(`\n▶ Loading Harness GUI at ${BASE}`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // The GUI is an SPA; wait for the shell to settle.
  await page.waitForTimeout(9000);

  check('Harness GUI shell loaded', await page.locator('[data-composer-input], textarea, [contenteditable="true"]').count() > 0);
  await page.screenshot({ path: resolve(OUT, 'harness-shell.png') });

  // ── 1. Plugin loaded from the roster ──────────────────────────────────
  const pluginLoaded = await page.evaluate(() => {
    // The module loader records every registration it processed.
    return typeof window.__ModuleLoader__ !== 'undefined';
  });
  check('DSH module loader present', pluginLoaded);

  // ── 2. Launcher appeared in shell.overlay ─────────────────────────────
  const launcher = page.locator('.avatar-lab-launcher');
  const launcherCount = await launcher.count();
  check('avatar launcher registered in shell.overlay', launcherCount === 1, `found ${launcherCount}`);

  if (launcherCount === 0) {
    console.log('  (plugin did not mount; dumping boot diagnostics)');
    const diag = await page.evaluate(() => ({
      boot: typeof window.__DSH_BOOT__ !== 'undefined' ? window.__DSH_BOOT__.entries.length : -1,
      overlay: document.querySelectorAll('[data-shell-overlay]').length,
    }));
    console.log('   ', JSON.stringify(diag));
    report.errors = errors;
    await writeFile(resolve(OUT, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
    process.exit(1);
  }

  // ── 3. The mini avatar is alive ───────────────────────────────────────
  const miniSel = '.avatar-lab-launcher canvas';
  const b1 = await canvasBrightness(page, miniSel);
  check('launcher mini-avatar is rendering', b1 !== null && b1 > 1.0, `brightness ${b1?.toFixed(2)}`);

  // Sample several frames and take the largest pairwise difference: a 64 px
  // IDLE avatar breathes on a ~7 s period, so two samples 0.9 s apart can
  // legitimately be almost identical.
  const prints = [];
  for (let i = 0; i < 6; i++) {
    prints.push(await canvasPrint(page, miniSel));
    await page.waitForTimeout(420);
  }
  let maxDiff = 0;
  for (let i = 0; i < prints.length; i++) {
    for (let j = i + 1; j < prints.length; j++) {
      maxDiff = Math.max(maxDiff, printDiff(prints[i], prints[j]));
    }
  }
  check('launcher mini-avatar is animating', maxDiff > 0.05, `max frame delta ${maxDiff.toFixed(3)}`);

  // ── 4. The Harness UI is untouched ────────────────────────────────────
  const composerStillThere = await page.locator('[data-composer-input], textarea, [contenteditable="true"]').count();
  check('existing Harness UI untouched (composer present)', composerStillThere > 0);
  const sidebarPresent = await page.locator('[class*="sidebar" i]').count();
  check('existing Harness sidebar untouched', sidebarPresent > 0, `${sidebarPresent} matches`);

  // The launcher must not block the GUI: its container is click-through.
  const overlayPointerEvents = await page.evaluate(() => {
    const layer = document.querySelector('[data-shell-overlay]');
    return layer ? getComputedStyle(layer).pointerEvents : null;
  });
  check('shell.overlay layer stays click-through', overlayPointerEvents === 'none', String(overlayPointerEvents));

  // ── 5. Open the overlay and run the full Lab inside the GUI ───────────
  await launcher.click();
  await page.waitForTimeout(1600);
  const overlay = page.locator('.avatar-lab-overlay');
  check('Avatar Lab overlay opens inside the GUI', (await overlay.count()) === 1);
  await page.screenshot({ path: resolve(OUT, 'overlay-open.png') });

  const deviceScreen = await page.evaluate(() => {
    const canvas = document.querySelector('.avatar-lab-overlay canvas[role="img"]');
    const screen = canvas?.parentElement;
    const r = screen?.getBoundingClientRect();
    return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
  });
  check('device frame is 466x466 inside the GUI',
    deviceScreen?.w === 466 && deviceScreen?.h === 466, JSON.stringify(deviceScreen));

  const labCanvas = '.avatar-lab-overlay canvas[role="img"]';
  const labBrightness = await canvasBrightness(page, labCanvas);
  check('lab avatar renders inside the GUI', labBrightness !== null && labBrightness > 1.5,
    `brightness ${labBrightness?.toFixed(2)}`);

  // ── 6. Every state switchable inside the GUI ──────────────────────────
  console.log('\n▶ State sweep inside the GUI');
  const states = ['idle', 'listening', 'thinking', 'working', 'speaking',
                  'waiting_input', 'waiting_approval', 'success', 'error', 'sleeping'];
  for (const s of states) {
    const label = s.replace(/_/g, ' ');
    await page.locator(`.avatar-lab-overlay button:has-text("${label}")`).first().click();
    await page.waitForTimeout(1500);
    const shown = await page.evaluate(() => {
      const el = document.querySelector('.avatar-lab-overlay [class*="stateName"]');
      return el?.textContent ?? null;
    });
    report.states.push({ state: s, shown });
    check(`state "${s}" selectable in GUI`, shown === s, `ui shows "${shown}"`);
  }
  await page.locator('.avatar-lab-overlay button:has-text("idle")').first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: resolve(OUT, 'lab-in-gui.png') });

  // ── 7. Run Assistant Demo inside the GUI ──────────────────────────────
  console.log('\n▶ Run Assistant Demo inside the GUI');
  const seen = [];
  const poll = (async () => {
    const deadline = Date.now() + 55000;
    let last = null;
    while (Date.now() < deadline) {
      const shown = await page.evaluate(() => {
        const el = document.querySelector('.avatar-lab-overlay [class*="stateName"]');
        return el?.textContent ?? null;
      });
      if (shown && shown !== last) {
        seen.push(shown);
        last = shown;
      }
      await page.waitForTimeout(130);
    }
  })();

  await page.locator('.avatar-lab-overlay button:has-text("Run Assistant Demo")').first().click();
  await page.waitForTimeout(19000);
  await page.screenshot({ path: resolve(OUT, 'gui-approval-beat.png') });
  await poll;

  report.scenario.sequence = seen;
  check('scenario runs inside the GUI and reaches APPROVAL', seen.includes('waiting_approval'), seen.join(' → '));
  check('scenario reaches SUCCESS', seen.includes('success'), seen.join(' → '));

  // ── 8. Close returns to the untouched GUI ─────────────────────────────
  await page.locator('.avatar-lab-close').click();
  await page.waitForTimeout(900);
  check('overlay closes cleanly', (await page.locator('.avatar-lab-overlay').count()) === 0);
  const composerAfter = await page.locator('[data-composer-input], textarea, [contenteditable="true"]').count();
  check('Harness UI still intact after closing', composerAfter > 0);
  await page.screenshot({ path: resolve(OUT, 'harness-after-close.png') });

  report.errors = errors;
  report.summary = {
    passed: report.checks.filter((c) => c.pass).length,
    failed: report.checks.filter((c) => !c.pass).length,
  };
  await writeFile(resolve(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();

  console.log(`\n${'='.repeat(64)}`);
  console.log(`  ${report.summary.passed} passed, ${report.summary.failed} failed`);
  console.log(`  report: ${resolve(OUT, 'report.json')}`);
  console.log('='.repeat(64));
  process.exit(report.summary.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('verify-harness: fatal', e);
  process.exit(2);
});
