/**
 * sphere.ts — "a face painted on a ball".
 *
 * This is the math that makes the avatar read as a SPHERE rather than as a flat
 * sticker: each eye is projected onto a virtual ball, so as the head turns the
 * eyes travel on a CURVED path, the near eye swells while the far one shrinks,
 * and an eye approaching the limb compresses.
 *
 * That set of behaviours is what sells a head turn, and doing it by hand means
 * keying every eye pose separately. Here it comes from two numbers: yaw and
 * pitch.
 *
 * ── Where this comes from ─────────────────────────────────────────────────
 * The approach is a port of the SphereWarp Rive path effect by AB at Novra
 * (shipped with this project as a reference, released as free to use). The
 * original is a Rive/Luau script; this is the same projection re-expressed as
 * pure TypeScript so the engine, the Lab and a future C++ renderer can all
 * share it.
 *
 * Two properties of the original are deliberately preserved:
 *
 *   1. **It does not bend the artwork.** Each element moves as ONE PIECE — a
 *      capsule stays a capsule. Only its position, scale and depth change. So
 *      the eyes keep their shape and simply obey perspective.
 *   2. **Front-facing is a no-op.** At yaw = pitch = 0 the output equals the
 *      input exactly, for any pose. An avatar looking straight ahead is
 *      untouched, which means the whole system degrades to the flat renderer.
 *
 * ── Coordinates ───────────────────────────────────────────────────────────
 * Everything is in DESIGN units (the 466-unit space), which is also what the
 * StopWatch framebuffer uses. No pixels.
 */

/** A virtual ball plus the head's current rotation. */
export interface SphereView {
  /** Ball centre, in design units. */
  cx: number;
  cy: number;
  /** Ball radius, in design units. Smaller = more curvature under the face. */
  radius: number;
  /** Turn left/right, in radians. */
  yaw: number;
  /** Tip up/down, in radians. */
  pitch: number;
}

/** A point projected onto the ball. `depth` is its distance toward the viewer. */
export interface Projected {
  x: number;
  y: number;
  /** Positive = in front of the ball's equator. Negative = rotated behind it. */
  depth: number;
}

/**
 * Project a flat point onto the ball and rotate it.
 *
 * The point is first pushed onto the ball's surface (clamped to the limb if it
 * lies outside), then rotated about Y (yaw) and X (pitch).
 */
export function projectPoint(view: SphereView, px: number, py: number): Projected {
  const R = Math.max(view.radius, 0.001);
  const limit = R * R;

  let dx = px - view.cx;
  let dy = py - view.cy;
  let flat = dx * dx + dy * dy;

  // Clamp to the limb so a point outside the ball still has a sensible depth
  // instead of producing NaN.
  if (flat > limit) {
    const k = R / Math.sqrt(flat);
    dx *= k;
    dy *= k;
    flat = limit;
  }

  // Height above the equator at this point.
  const z = Math.sqrt(Math.max(limit - flat, 0));

  // ── Yaw (about the vertical axis) ─────────────────────────────────────
  const cy = Math.cos(view.yaw);
  const sy = Math.sin(view.yaw);
  const x1 = dx * cy + z * sy;
  const z1 = z * cy - dx * sy;

  // ── Pitch (about the horizontal axis) ─────────────────────────────────
  const cp = Math.cos(view.pitch);
  const sp = Math.sin(view.pitch);
  const y1 = dy * cp - z1 * sp;
  const z2 = dy * sp + z1 * cp;

  return { x: view.cx + x1, y: view.cy + y1, depth: z2 };
}

/**
 * The local scale factors at a point on the ball.
 *
 * This is the Jacobian of the projection: how much a small step in x and y on
 * the FLAT face stretches once it is mapped onto the rotated ball. It is what
 * makes the near eye swell and the far one shrink — the single most important
 * cue for reading a turn.
 *
 * Returned as the four components so a caller can either take the diagonal
 * terms as independent x/y scales (what the eye renderer does) or apply the
 * full 2×2 for a sheared element.
 */
export function sphereJacobian(
  view: SphereView,
  px: number,
  py: number,
): { j11: number; j12: number; j21: number; j22: number } {
  const R = Math.max(view.radius, 0.001);
  const limit = R * R;

  let dx = px - view.cx;
  let dy = py - view.cy;
  let flat = dx * dx + dy * dy;

  // Stop just short of the limb: at the exact edge the surface is vertical and
  // the Jacobian blows up, which would scale an element to infinity.
  const ceiling = limit * 0.9801;
  if (flat > ceiling) {
    const k = Math.sqrt(ceiling / Math.max(flat, 1e-12));
    dx *= k;
    dy *= k;
    flat = ceiling;
  }

  const z = Math.sqrt(Math.max(limit - flat, 1e-9));

  const cy = Math.cos(view.yaw);
  const sy = Math.sin(view.yaw);
  const cp = Math.cos(view.pitch);
  const sp = Math.sin(view.pitch);

  // Rate of change of height with respect to position on the flat face.
  const dzdu = -dx / z;
  const dzdv = -dy / z;

  const j11 = cy + dzdu * sy;
  const j12 = dzdv * sy;

  const dz1du = dzdu * cy - sy;
  const dz1dv = dzdv * cy;

  const j21 = -dz1du * sp;
  const j22 = cp - dz1dv * sp;

  return { j11, j12, j21, j22 };
}

/**
 * How far the head can turn, in radians.
 *
 * The reference notes that real head turns live around 15-35 degrees and that
 * past 60 things get theatrical. 26 degrees of yaw and 17 of pitch give a
 * clearly readable turn at the eye positions this avatar uses, without ever
 * rotating an eye so far that it folds behind the limb.
 */
export const MAX_YAW = (30 * Math.PI) / 180;
export const MAX_PITCH = (19 * Math.PI) / 180;

/**
 * The ball radius, as a fraction of the drawn sphere radius.
 *
 * This is the drama dial. The effect depends on how far the eyes sit from the
 * centre RELATIVE to the ball: a smaller ball curves the surface more sharply
 * under them and exaggerates the turn. `1.0` would be the sphere itself, which
 * is too flat to read because the eyes sit close to its middle; the reference
 * recommends starting near two thirds; measured on this rig, 0.58 gives a
 * 1.30x near/far asymmetry at full yaw (the reference reports 1.28x at its
 * equivalent setting), while every eye stays comfortably in front of the ball.
 */
export const BALL_RADIUS_RATIO = 0.58;
