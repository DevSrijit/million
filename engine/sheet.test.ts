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

describe("operators and precedence", () => {
  test("arithmetic", () => {
    expect(evalOne("=1+2*3")).toBe(7);
    expect(evalOne("=(1+2)*3")).toBe(9);
    expect(evalOne("=2^3^2")).toBe(64); // Excel is left-associative
    expect(evalOne("=-2^2")).toBe(4); // unary minus binds tighter than ^
    expect(evalOne("=10/4")).toBe(2.5);
    expect(evalOne("=50%")).toBe(0.5);
    expect(evalOne("=1+2&3")).toBe("33");
  });
  test("comparison", () => {
    expect(evalOne("=1<2")).toBe(true);
    expect(evalOne('="a"="A"')).toBe(true);
    expect(evalOne('="b">"a"')).toBe(true);
    expect(evalOne('=1<"a"')).toBe(true); // numbers sort before text
    expect(evalOne("=A1=0")).toBe(true); // empty equals 0
  });
});

describe("references and functions", () => {
  test("refs and ranges", () => {
    const setup = { A1: "1", A2: "2", A3: "3", B1: "hello", B2: "TRUE" };
    expect(evalOne("=A1+A2*A3", setup)).toBe(7);
    expect(evalOne("=SUM(A1:A3)", setup)).toBe(6);
    expect(evalOne("=SUM(A1:B3)", setup)).toBe(6); // text and booleans in ranges are skipped
    expect(evalOne("=AVERAGE(A:A)", setup)).toBe(2);
    expect(evalOne("=COUNT(A1:B3)", setup)).toBe(3);
    expect(evalOne("=COUNTA(A1:B3)", setup)).toBe(5);
    expect(evalOne("=MAX(A1:A3)-MIN(A1:A3)", setup)).toBe(2);
    expect(evalOne("=SUM(A1,10,SUM(A2:A3))", setup)).toBe(16);
    expect(evalOne("=$A$1+A$2+$A3", setup)).toBe(6);
  });
  test("IF, IFERROR, logic", () => {
    expect(evalOne('=IF(1>2,"y","n")')).toBe("n");
    expect(evalOne("=IF(0,1)")).toBe(false);
    expect(evalOne("=IFERROR(1/0,7)")).toBe(7);
    expect(evalOne("=IFERROR(SUM(1,1/0),7)")).toBe(7);
    expect(evalOne("=AND(1,TRUE,NOT(FALSE))")).toBe(true);
    expect(evalOne("=OR(0,FALSE)")).toBe(false);
  });
  test("SUMIF and COUNTIF", () => {
    const setup = { A1: "North", A2: "south", A3: "North", A4: "East", B1: "10", B2: "20", B3: "30", B4: "40" };
    expect(evalOne('=SUMIF(A1:A4,"north",B1:B4)', setup)).toBe(40);
    expect(evalOne('=SUMIF(A:A,"South",B:B)', setup)).toBe(20);
    expect(evalOne('=SUMIF(B1:B4,">15")', setup)).toBe(90);
    expect(evalOne('=COUNTIF(A1:A4,"<>North")', setup)).toBe(2);
    expect(evalOne('=COUNTIF(A:A,"<>North")', setup)).toBe(98); // blanks count as "not North", like Excel
    expect(evalOne('=COUNTIF(B:B,">=30")', setup)).toBe(2);
  });
  test("text functions", () => {
    expect(evalOne('=LEN("abc")&UPPER("x")')).toBe("3X");
    expect(evalOne('=CONCAT("a",1,TRUE)')).toBe("a1TRUE");
    expect(evalOne("=ROUND(2.345,2)")).toBe(2.35);
    expect(evalOne("=ROUND(-2.5,0)")).toBe(-3);
  });
});

describe("errors", () => {
  test("error values", () => {
    expect(evalOne("=1/0")).toBe("#DIV/0!");
    expect(evalOne('=1+"x"')).toBe("#VALUE!");
    expect(evalOne("=NOPE(1)")).toBe("#NAME?");
    expect(evalOne("=SQRT(-1)")).toBe("#NUM!");
    expect(evalOne("=A1+1", { A1: "=1/0" })).toBe("#DIV/0!");
    expect(evalOne("=SUM(A1:A3)", { A2: "=1/0" })).toBe("#DIV/0!");
  });
  test("reference off the sheet", () => {
    const s = new Sheet(10, 3);
    set(s, "A1", "=A1048576");
    expect(errName(get(s, "A1"))).toBe("#REF!");
  });
  test("cycles", () => {
    const s = new Sheet(10, 3);
    set(s, "A1", "=B1+1");
    set(s, "B1", "=A1+1");
    expect(errName(get(s, "A1"))).toBe("#CYCLE!");
    expect(errName(get(s, "B1"))).toBe("#CYCLE!");
    set(s, "C1", "=SUM(C1:C3)");
    expect(errName(get(s, "C1"))).toBe("#CYCLE!");
    set(s, "B1", "5"); // breaking the cycle heals it
    expect(get(s, "A1")).toBe(6);
  });
});

