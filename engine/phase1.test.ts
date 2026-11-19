import { describe, expect, test } from "bun:test";
import { CellError, ERRORS, Sheet, Value } from "./sheet";
import { colToIndex, parseFormula, printFormula } from "./parser";

const at = (name: string) => {
  const m = /^([A-Z]+)(\d+)$/.exec(name)!;
  return [colToIndex(m[1]), parseInt(m[2], 10) - 1] as const;
};
const set = (s: Sheet, name: string, text: string) => { const [c, r] = at(name); return s.setInput(c, r, text); };
const get = (s: Sheet, name: string): Value => { const [c, r] = at(name); return s.getValue(c, r); };
const errName = (v: Value) => (v instanceof CellError ? ERRORS[v.code] : v);
const evalOne = (formula: string, setup: Record<string, string> = {}) => {
  const s = new Sheet(100, 10);
  for (const [k, v] of Object.entries(setup)) set(s, k, v);
  set(s, "J100", formula);
  return errName(get(s, "J100"));
};

describe("lookups, SUMIFS and dates", () => {
  const setup = { A1: "apple", A2: "Banana", A3: "cherry", B1: "10", B2: "20", B3: "30", C1: "1", C2: "3", C3: "5" };
  test("exact lookups", () => {
    expect(evalOne('=VLOOKUP("banana",A1:B3,2,FALSE)', setup)).toBe(20);
    expect(evalOne('=VLOOKUP("kiwi",A1:B3,2,FALSE)', setup)).toBe("#N/A");
    expect(evalOne('=VLOOKUP("apple",A1:B3,3,FALSE)', setup)).toBe("#REF!");
    expect(evalOne('=MATCH("CHERRY",A1:A3,0)', setup)).toBe(3);
    expect(evalOne('=XLOOKUP("cherry",A1:A3,B1:B3)', setup)).toBe(30);
    expect(evalOne('=XLOOKUP("kiwi",A1:A3,B1:B3,"none")', setup)).toBe("none");
    expect(evalOne('=XLOOKUP("kiwi",A1:A3,B1:B3)', setup)).toBe("#N/A");
    expect(evalOne('=XLOOKUP("kiwi",A1:A3,B1:B3,0,1)', setup)).toBe("#VALUE!"); // unsupported match mode: a clear error
    expect(evalOne("=INDEX(A1:B3,2,2)", setup)).toBe(20);
    expect(evalOne("=INDEX(A1:B3,4,1)", setup)).toBe("#REF!");
  });
  test("approximate match is the default for VLOOKUP and MATCH", () => {
    // C1:C3 = 1, 3, 5 (sorted). The largest value <= 4 is 3.
    expect(evalOne("=MATCH(4,C1:C3)", setup)).toBe(2);
    expect(evalOne("=VLOOKUP(4,C1:C3,1)", setup)).toBe(3);
    expect(evalOne("=VLOOKUP(0,C1:C3,1)", setup)).toBe("#N/A");
    expect(evalOne("=MATCH(4,C1:C3,0)", setup)).toBe("#N/A");
  });
  test("SUMIFS and COUNTIFS take the sum range first", () => {
    expect(evalOne('=SUMIFS(B1:B3,C1:C3,">1",A1:A3,"<>cherry")', setup)).toBe(20);
    expect(evalOne('=COUNTIFS(C1:C3,">=1",B1:B3,">10")', setup)).toBe(2);
  });
  test("dates", () => {
    expect(evalOne("=DATE(2026,11,19)")).toBe(46345);
    expect(evalOne("=YEAR(DATE(2024,2,29))")).toBe(2024);
    expect(evalOne("=MONTH(DATE(2024,13,1))")).toBe(1); // month 13 rolls into the next year
    expect(evalOne("=DAY(DATE(2024,3,0))")).toBe(29);
  });
});

