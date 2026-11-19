import { describe, expect, test } from "bun:test";
import { Cancelled, PilotApi, RATE, SCRATCH, UNITS, cycle, runPilot } from "./autopilot";

// A fake grid: a map of cell inputs, an editor, and a log of what the engine received.
function fakeGrid() {
  const cells = new Map<string, string>([[`${UNITS.col},${UNITS.row}`, "6"], [`${RATE.col},${RATE.row}`, "8%"]]);
  const key = (c: number, r: number) => `${c},${r}`;
  let sel = { col: 0, row: 1 };
  let editor: string | null = null;
  const writes: string[] = [];
  const api: PilotApi = {
    moveTo: () => 500,
    press: () => {},
    select: (col, row) => { sel = { col, row }; },
    extend: () => {},
    type: (t) => { editor = t; },
    typeName: () => {},
    commit: async () => {
      if (editor === null) throw new Error("commit with no open editor");
      cells.set(key(sel.col, sel.row), editor);
      writes.push(`${key(sel.col, sel.row)}=${editor}`);
      editor = null;
      sel = { col: sel.col, row: sel.row + 1 };
    },
    write: async (list) => { for (const [c, r, t] of list) { cells.set(key(c, r), t); writes.push(`${key(c, r)}=${t}`); } },
    read: (c, r) => cells.get(key(c, r)) ?? "",
    show: () => {},
  };
  return { api, cells, writes, editor: () => editor, snapshot: () => JSON.stringify([...cells].filter(([, v]) => v !== "").sort()) };
}

describe("autopilot", () => {
  test("a full cycle leaves the sheet as it found it", async () => {
    const g = fakeGrid();
    const before = g.snapshot();
    let clock = 0;
    await cycle(g.api, async (ms) => { clock += ms; }, 0);
    expect(g.snapshot()).toBe(before);
    expect(g.writes).toContain(`${RATE.col},${RATE.row}=12%`);
    expect(g.writes).toContain(`${SCRATCH.col},${SCRATCH.row}==MAX(K5:K8)`);
    // About 25 seconds a cycle: slow enough to read, short enough to see while scrolling past.
    expect(clock).toBeGreaterThan(15_000);
    expect(clock).toBeLessThan(40_000);
  });

  test("a stop in the middle of typing writes nothing", async () => {
    const g = fakeGrid();
    let steps = 0;
    // The visitor takes over during the first value: Sleep throws, as the grid's Sleep does.
    const sleep = async () => {
      if (++steps > 4 && g.editor() !== null) throw new Cancelled();
    };
    await runPilot(g.api, sleep, 0);
    expect(g.editor()).not.toBeNull(); // the grid's stop handler discards this text
    expect(g.writes).toEqual([]);
  });

  test("errors other than Cancelled are not swallowed", async () => {
    const g = fakeGrid();
    g.api.commit = async () => { throw new Error("engine gone"); };
    await expect(runPilot(g.api, async () => {}, 0)).rejects.toThrow("engine gone");
  });
});
