/**
 * direction.mjs — verify drag axes against real pointer input.
 *
 * Measures the EYE CENTROID of dark pixels for a sweep of drags. No left/right
 * splitting: past a certain yaw both eyes sit on the same side of the canvas
 * centre, so a fixed split mis-buckets them and returns NaN. The centroid is
 * robust for both axes — X for yaw, Y for pitch.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', // CI container fallback
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
await page.goto('http://127.0.0.1:5199/avatar-lab.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const probe = () =>
  page.evaluate(() => {
    const c = document.querySelector('canvas');
    const sc = document.createElement('canvas');
    sc.width = 466;
    sc.height = 466;
    const x = sc.getContext('2d');
    x.drawImage(c, 0, 0, 466, 466);
    const d = x.getImageData(0, 0, 466, 466).data;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < 466; y++) {
      for (let xx = 0; xx < 466; xx++) {
        const i = (y * 466 + xx) * 4;
        const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
        // Eyes are near-black; stay well inside the sphere so its own shaded
        // limb is never counted.
        if (lum < 40 && Math.hypot(xx - 233, y - 233) < 150) {
          sx += xx;
          sy += y;
          n++;
        }
      }
    }
    const e = window.__avatarEngine;
    return n > 10
      ? {
          cx: +(sx / n).toFixed(1),
          cy: +(sy / n).toFixed(1),
          yaw: +((e.pose.headYaw * 180) / Math.PI).toFixed(1),
          pitch: +((e.pose.headPitch * 180) / Math.PI).toFixed(1),
        }
      : { cx: NaN, cy: NaN, yaw: +((e.pose.headYaw * 180) / Math.PI).toFixed(1), pitch: 0 };
  });

const box = await page.locator('canvas').first().boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
const W = box.width;

/** Drag from the centre and hold, then measure. */
async function drag(dx, dy) {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cx + (dx * i) / steps, cy + (dy * i) / steps);
    await page.waitForTimeout(28);
  }
  await page.waitForTimeout(320);
  const m = await probe();
  await page.mouse.up();
  await page.waitForTimeout(1100);
  return m;
}

const rest = await probe();
console.log(`rest: eye centroid (${rest.cx}, ${rest.cy})   canvas centre (233, 233)\n`);

const right = await drag(W * 0.3, 0);
const left = await drag(-W * 0.3, 0);
console.log('YAW');
console.log(`  finger RIGHT -> eye centroid x ${right.cx}  (yaw ${right.yaw}°)`);
console.log(`  finger LEFT  -> eye centroid x ${left.cx}  (yaw ${left.yaw}°)`);
console.log(`  ${right.cx > left.cx ? 'CORRECT: the face follows the finger' : 'REVERSED'}\n`);

const down = await drag(0, W * 0.3);
const up = await drag(0, -W * 0.3);
console.log('PITCH');
console.log(`  finger DOWN -> eye centroid y ${down.cy}  (pitch ${down.pitch}°)`);
console.log(`  finger UP   -> eye centroid y ${up.cy}  (pitch ${up.pitch}°)`);
console.log(`  ${down.cy > up.cy ? 'CORRECT: the face follows the finger' : 'REVERSED'}`);

await browser.close();