describe("caches stay exact", () => {
  test("SUM, MAX and SUMIF over cached ranges follow edits", () => {
    const s = new Sheet(200, 3, { cacheMin: 4 });
    for (let r = 0; r < 100; r++) s.setNumber(0, r, r);
    s.fillFormula(1, 0, 0, "=SUM($A$1:$A$100)");
    s.fillFormula(1, 1, 1, "=MAX($A$1:$A$100)");
    s.fillFormula(1, 2, 2, '=COUNTIF($A$1:$A$100,5)');
    s.recalcAll();
    expect(get(s, "B1")).toBe(4950);
    set(s, "A100", "1000");
    expect(get(s, "B1")).toBe(4950 - 99 + 1000);
    expect(get(s, "B2")).toBe(1000);
    set(s, "A100", "1"); // the maximum leaves, so MAX must rescan
    expect(get(s, "B2")).toBe(98);
    set(s, "A50", "=1/0");
    expect(errName(get(s, "B1"))).toBe("#DIV/0!");
    set(s, "A50", "5");
    expect(get(s, "B1")).toBe(4950 - 99 + 1 - 49 + 5);
    expect(get(s, "B3")).toBe(2);
    expect(s.checkCaches()).toEqual([]);
    expect(s.cacheCounters().rangeScans).toBeLessThanOrEqual(2); // one scan at load, deltas after that
  });
  test("large swings do not drift", () => {
    const s = new Sheet(100, 2, { cacheMin: 4 });
    for (let r = 0; r < 100; r++) s.setNumber(0, r, 0.1);
    s.fillFormula(1, 0, 0, "=SUM($A$1:$A$100)");
    s.recalcAll();
    for (let i = 0; i < 500; i++) set(s, "A7", i % 2 ? "1e15" : "0.1");
    set(s, "A7", "0.1"); // end on the small value
    expect(Math.abs((get(s, "B1") as number) - 10)).toBeLessThan(1e-9);
  });
});