describe("incremental recalc", () => {
  test("chain updates", () => {
    const s = new Sheet(1000, 3);
    set(s, "A1", "1");
    s.fillFormula(0, 1, 999, "=A1+1"); // A2..A1000
    s.fillFormula(1, 0, 0, "=SUM(A:A)");
    s.recalcAll();
    expect(get(s, "A1000")).toBe(1000);
    const stats = set(s, "A1", "2");
    expect(get(s, "A1000")).toBe(1001);
    expect(get(s, "B1")).toBe(500500 + 1000);
    expect(stats.recomputed).toBe(1000); // 999 chain cells + the SUM
  });
  test("a deep chain does not overflow the stack", () => {
    const n = 200_000;
    const s = new Sheet(n, 2);
    // Fill bottom-up so that evaluation order is the worst case for a recursive engine.
    s.fillFormula(0, 0, n - 2, "=A2+1");
    s.setNumber(0, n - 1, 0);
    s.fillFormula(1, 0, 0, "=A1");
    const st = s.recalcAll();
    expect(get(s, "B1")).toBe(n - 1);
    expect(st.recomputed).toBe(n);
  });
  test("formula text round-trips through the printer", () => {
    for (const f of ["=A1+B2*3", "=SUM($A$1:B$9)", "=-A1^2", '=IF(A1>=2,"x",C3&"y")', "=SUMIF(A:A,\"N\",B:B)", "=(1+2)*3", "=1-(2-3)", "=50%"]) {
      const ast = parseFormula(f.slice(1), 4, 10);
      expect(printFormula(ast, 4, 10)).toBe(f);
    }
  });
});

// Differential test: random edits, then every value must equal a full recalc from scratch.
describe("differential", () => {
  const ROWS = 30, COLS = 6;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const cell = () => "ABCDEF"[Math.floor(rnd() * COLS)] + (1 + Math.floor(rnd() * ROWS));
  const abs = () => { const c = cell(); return rnd() < 0.3 ? "$" + c.replace(/(\d+)/, "$$$1") : c; };
  const range = () => { const a = cell(), b = cell(); return `${a}:${b}`; };
  const formula = () => pick([
    () => `=${abs()}+${abs()}*2`,
    () => `=SUM(${range()})`,
    () => `=IF(${abs()}>3,${abs()},${abs()}-1)`,
    () => `=IFERROR(${abs()}/${abs()},0)`,
    () => `=MAX(${range()})-MIN(${range()})`,
    () => `=SUMIF(${pick(["A:A", "B:B"])},">2",${pick(["C:C", "D:D"])})`,
    () => `=COUNTIF(${range().replace(/[A-F]/g, "A")},"x")`,
    () => `=AVERAGE(${range()})`,
    () => `=${abs()}&"!"`,
  ])();
  const constant = () => pick([() => String(Math.floor(rnd() * 10)), () => "x", () => "", () => (rnd() * 5).toFixed(2)])();

  const snapshot = (s: Sheet) => {
    const out: string[] = [];
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
      const v = s.getValue(c, r);
      out.push(v instanceof CellError ? ERRORS[v.code] : typeof v === "number" ? v.toPrecision(12) : String(v));
    }
    return out;
  };

  for (const startSeed of [12345, 999, 4242]) test(`seed ${startSeed}: 2,000 random edits and fill-downs match a full recalc`, () => {
    seed = startSeed;
    const s = new Sheet(ROWS, COLS);
    let checks = 0;
    for (let step = 0; step < 2000; step++) {
      const target = cell();
      if (rnd() < 0.1) {
        // Fill one formula down a run of rows, like a drag fill. Every row shares one template.
        const [c, r] = at(target);
        const r1 = Math.min(ROWS - 1, r + 1 + Math.floor(rnd() * 10));
        const ast = parseFormula(formula().slice(1), c, r);
        for (let rr = r; rr <= r1; rr++) s.setInput(c, rr, printFormula(ast, c, rr));
      } else set(s, target, rnd() < 0.5 ? formula() : constant());
      if (step % 20 === 19) {
        const incremental = snapshot(s);
        // Rebuild from the inputs alone and recalc everything.
        const fresh = new Sheet(ROWS, COLS);
        for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
          const input = s.getInput(c, r);
          if (input.startsWith("=")) fresh.fillFormula(c, r, r, input);
          else if (input !== "") fresh.setInput(c, r, input);
        }
        fresh.recalcAll();
        expect(incremental).toEqual(snapshot(fresh));
        checks++;
      }
    }
    expect(checks).toBe(100);
  });
});
