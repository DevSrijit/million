import { describe, expect, test } from "bun:test";
import { lockAxis, newAxisState } from "./axis-lock";

// Seeded noise, so the test is the same every run.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const run = (events: [number, number][], fresh = false) => {
  const st = newAxisState();
  let x = 0, y = 0;
  events.forEach(([dx, dy], i) => { const [ax, ay] = lockAxis(st, dx, dy, fresh && i === 0); x += ax; y += ay; });
  return { x, y, st };
};

describe("soft axis lock", () => {
  test("a vertical swipe with sideways noise does not drift", () => {
    const ev: [number, number][] = [];
    for (let i = 0; i < 40; i++) ev.push([(rnd() - 0.3) * 6, 30]);
    const { x, y } = run(ev, true);
    expect(x).toBe(0);
    expect(y).toBe(1200);
  });

  test("a sideways swipe right after vertical momentum wins within a few events", () => {
    const st = newAxisState();
    for (let i = 0; i < 20; i++) lockAxis(st, rnd() * 3, 30, i === 0);
    for (let v = 30; v > 2; v *= 0.85) lockAxis(st, rnd() * 0.5, v, false); // momentum, no pause
    let wonAt = -1;
    for (let i = 0; i < 20; i++) {
      const [dx] = lockAxis(st, 25, rnd() * 2, false);
      if (dx !== 0 && wonAt < 0) wonAt = i + 1;
    }
    expect(wonAt).toBeGreaterThan(0);
    expect(wonAt).toBeLessThanOrEqual(3);
  });

  test("a vertical swipe with strong but not dominant sideways noise stays vertical", () => {
    const ev: [number, number][] = [];
    for (let i = 0; i < 40; i++) ev.push([rnd() * 12, 30]);
    expect(run(ev, true).x).toBe(0);
  });

  test("a diagonal-ish sideways swipe scrolls sideways only", () => {
    const ev: [number, number][] = [];
    for (let i = 0; i < 30; i++) ev.push([20, rnd() * 6]);
    const { x, y } = run(ev, true);
    expect(y).toBe(0);
    expect(x).toBe(600);
  });

  test("back to vertical after a sideways swipe", () => {
    const st = newAxisState();
    for (let i = 0; i < 15; i++) lockAxis(st, 20, 1, i === 0);
    let wonAt = -1;
    for (let i = 0; i < 10; i++) { const [, dy] = lockAxis(st, rnd(), 25, false); if (dy !== 0 && wonAt < 0) wonAt = i + 1; }
    expect(wonAt).toBeLessThanOrEqual(3);
  });
});