// Differential test with the caches on (cacheMin 4): random edits, then every value must equal a
// full recalc from scratch, and every cache and index must equal a fresh scan.
describe("differential with caches", () => {
  const ROWS = 30, COLS = 6;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const L = "ABCDEF";
  const cell = () => L[Math.floor(rnd() * COLS)] + (1 + Math.floor(rnd() * ROWS));
  const dollar = "$";
  // The sheet stays acyclic: a formula in column h reads only columns to its left.
  // (The phase 0 differential covers cycles.) So every cached path really runs.
  const leftCol = (h: number) => L[Math.floor(rnd() * h)];
  const leftCell = (h: number) => leftCol(h) + (1 + Math.floor(rnd() * ROWS));
  const abs = (h: number) => { const c = leftCell(h); return rnd() < 0.3 ? dollar + c.replace(/(\d+)/, (d) => dollar + d) : c; };
  const range = (h: number) => `${leftCell(h)}:${leftCell(h)}`;
  const absCol = (c: string) => pick([`${c}:${c}`, `${dollar}${c}${dollar}1:${dollar}${c}${dollar}${ROWS}`, `${dollar}${c}${dollar}3:${dollar}${c}${dollar}20`]);
  const key = (h: number) => pick(['"a"', '"B"', '"x"', "1", "TRUE", '"<>a"', '">2"', abs(h)]);
  const full = (c: string) => `${dollar}${c}${dollar}1:${dollar}${c}${dollar}${ROWS}`;
  const formula = (h: number): string => {
    const gens: (() => string)[] = [
      () => `=${abs(h)}+${abs(h)}*2`,
      () => `=SUM(${range(h)})`,
      () => `=IF(${abs(h)}>3,${abs(h)},${abs(h)}-1)`,
      () => `=IFERROR(${abs(h)}/${abs(h)},0)`,
      () => `=MAX(${range(h)})-MIN(${range(h)})`,
      () => `=${abs(h)}&"!"`,
      // Cached paths: whole or absolute columns.
      () => `=SUM(${absCol(leftCol(h))})`,
      () => `=${pick(["COUNT", "COUNTA", "MIN", "MAX", "AVERAGE"])}(${absCol(leftCol(h))})`,
      () => { const k = absCol(leftCol(h)); const sumCol = leftCol(h); return `=SUMIF(${k},${key(h)},${k.replace(/[A-F]/g, sumCol)})`; },
      () => `=COUNTIF(${absCol(leftCol(h))},${key(h)})`,
      () => `=IFERROR(MATCH(${abs(h)},${absCol(leftCol(h))},0),-1)`,
      () => `=SUMIFS(${full(leftCol(h))},${full(leftCol(h))},${key(h)},${full(leftCol(h))},">0")`,
    ];
    if (h >= 3) gens.push(() => `=IFERROR(VLOOKUP(${key(h)},${dollar}A${dollar}1:${dollar}C${dollar}${ROWS},2,FALSE),"none")`);
    if (h >= 4) gens.push(() => `=XLOOKUP(${key(h)},${full("B")},${full("D")},"nf")`);
    return pick(gens)();
  };
  const constant = () => pick([
    () => String(Math.floor(rnd() * 10)), () => "x", () => "", () => (rnd() * 5).toFixed(2),
    () => pick(["a", "A", "b", "B"]), () => "TRUE", () => "1e15", () => "=1/0",
  ])();

  const snapshot = (s: Sheet) => {
    const out: string[] = [];
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
      const v = s.getValue(c, r);
      // 10 significant digits: cached totals are compensated sums, plain scans are not.
      out.push(v instanceof CellError ? ERRORS[v.code] : typeof v === "number" ? (Math.abs(v) < 1e-6 ? "0" : v.toPrecision(10)) : String(v));
    }
    return out;
  };

  const edits = (n: number) => {
    const ops: [number, number, string][][] = [];
    for (let step = 0; step < n; step++) {
      const [c, r] = at(cell());
      if (rnd() < 0.1) {
        // A fill-down: every row shares one template.
        const r1 = Math.min(ROWS - 1, r + 1 + Math.floor(rnd() * 10));
        if (c === 0) { ops.push([[c, r, constant()]]); continue; }
        const ast = parseFormula(formula(c).slice(1), c, r);
        const batch: [number, number, string][] = [];
        for (let rr = r; rr <= r1; rr++) batch.push([c, rr, printFormula(ast, c, rr)]);
        ops.push(batch);
      } else ops.push([[c, r, c > 0 && rnd() < 0.5 ? formula(c) : constant()]]);
    }
    return ops;
  };

  const rebuild = (s: Sheet) => {
    const fresh = new Sheet(ROWS, COLS, { cacheMin: 4 });
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
      const input = s.getInput(c, r);
      if (input.startsWith("=")) fresh.fillFormula(c, r, r, input);
      else if (input !== "") fresh.setInput(c, r, input);
    }
    fresh.recalcAll();
    return fresh;
  };

  for (const startSeed of [12345, 999, 4242, 31337]) test(`seed ${startSeed}: 2,000 random edits match a full recalc, caches match a scan`, () => {
    seed = startSeed;
    const s = new Sheet(ROWS, COLS, { cacheMin: 4 });
    let checks = 0;
    edits(2000).forEach((batch, step) => {
      for (const [c, r, t] of batch) s.setInput(c, r, t);
      if (step % 20 === 19) {
        expect(snapshot(s)).toEqual(snapshot(rebuild(s)));
        expect(s.checkCaches()).toEqual([]);
        checks++;
      }
    });
    expect(checks).toBe(100);
    const k = s.cacheCounters();
    expect(k.rangeScans).toBeGreaterThan(0); // the caches were really used
    expect(k.groupBuilds).toBeGreaterThan(0);
    expect(k.lookupBuilds).toBeGreaterThan(0);
  });

  test("a recalc paused after every cell, with reads in between, gives the same result", () => {
    seed = 777;
    const ops = edits(600);
    const a = new Sheet(ROWS, COLS, { cacheMin: 4 });
    const b = new Sheet(ROWS, COLS, { cacheMin: 4 });
    let pauses = 0;
    for (const batch of ops) for (const [c, r, t] of batch) {
      a.setInput(c, r, t);
      b.beginInput(c, r, t);
      while (b.step(Infinity, 1) === null) {
        pauses++;
        // The reads that the worker serves between slices.
        for (let cc = 0; cc < COLS; cc++) { b.display(cc, r); b.isStale(cc, r); }
        b.precedents(c, r); b.dependents(c, r, 5); b.getInput(c, r);
      }
    }
    expect(pauses).toBeGreaterThan(100);
    expect(snapshot(b)).toEqual(snapshot(a));
    expect(b.checkCaches()).toEqual([]);
  });
});
