# Documentation

- [`ANALYSIS.md`](ANALYSIS.md) — full analysis of the three reference projects
  (KK, Grok Bot Orb, AURA), what was taken from each, and what was rejected and
  why.
- [`banner.png`](banner.png) / [`demo.gif`](demo.gif) — the README's hero images.
  Both are generated from the **real renderer** (`tools/banner.mjs`,
  `tools/demo-gif.mjs`), so they cannot drift from the product the way a
  hand-drawn hero would.
- [`MIGRATION.md`](MIGRATION.md) — the M5Stack StopWatch plan. Module-by-module
  port verdicts (≈80% of the engine ports directly), the renderer rewrite spec,
  dirty-rectangle strategy, audio/IMU/haptics wiring, and an evidence-level
  table stating exactly which claims have been verified and which have not.
