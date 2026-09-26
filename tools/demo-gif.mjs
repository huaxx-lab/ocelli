/**
 * demo-gif.mjs — record the avatar into an animated GIF for the README.
 *
 * Why a GIF rather than the contact sheets: the whole deliverable is a claim
 * about MOTION ("it reads as alive"), and a still cannot support that claim.
 * A GIF in the README lets a visitor judge the animation language without
 * cloning, installing or running anything.
 *
 * Frames are captured straight from the canvas via `toDataURL`, so there is no
 * screen-recording step and no window chrome — every frame is exactly the
 * 466-unit design surface.
 *
 * Usage: node tools/demo-gif.mjs [baseUrl] [outDir]
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BASE = process.argv[2] ?? 'http://127.0.0.1:5199/avatar-lab.html';
const OUT = resolve(process.argv[3] ?? 'docs');
const FRAMES = '/tmp/ocelli-frames';

/** 24 fps reads as smooth at this scale without an enormous file. */
const FPS = 20;

async function main() {
  await mkdir(OUT, { recursive: true });
  await rm(FRAMES, { recursive: true, force: true });
  await mkdir(FRAMES, { recursive: true });

  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // Render into a dedicated offscreen canvas at final size, so the captures are
  // independent of the page layout and of the device pixel ratio.
  await page.evaluate((px) => {
    const src = document.querySelector('canvas');
    const c = document.createElement('canvas');
    c.width = px;
    c.height = px;
    c.id = 'gif-canvas';
    c.style.cssText = `position:fixed;left:0;top:0;width:${px}px;height:${px}px;z-index:99999;background:#000`;
    document.body.appendChild(c);
    const renderer = new window.__avatarRenderer(c, 'idle', { size: 466 });
    renderer.resize(px);
    window.__gif = { canvas: c, renderer, engine: window.__avatarEngine };
  }, 280);

  let frame = 0;
  const seen = [];

  /** Advance one frame and write a PNG. */
  const capture = async (label) => {
    const png = await page.evaluate(() => {
      const { renderer, engine, canvas } = window.__gif;
      // Drive the real engine, then draw with the real renderer: the GIF shows
      // the actual pipeline, not a re-enactment.
      engine.step(1 / 24);
      renderer.render(engine.pose, engine.signals, engine.state, 1 / 24);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const name = `${FRAMES}/f${String(frame).padStart(4, '0')}.png`;
    await writeFile(name, Buffer.from(png, 'base64'));
    frame += 1;
    if (label) seen.push(label);
  };

  /** Hold the current state for `seconds`. */
  const hold = async (seconds) => {
    const n = Math.round(seconds * FPS);
    for (let i = 0; i < n; i++) await capture();
  };

  const setState = (s) => page.evaluate((st) => window.__gif.engine.setState(st, {}, true), s);
  const gesture = (g) => page.evaluate((k) => window.__gif.engine.gesture(k), g);
  const setInput = (patch) => page.evaluate((p) => window.__gif.engine.setInput(p), patch);

  // ── The story: a full assistant turn, which is the thing worth showing ──
  // Driving the engine directly rather than through the scenario runner so the
  // pacing can be tuned for a short loop.
  await setState('idle');
  await hold(1.4);

  // Listening, with a voice envelope.
  await setState('listening');
  await setInput({ attention: 0.9, activity: 0.5 });
  for (let i = 0; i < Math.round(1.8 * FPS); i++) {
    await setInput({ audioLevel: 0.3 + 0.4 * Math.abs(Math.sin(i / 6)) });
    await capture();
  }

  await setState('thinking');
  await setInput({ attention: 0.6, activity: 0.7, audioLevel: 0 });
  await hold(1.5);

  await setState('working');
  await page.evaluate(() => window.__gif.engine.setState('working', { label: 'Reading Gmail…' }, true));
  await setInput({ attention: 0.5, progress: 0.6, progressKnown: true });
  await hold(1.3);

  await setState('speaking');
  await setInput({ attention: 0.7, activity: 0.6 });
  for (let i = 0; i < Math.round(2.0 * FPS); i++) {
    await setInput({ audioLevel: 0.45 + 0.45 * Math.abs(Math.sin(i / 4.5)) });
    await capture();
  }

  // The decisive beat: approval.
  await setState('waiting_approval');
  await setInput({ attention: 1, urgency: 0.85, audioLevel: 0 });
  await hold(2.2);

  await setState('success');
  await gesture('wink');
  await hold(1.4);

  await setState('idle');
  await hold(1.0);

  await browser.close();

  // ── Encode ────────────────────────────────────────────────────────────
  // A single palette built from the whole clip: the avatar is greyscale on
  // black, so one adaptive palette is accurate and keeps the file small.
  const palette = `${FRAMES}/palette.png`;
  await run('ffmpeg', ['-y', '-i', `${FRAMES}/f%04d.png`, '-vf', `fps=${FPS},palettegen=max_colors=64:stats_mode=diff`, palette]);
  await run('ffmpeg', [
    '-y', '-framerate', String(FPS), '-i', `${FRAMES}/f%04d.png`,
    '-i', palette,
    '-lavfi', `fps=${FPS}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
    '-loop', '0',
    resolve(OUT, 'demo.gif'),
  ]);

  const { stdout } = await run('sh', ['-c', `du -h ${resolve(OUT, 'demo.gif')} | cut -f1`]);
  console.log(`demo.gif written — ${frame} frames at ${FPS} fps, ${stdout.trim()}`);
}

main().catch((e) => {
  console.error('demo-gif: fatal', e);
  process.exit(1);
});
