/**
 * palette.ts — the avatar's material system.
 *
 * Deliberately NOT AURA's palette (that project is cyan/green/purple
 * cyberpunk, which the brief explicitly rejects) and NOT Grok's (that is
 * Grok's identity, which we must not copy).
 *
 * Our identity: a warm-cool "premium minimal" gradient. Deep indigo core,
 * cool cyan-white rim, with a single warm accent reserved for attention
 * states. Every state shifts *hue temperature*, never saturation — a cheap
 * trick that reads as mood rather than as an alarm.
 */

export interface AvatarPalette {
  /** Background behind the avatar (pure-ish near-black, OLED friendly). */
  background: string;
  /** The orb's dark centre. */
  coreInner: string;
  /** Mid-body gradient stop. */
  coreOuter: string;
  /** Bright rim / inner light. */
  rim: string;
  /** Halo / bloom tint. */
  halo: string;
  /** Trail colour. */
  trail: string;
  /** Eye colour. */
  eye: string;
  /**
   * Optional highlight dot on each eye.
   *
   * The reference design has NONE — its eyes are flat black marks on a grey
   * ball — so every palette here leaves it unset. It exists as a channel
   * because a highlight is the right answer for a glossy material, and
   * removing the capability would mean re-adding it later.
   */
  eyeHighlight?: string;
  /** Particle colour. */
  particle: string;
  /** Accent used for attention states. */
  accent: string;
}

/**
 * Per-state palettes. The differences are subtle on purpose: the avatar
 * should feel like one creature in different moods, not one creature per
 * state.
 *
 * Hue anchors (HSL degrees), for reference when retuning:
 *   idle              215  (calm indigo)
 *   listening         178  (attentive teal)
 *   thinking          252  (deep violet)
 *   working           198  (clear blue)
 *   speaking          196  (warm-ish blue)
 *   waiting_input     188  (upright cyan)
 *   waiting_approval   42  (warm amber accent)
 *   success           158  (soft mint)
 *   error               8  (muted clay, NOT red)
 *   sleeping          228  (dim slate)
 */
export const PALETTES: Record<string, AvatarPalette> = {
  // ── The reference design ─────────────────────────────────────────────────
  // A MATTE GREY BALL with flat BLACK capsule eyes. That is the whole face —
  // no glow, no colour cast, no highlight dot. Its restraint is the point: a
  // neutral grey body reads as an object rather than as an illuminated device,
  // and black eyes on grey have the highest possible figure-ground contrast at
  // any size, which is why the reference uses them.
  //
  // The per-state palettes below therefore vary the grey's TEMPERATURE and
  // LIGHTNESS rather than its hue: a warm-grey ball for approval, a cool one
  // for listening, a darker one asleep. Mood is carried by the eyes' shape and
  // the head's motion; colour only tints, so no state ever looks like an alarm.
  idle: {
    background: '#000000',
    coreInner: '#9a9a9a',
    coreOuter: '#4a4a4a',
    rim: '#c8c8c8',
    halo: '#6a6a6a',
    trail: '#8a8a8a',
    eye: '#111111',
    particle: '#9a9a9a',
    accent: '#8a8a8a',
  },
  listening: {
    background: '#000000',
    coreInner: '#8fa6a2',
    coreOuter: '#42504e',
    rim: '#c2d4d0',
    halo: '#5f706c',
    trail: '#8fa6a2',
    eye: '#0e1413',
    particle: '#8fa6a2',
    accent: '#7f9691',
  },
  thinking: {
    background: '#000000',
    coreInner: '#9a92ad',
    coreOuter: '#494455',
    rim: '#cbc4dc',
    halo: '#6b6478',
    trail: '#9a92ad',
    eye: '#120f18',
    particle: '#9a92ad',
    accent: '#8b83a0',
  },
  working: {
    background: '#000000',
    coreInner: '#8e9aab',
    coreOuter: '#434b56',
    rim: '#c0cbd8',
    halo: '#616b78',
    trail: '#8e9aab',
    eye: '#0f1319',
    particle: '#8e9aab',
    accent: '#7f8b9c',
  },
  speaking: {
    background: '#000000',
    coreInner: '#93a0a6',
    coreOuter: '#464f53',
    rim: '#c4d0d4',
    halo: '#646f73',
    trail: '#93a0a6',
    eye: '#101517',
    particle: '#93a0a6',
    accent: '#849196',
  },
  waiting_input: {
    background: '#000000',
    coreInner: '#8ca3a8',
    coreOuter: '#415054',
    rim: '#bed2d6',
    halo: '#5d6f73',
    trail: '#8ca3a8',
    eye: '#0d1416',
    particle: '#8ca3a8',
    accent: '#7d9398',
  },
  waiting_approval: {
    background: '#000000',
    coreInner: '#b0a184',
    coreOuter: '#584f3f',
    rim: '#dbcda f'.replace(' ', ''),
    halo: '#7a6f5a',
    trail: '#b0a184',
    eye: '#171208',
    particle: '#b0a184',
    accent: '#a2937a',
  },
  success: {
    background: '#000000',
    coreInner: '#96ab97',
    coreOuter: '#465247',
    rim: '#c6dbc7',
    halo: '#667568',
    trail: '#96ab97',
    eye: '#101610',
    particle: '#96ab97',
    accent: '#879b88',
  },
  error: {
    background: '#000000',
    coreInner: '#ab9490',
    coreOuter: '#544643',
    rim: '#d6c2be',
    halo: '#756460',
    trail: '#ab9490',
    eye: '#160f0e',
    particle: '#ab9490',
    accent: '#9c8581',
  },
  sleeping: {
    background: '#000000',
    coreInner: '#6b6f79',
    coreOuter: '#31343b',
    rim: '#9aa0ac',
    halo: '#474b54',
    trail: '#6b6f79',
    eye: '#0a0b0d',
    particle: '#6b6f79',
    accent: '#5c606a',
  },
};

/** Parse `#rrggbb` into 0..255 components. Kept allocation-free. */
export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** `rgba()` string with an alpha applied to a hex colour. */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha < 0 ? 0 : alpha > 1 ? 1 : alpha})`;
}

/**
 * Blend two palettes. Used to cross-fade colours during a state transition
 * so the avatar never changes hue in a single frame.
 */
export function mixPalette(a: AvatarPalette, b: AvatarPalette, t: number): AvatarPalette {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const out = {} as AvatarPalette;
  for (const key of Object.keys(a) as (keyof AvatarPalette)[]) {
    const av = a[key];
    const bv = b[key];
    // Optional keys (the highlight) may be absent on either side; fall back to
    // whichever side has a value, and skip the mix entirely if neither does.
    if (typeof av !== 'string' || typeof bv !== 'string') {
      if (typeof av === 'string') out[key] = av;
      else if (typeof bv === 'string') out[key] = bv;
      continue;
    }
    out[key] = mixHex(av, bv, t);
  }
  return out;
}

function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}

/** Palette for a state name, falling back to idle. */
export function paletteFor(state: string): AvatarPalette {
  return PALETTES[state] ?? PALETTES.idle!;
}
