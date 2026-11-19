import { describe, expect, test } from "bun:test";
import { CellError, ERRORS, ParseError, Sheet, Value } from "./sheet";
import { shiftFormula } from "./parser";

const show = (v: Value) => (v instanceof CellError ? ERRORS[v.code] : typeof v === "number" ? +v.toPrecision(12) : v);
const snapshot = (s: Sheet, rows: number, cols: number) => {
  const out: unknown[] = [];
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) out.push(show(s.getValue(c, r)));
  return out;
};

describe("batch writes", () => {
  test("a batch gives the same values as the same writes one by one", () => {
    const ROWS = 20, COLS = 5;
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const cell = () => [Math.floor(rnd() * COLS), Math.floor(rnd() * ROWS)] as const;
    const text = (c: number) => {
      const k = rnd();
      if (c === 0 || k < 0.5) return String(Math.floor(rnd() * 100));
      if (k < 0.6) return "";
      const src = "ABCDE"[Math.floor(rnd() * c)];
      return rnd() < 0.5 ? `=${src}${1 + Math.floor(rnd() * ROWS)}*2` : `=SUM(${src}:${src})`;
    };
    const a = new Sheet(ROWS, COLS), b = new Sheet(ROWS, COLS);
    for (let round = 0; round < 200; round++) {
      const batch: [number, number, string][] = [];
      const n = 1 + Math.floor(rnd() * 12);
      for (let i = 0; i < n; i++) { const [c, r] = cell(); batch.push([c, r, text(c)]); }
      a.setInputs(batch);
      for (const [c, r, t] of batch) b.setInput(c, r, t);
      expect(snapshot(a, ROWS, COLS)).toEqual(snapshot(b, ROWS, COLS));
    }
  });

  test("a batch recomputes a shared dependent once", () => {
    const s = new Sheet(10, 3);
    s.setInput(1, 0, "=SUM(A:A)");
    const st = s.setInputs([[0, 0, "1"], [0, 1, "2"], [0, 2, "3"]]);
    expect(s.getValue(1, 0)).toBe(6);
    expect(st.recomputed).toBe(1);
  });

  test("strict: a bad formula throws and nothing changes", () => {
    const s = new Sheet(5, 2);
    s.setInput(0, 0, "7");
    expect(() => s.setInputs([[0, 0, "9"], [0, 1, "=SUM("]])).toThrow(ParseError);
    expect(s.getValue(0, 0)).toBe(7);
  });

  test("lenient: a bad formula is kept as its text", () => {
    const s = new Sheet(5, 2);
    s.setInputs([[0, 0, "9"], [0, 1, "=SUM("]], true);
    expect(s.getValue(0, 0)).toBe(9);
    expect(s.getValue(0, 1)).toBe("=SUM(");
  });

  test("out-of-sheet cells in a batch are skipped", () => {
    const s = new Sheet(3, 2);
    s.setInputs([[0, 0, "1"], [5, 0, "2"], [0, 9, "3"]]);
    expect(s.getValue(0, 0)).toBe(1);
  });

  test("inputsIn reads formulas and values", () => {
    const s = new Sheet(3, 2);
    s.setInputs([[0, 0, "4"], [1, 0, "=A1*2"]]);
    expect(s.inputsIn(0, 0, 1, 0)).toEqual([["4", "=A1*2"]]);
  });
});

describe("shiftFormula (copy and paste)", () => {
  test("relative references move, absolute ones stay", () => {
    // From C1 (col 2, row 0) to C6 (col 2, row 5).
    expect(shiftFormula("=A1+$B$2", 2, 0, 2, 5)).toBe("=A6+$B$2");
    expect(shiftFormula("=A$1+$A1", 2, 0, 4, 3)).toBe("=C$1+$A4");
    expect(shiftFormula("=SUM(A1:B3)", 3, 0, 4, 2)).toBe("=SUM(B3:C5)");
    expect(shiftFormula("=SUM(G:G)", 9, 3, 10, 7)).toBe("=SUM(H:H)");
  });
  test("values and invalid formulas are unchanged", () => {
    expect(shiftFormula("42", 0, 0, 3, 3)).toBe("42");
    expect(shiftFormula("=SUM(", 0, 0, 3, 3)).toBe("=SUM(");
  });
  test("a reference shifted off the sheet becomes #REF", () => {
    expect(shiftFormula("=A1", 1, 1, 0, 0)).toContain("#REF");
  });
});
