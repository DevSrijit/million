// Touch panning for the canvas grid. The canvas has no native scrolling, so a finger drag, its
// momentum after release, and the tap-versus-drag decision are done here, in pure functions.
//
// - A touch that moves less than SLOP px is a tap.
// - A drag that starts close to one axis stays on that axis, like iOS. A diagonal drag pans freely.
// - On release, the grid keeps moving at the finger's speed and slows down like iOS
//   (UIScrollView's normal deceleration: the speed falls by 0.2% each ms).

export const SLOP = 8; // px a finger can wobble and still tap
const AXIS_RATIO = 2; // a drag this many times longer on one axis locks to it
const DECAY = 0.998; // speed kept per ms of momentum
const MIN_SPEED = 0.02; // px/ms: below this, momentum stops
const STALE_MS = 80; // a finger that rested this long before release throws nothing

export type Pan = {
  x0: number; y0: number; // where the finger came down
  sx0: number; sy0: number; // the scroll position at that moment
  lx: number; ly: number; lt: number; // the last sample
  vx: number; vy: number; // px/ms, in scroll direction (opposite to the finger)
  mode: "pending" | "free" | "x" | "y";
};

export function panStart(x: number, y: number, t: number, sx: number, sy: number): Pan {
  return { x0: x, y0: y, sx0: sx, sy0: sy, lx: x, ly: y, lt: t, vx: 0, vy: 0, mode: "pending" };
}

/** A finger move. Returns the new scroll position, or null while the touch is still a possible tap. */
export function panMove(p: Pan, x: number, y: number, t: number): { sx: number; sy: number } | null {
  const dx = x - p.x0, dy = y - p.y0;
  if (p.mode === "pending") {
    if (Math.hypot(dx, dy) < SLOP) return null;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    p.mode = ay > ax * AXIS_RATIO ? "y" : ax > ay * AXIS_RATIO ? "x" : "free";
  }
  const dt = t - p.lt;
  if (dt > 0) {
    // A short average: the newest sample counts most, so a flick at the end of a slow drag throws.
    const ivx = -(x - p.lx) / dt, ivy = -(y - p.ly) / dt;
    p.vx = 0.8 * ivx + 0.2 * p.vx;
    p.vy = 0.8 * ivy + 0.2 * p.vy;
  }
  p.lx = x; p.ly = y; p.lt = t;
  if (p.mode === "x") p.vy = 0;
  if (p.mode === "y") p.vx = 0;
  return {
    sx: p.mode === "y" ? p.sx0 : p.sx0 - dx,
    sy: p.mode === "x" ? p.sy0 : p.sy0 - dy,
  };
}

/** The finger lifts. A tap, or a throw with a starting speed in px/ms. */
export function panEnd(p: Pan, t: number): { tap: boolean; vx: number; vy: number } {
  if (p.mode === "pending") return { tap: true, vx: 0, vy: 0 };
  if (t - p.lt > STALE_MS) return { tap: false, vx: 0, vy: 0 };
  return { tap: false, vx: p.vx, vy: p.vy };
}

/** One step of momentum: the distance to scroll in `dt` ms, and the speed after it. Null when done. */
export function momentum(vx: number, vy: number, dt: number): { dx: number; dy: number; vx: number; vy: number } | null {
  if (Math.hypot(vx, vy) < MIN_SPEED) return null;
  const k = Math.pow(DECAY, dt);
  // The exact distance under exponential decay over dt, not speed * dt, so frame drops do not change it.
  const dist = (1 - k) / -Math.log(DECAY);
  return { dx: vx * dist, dy: vy * dist, vx: vx * k, vy: vy * k };
}
