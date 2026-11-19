import { describe, expect, test } from "bun:test";
import { momentum, panEnd, panMove, panStart } from "./touch-pan";

describe("touch pan", () => {
  test("a small wobble is a tap and does not scroll", () => {
    const p = panStart(100, 100, 0, 0, 0);
    expect(panMove(p, 103, 104, 40)).toBeNull();
    expect(panEnd(p, 90).tap).toBe(true);
  });

  test("a mostly vertical drag locks to the vertical axis", () => {
    const p = panStart(100, 300, 0, 50, 500);
    panMove(p, 104, 280, 16);
    const at = panMove(p, 110, 200, 32)!;
    expect(at.sx).toBe(50); // no sideways drift
    expect(at.sy).toBe(600); // the content follows the finger: up 100 px scrolls down 100 px
    expect(p.mode).toBe("y");
  });

  test("a diagonal drag pans both axes", () => {
    const p = panStart(200, 200, 0, 0, 0);
    const at = panMove(p, 170, 160, 16)!;
    expect(p.mode).toBe("free");
    expect(at).toEqual({ sx: 30, sy: 40 });
  });

  test("a flick throws in the scroll direction; a rest before release throws nothing", () => {
    const p = panStart(100, 400, 0, 0, 0);
    for (let i = 1; i <= 5; i++) panMove(p, 100, 400 - i * 20, i * 10); // 2 px/ms upwards
    const thrown = panEnd(p, 55);
    expect(thrown.tap).toBe(false);
    expect(thrown.vy).toBeCloseTo(2, 1);
    expect(panEnd(p, 200).vy).toBe(0);
  });

  test("momentum covers the same distance at 60 and 120 fps, and stops", () => {
    const run = (dt: number) => {
      let v = { vx: 0, vy: 2 }, y = 0, frames = 0;
      for (;;) {
        const m = momentum(v.vx, v.vy, dt);
        if (!m) break;
        y += m.dy; v = m; frames++;
      }
      return { y, frames };
    };
    const a = run(16.67), b = run(8.33);
    expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    expect(a.y).toBeGreaterThan(800); // 2 px/ms with a 500 ms time constant: about 1,000 px
    expect(a.y).toBeLessThan(1000);
    expect(a.frames).toBeLessThan(400);
  });
});
