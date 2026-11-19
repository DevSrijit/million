// Soft axis lock for wheel and trackpad scrolling.
//
// A trackpad swipe always carries some motion on the other axis, so a grid that applies both axes
// drifts sideways on every vertical scroll. A hard per-gesture lock fixes the drift, but a trackpad
// keeps sending momentum events after the fingers lift, so a new sideways swipe looks like part of
// the old vertical gesture and is refused.
//
// This lock follows a running average of each axis and switches when the other axis clearly takes
// over (twice as strong). Noise is ignored; a deliberate swipe on the other axis wins within a few
// events, even through momentum.

export type AxisState = { axis: 0 | 1 | 2; ax: number; ay: number }; // axis: 0 unknown, 1 x, 2 y

export const newAxisState = (): AxisState => ({ axis: 0, ax: 0, ay: 0 });

// Returns the deltas to apply: one of them is always 0.
export function lockAxis(st: AxisState, dx: number, dy: number, fresh: boolean): [number, number] {
  if (fresh) { st.ax = 0; st.ay = 0; }
  st.ax = st.ax * 0.6 + Math.abs(dx) * 0.4;
  st.ay = st.ay * 0.6 + Math.abs(dy) * 0.4;
  if (st.axis !== 1 && st.ax > 2 * st.ay && st.ax > 1.5) st.axis = 1;
  else if (st.axis !== 2 && st.ay > 2 * st.ax && st.ay > 1.5) st.axis = 2;
  else if (st.axis === 0) st.axis = Math.abs(dx) > Math.abs(dy) ? 1 : 2;
  return st.axis === 1 ? [dx, 0] : [0, dy];
}
