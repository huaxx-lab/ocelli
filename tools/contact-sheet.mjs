/**
 * contact-sheet.mjs — assemble the per-state screenshots into one image.
 *
 * Reads the `state-*.png` files written by tools/verify.mjs and lays them out
 * as a labelled grid, so the whole animation language can be judged in one
 * look. Output: verification/states-contact-sheet.png
 */

import { chromium } from 'playwright';
import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATES = ['idle', 'listening', 'thinking', 'working', 'speaking',
                'waiting_input', 'waiting_approval', 'success', 'error', 'sleeping'];

async function findChromium() {
  for (const p of [
    process.env.AVATAR_LAB_CHROMIUM,
    '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', // CI container fallback
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].filter(Boolean)) {
    try { await access(p, constants.X_OK); return p; } catch { /* keep probing */ }
  }
  return undefined;
}

/** Crop a screenshot to the round device panel. */
async function cropToDevice(page, base64) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    // The harness captures the full viewport; the device panel is the large
    // circular region on the left. Detect it by scanning for the first
    // strongly non-background column/row band.
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
    let minX = width, minY = height, maxX = 0, maxY = 0;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const i = (y * width + x) * 4;
        const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (lum > 14) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const size = Math.min(maxX - minX, maxY - minY);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const out = document.createElement('canvas');
    out.width = 466; out.height = 466;
    out.getContext('2d').drawImage(
      img, cx - size / 2, cy - size / 2, size, size, 0, 0, 466, 466,
    );
    return out.toDataURL('image/png').split(',')[1];
  }, base64);
}

async function main() {
  const browser = await chromium.launch({ executablePath: await findChromium(), args: ['--no-sandbox'] });
  const shots = [];
  for (const s of STATES) {
    const path = resolve(ROOT, `verification/state-${s}.png`);
    try {
      shots.push({ s, b64: (await readFile(path)).toString('base64') });
    } catch {
      console.warn(`  (missing verification/state-${s}.png — run tools/verify.mjs first)`);
    }
  }
  if (shots.length === 0) {
    console.error('contact-sheet: no state screenshots found');
    process.exit(1);
  }

  const page = await browser.newPage({ viewport: { width: 1600, height: 800 }, deviceScaleFactor: 1.35 });
  const cropped = [];
  for (const { s, b64 } of shots) cropped.push({ s, b64: await cropToDevice(page, b64) });

  const cells = cropped
    .map(
      ({ s, b64 }) =>
        `<div style="text-align:center">` +
        `<img src="data:image/png;base64,${b64}" style="width:100%;border-radius:50%;display:block"/>` +
        `<div style="color:#6ea8fe;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;` +
        `font-size:11px;letter-spacing:1.5px;text-transform:uppercase;margin-top:10px">` +
        `${s.replace(/_/g, ' ')}</div></div>`,
    )
    .join('');

  await page.setContent(
    `<html><body style="margin:0;background:#08090c;padding:26px;font-family:-apple-system,` +
      `BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif">` +
      `<div style="color:#e6e9ef;font-size:19px;font-weight:600;margin-bottom:5px">` +
      `Personal Assistant Avatar — all ten states</div>` +
      `<div style="color:#5b6273;font-size:12px;margin-bottom:22px">` +
      `466 × 466 round AMOLED design space · procedural Canvas 2D · M5Stack StopWatch migration target</div>` +
      `<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:16px">${cells}</div>` +
      `</body></html>`,
    { waitUntil: 'networkidle' },
  );
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(ROOT, 'verification/states-contact-sheet.png'), fullPage: true });
  await browser.close();
  console.log(`contact sheet: verification/states-contact-sheet.png (${cropped.length} states)`);
}

main().catch((e) => {
  console.error('contact-sheet: fatal', e);
  process.exit(2);
});
