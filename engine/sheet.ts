// The sheet engine.
//
// Storage: each column owns typed arrays (value, type tag, formula id, recalc state, recalc stamp).
// A cell id is col * rows + row. No cell is ever a JS object.
//
// Writes: every value write goes through put(). It tells the column's watchers (range caches,
// group indexes) the old and the new value, and it bumps the column version (lookup indexes).
//
// Formulas: a formula is compiled once per (relative AST, host column) into a "template".
// A fill-down of 1M rows shares one template and one compiled JS function.
//
// Dependencies: no per-cell edges. A template knows its references in relative form, so the engine
// finds dependents by arithmetic. A range is one index entry, not one edge per cell.
//
// Recalc: an edit marks dependents dirty (BFS over the reverse index), then evaluates dirty cells in
// dependency order with an iterative DFS. The DFS state lives in typed-array stacks, so the work can
// pause between any two cells and resume later (step()).

import { MAX_ROW, Node, ParseError, Ref, parseFormula, printFormula, cellName } from "./parser";
import { formatNumber, NumFormat } from "./format";
import { GroupIndex, LookupIndex, RangeCache, Watcher } from "./caches";

export const EMPTY = 0, NUM = 1, STR = 2, BOOL = 3, ERR = 4;
export const ERRORS = ["#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#CYCLE!"] as const;
const E_DIV0 = 0, E_VALUE = 1, E_REF = 2, E_NAME = 3, E_NUM = 4, E_NA = 5, E_CYCLE = 6;
void E_NAME;

const CLEAN = 0, DIRTY = 1, VISITING = 2;
// Ranges at least this tall, with absolute rows, get an incremental cache or index.
// Tests lower it so that small sheets exercise the caches.
export const CACHE_MIN = 64;
const DAY0 = Date.UTC(1899, 11, 30);

export class CellError {
  constructor(public code: number) {}
}
const ERR_OBJ = ERRORS.map((_, i) => new CellError(i));

export type Value = number | string | boolean | null | CellError;

export type Column = {
  v: Float64Array;
  t: Uint8Array;
  f: Int32Array | null;
  st: Uint8Array | null;
  stamp: Uint32Array | null;
};

type AbsRef = { col: number; ra: boolean; r: number };
type AbsRange = { c0: number; c1: number; ra0: boolean; r0: number; ra1: boolean; r1: number };

type Template = {
  id: number; key: string; ast: Node; hostCol: number;
  fn: (r: number) => Value;
  refs: AbsRef[]; ranges: AbsRange[];
  count: number; min: number; max: number; indexed: boolean;
};

// `done` is the recalc epoch in which an absolute entry already marked all its hosts dirty.
type RevEntry = ({ tpl: Template; kind: 0; ref: AbsRef } | { tpl: Template; kind: 1; range: AbsRange }) & { done: number; absolute: boolean };

export type RecalcStats = { recomputed: number; ms: number; computeMs: number; epoch: number; cycles: number };

class Growable {
  a = new Int32Array(256);
  n = 0;
  push(x: number) {
    if (this.n === this.a.length) { const b = new Int32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = x;
  }
}

type Run = { qi: number; recomputed: number; cycles: number; computeMs: number; wallStart: number };

export class Sheet {
  readonly rows: number;
  readonly cols: number;
  private c: (Column | undefined)[];
  private V: (Float64Array | undefined)[];
  private T: (Uint8Array | undefined)[];

  private strs: string[] = [];
  private strIds = new Map<string, number>();
  private fold: number[] = [];

  private templates: Template[] = [];
  private tplByKey = new Map<string, Template>();
  private rev: RevEntry[][];

  private watchers: (Watcher[] | undefined)[];
  private colVersion: Uint32Array;
  private cycleCount: Int32Array; // #CYCLE! cells per column
  private cycleTotal = 0;
  private rangeCaches: RangeCache[] = [];
  private rangeCacheIds = new Map<string, number>();
  private groups: GroupIndex[] = [];
  private groupIds = new Map<string, number>();
  private lookups = new Map<string, LookupIndex>();

  formats: NumFormat[];
  cellFormats = new Map<number, NumFormat>();

  epoch = 0;
  private queue = new Growable();
  private dirtyRows: (Growable | undefined)[];
  private dirtyCols: number[] = [];
  private notClean: Int32Array; // cells per column that are DIRTY or VISITING in the current run

  private stk = new Int32Array(1024);
  private curA = new Int32Array(1024);
  private curB = new Int32Array(1024);
  private curC = new Int32Array(1024);
  private sp = 0;
  private run: Run | null = null;
  private cycleTarget = -1;

  private aSum = new Float64Array(64);
  private aCnt = new Float64Array(64);
  private aCntA = new Float64Array(64);
  private aMin = new Float64Array(64);
  private aMax = new Float64Array(64);
  private ad = 0;

  readonly cacheMin: number;

  // Memory for column arrays. The worker passes a SharedArrayBuffer allocator, so the renderer on
  // the main thread can read cells straight from engine memory. onColumn reports every new array.
  private alloc: (bytes: number) => ArrayBufferLike;
  private onColumn?: (c: number, col: Column) => void;

  constructor(rows: number, cols: number, opts: { cacheMin?: number; alloc?: (bytes: number) => ArrayBufferLike; onColumn?: (c: number, col: Column) => void } = {}) {
    this.cacheMin = opts.cacheMin ?? CACHE_MIN;
    this.alloc = opts.alloc ?? ((n) => new ArrayBuffer(n));
    this.onColumn = opts.onColumn;
    this.rows = rows;
    this.cols = cols;
    this.c = new Array(cols);
    this.V = new Array(cols);
    this.T = new Array(cols);
    this.rev = Array.from({ length: cols }, () => []);
    this.watchers = new Array(cols);
    this.colVersion = new Uint32Array(cols);
    this.cycleCount = new Int32Array(cols);
    this.dirtyRows = new Array(cols);
    this.notClean = new Int32Array(cols);
    this.formats = new Array(cols).fill("general");
  }

  // ---------- storage and the single write path ----------

  private col(c: number): Column {
    let k = this.c[c];
    if (!k) {
      k = { v: new Float64Array(this.alloc(this.rows * 8)), t: new Uint8Array(this.alloc(this.rows)), f: null, st: null, stamp: null };
      this.c[c] = k;
      this.V[c] = k.v;
      this.T[c] = k.t;
      this.onColumn?.(c, k);
    }
    return k;
  }

  private formulaCol(c: number): Column {
    const k = this.col(c);
    if (!k.f) {
      k.f = new Int32Array(this.alloc(this.rows * 4));
      k.st = new Uint8Array(this.alloc(this.rows));
      k.stamp = new Uint32Array(this.alloc(this.rows * 4));
      this.onColumn?.(c, k);
    }
    return k;
  }

  intern(s: string): number {
    let id = this.strIds.get(s);
    if (id !== undefined) return id;
    id = this.strs.length;
    this.strs.push(s);
    this.strIds.set(s, id);
    const lower = s.toLowerCase();
    this.fold[id] = lower === s ? id : this.intern(lower);
    return id;
  }

  // Every value write in the engine goes through here.
  private put(k: Column, c: number, r: number, tag: number, val: number) {
    const ot = k.t[r];
    if (ot === ERR || tag === ERR) {
      if (ot === ERR && k.v[r] === E_CYCLE) { this.cycleCount[c]--; this.cycleTotal--; }
      if (tag === ERR && val === E_CYCLE) { this.cycleCount[c]++; this.cycleTotal++; }
    }
    const w = this.watchers[c];
    if (w !== undefined) {
      const ov = k.v[r];
      k.t[r] = tag; k.v[r] = val;
      for (let i = 0; i < w.length; i++) w[i].onWrite(c, r, ot, ov, tag, val);
    } else { k.t[r] = tag; k.v[r] = val; }
    this.colVersion[c]++;
  }

  private store(k: Column, c: number, row: number, x: Value) {
    if (typeof x === "number") {
      if (x !== x || x === Infinity || x === -Infinity) this.put(k, c, row, ERR, E_NUM);
      else this.put(k, c, row, NUM, x);
    } else if (typeof x === "string") this.put(k, c, row, STR, this.intern(x));
    else if (typeof x === "boolean") this.put(k, c, row, BOOL, x ? 1 : 0);
    else if (x === null) this.put(k, c, row, NUM, 0);
    else this.put(k, c, row, ERR, x.code);
  }

  private watch(c: number, w: Watcher) {
    (this.watchers[c] ??= []).push(w);
  }

  // Bulk load: constants, no recalc.
  setNumber(c: number, r: number, x: number) { this.finish(); this.put(this.col(c), c, r, NUM, x); }
  setString(c: number, r: number, s: string) { this.finish(); this.put(this.col(c), c, r, STR, this.intern(s)); }

  // Bulk load: one formula filled from r0 to r1 (like a drag fill). Text is written for row r0. No recalc.
  fillFormula(c: number, r0: number, r1: number, text: string) {
    this.finish();
    const tpl = this.template(parseFormula(text.slice(1), c, r0), c);
    const k = this.formulaCol(c);
    const f = k.f!;
    for (let r = r0; r <= r1; r++) {
      const old = f[r] - 1;
      if (old >= 0) this.unhost(this.templates[old]);
      f[r] = tpl.id + 1;
    }
    tpl.count += r1 - r0 + 1;
    if (r0 < tpl.min) tpl.min = r0;
    if (r1 > tpl.max) tpl.max = r1;
    this.index(tpl);
  }

  // ---------- reading ----------

  getValue(c: number, r: number): Value {
    const k = this.c[c];
    if (!k) return null;
    switch (k.t[r]) {
      case NUM: return k.v[r];
      case STR: return this.strs[k.v[r]];
      case BOOL: return k.v[r] !== 0;
      case ERR: return ERR_OBJ[k.v[r]];
      default: return null;
    }
  }

  isFormula(c: number, r: number): boolean {
    const k = this.c[c];
    return !!(k && k.f && k.f[r] !== 0);
  }

  // True while a paused recalc has not reached this cell yet.
  isStale(c: number, r: number): boolean {
    const st = this.c[c]?.st;
    return !!st && st[r] !== CLEAN;
  }

  getInput(c: number, r: number): string {
    const k = this.c[c];
    if (k && k.f && k.f[r] !== 0) return printFormula(this.templates[k.f[r] - 1].ast, c, r);
    const v = this.getValue(c, r);
    if (v === null) return "";
    if (v instanceof CellError) return ERRORS[v.code];
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    return String(v);
  }

  display(c: number, r: number): string {
    const k = this.c[c];
    if (!k) return "";
    switch (k.t[r]) {
      case NUM: return formatNumber(k.v[r], this.cellFormats.get(c * this.rows + r) ?? this.formats[c]);
      case STR: return this.strs[k.v[r]];
      case BOOL: return k.v[r] !== 0 ? "TRUE" : "FALSE";
      case ERR: return ERRORS[k.v[r]];
      default: return "";
    }
  }

  // Strings interned since index `from`, for the renderer's mirror of the pool.
  stringsFrom(from: number): string[] { return this.strs.slice(from); }
  get stringCount(): number { return this.strs.length; }

  tag(c: number, r: number): number { return this.c[c]?.t[r] ?? EMPTY; }
  stamp(c: number, r: number): number { return this.c[c]?.stamp?.[r] ?? 0; }
  get running(): boolean { return this.run !== null; }

  // ---------- templates and the reverse index ----------

  private template(ast: Node, hostCol: number): Template {
    const key = hostCol + "|" + JSON.stringify(ast);
    let tpl = this.tplByKey.get(key);
    if (tpl) return tpl;
    const refs: AbsRef[] = [];
    const ranges: AbsRange[] = [];
    const fn = this.compile(ast, hostCol, refs, ranges);
    tpl = { id: this.templates.length, key, ast, hostCol, fn, refs, ranges, count: 0, min: this.rows, max: -1, indexed: false };
    this.templates.push(tpl);
    this.tplByKey.set(key, tpl);
    return tpl;
  }

  private index(tpl: Template) {
    if (tpl.indexed || tpl.count === 0) return;
    tpl.indexed = true;
    for (const ref of tpl.refs) this.rev[ref.col].push({ tpl, kind: 0, ref, done: 0, absolute: ref.ra });
    for (const range of tpl.ranges) for (let c = range.c0; c <= range.c1; c++) this.rev[c].push({ tpl, kind: 1, range, done: 0, absolute: range.ra0 && range.ra1 });
  }

  private unindex(tpl: Template) {
    if (!tpl.indexed) return;
    tpl.indexed = false;
    for (let c = 0; c < this.cols; c++) {
      const list = this.rev[c];
      for (let i = list.length - 1; i >= 0; i--) if (list[i].tpl === tpl) list.splice(i, 1);
    }
  }

  private host(tpl: Template, r: number) {
    tpl.count++;
    if (r < tpl.min) tpl.min = r;
    if (r > tpl.max) tpl.max = r;
    this.index(tpl);
  }

  private unhost(tpl: Template) {
    tpl.count--;
    if (tpl.count === 0) { this.unindex(tpl); tpl.min = this.rows; tpl.max = -1; }
  }

  // Host-row interval of template `ent.tpl` that reads (c, r) through this entry.
  // Returns false when there is none; otherwise the interval is in ivLo..ivHi (no allocation: hot path).
  private ivLo = 0;
  private ivHi = 0;
  private hostInterval(ent: RevEntry, r: number): boolean {
    const tpl = ent.tpl;
    let lo = tpl.min, hi = tpl.max;
    if (ent.kind === 0) {
      const ref = ent.ref;
      if (ref.ra) { if (r !== ref.r) return false; }
      else { const h = r - ref.r; if (h < lo || h > hi) return false; lo = hi = h; }
    } else {
      const g = ent.range;
      if (g.ra0) { if (r < g.r0) return false; } else { const h = r - g.r0; if (h < hi) hi = h; }
      if (g.ra1) { if (r > g.r1) return false; } else { const h = r - g.r1; if (h > lo) lo = h; }
    }
    if (lo < 0) lo = 0;
    if (hi >= this.rows) hi = this.rows - 1;
    this.ivLo = lo;
    this.ivHi = hi;
    return lo <= hi;
  }

  private markDirty(k: Column, c: number, r: number) {
    k.st![r] = DIRTY;
    this.notClean[c]++;
    this.queue.push(c * this.rows + r);
    let list = this.dirtyRows[c];
    if (!list) list = this.dirtyRows[c] = new Growable();
    if (list.n === 0) this.dirtyCols.push(c);
    list.push(r);
  }

  private markDependents(c: number, r: number) {
    const list = this.rev[c];
    for (let e = 0; e < list.length; e++) {
      const ent = list[e];
      if (ent.done === this.epoch) continue;
      if (!this.hostInterval(ent, r)) continue;
      // An absolute entry has the same hosts for every row it covers: after one pass they are all dirty.
      if (ent.absolute) ent.done = this.epoch;
      const tpl = ent.tpl;
      const hc = tpl.hostCol;
      const hk = this.c[hc]!;
      const f = hk.f!, st = hk.st!;
      const mark = tpl.id + 1;
      // Inlined markDirty: this loop runs once per dirty cell, millions of times on a big edit.
      let dl = this.dirtyRows[hc];
      if (!dl) dl = this.dirtyRows[hc] = new Growable();
      const q = this.queue;
      const base = hc * this.rows;
      const wasEmpty = dl.n === 0;
      let qa = q.a, qn = q.n, la = dl.a, ln = dl.n;
      for (let h = this.ivLo, end = this.ivHi; h <= end; h++) {
        if (f[h] !== mark || st[h] === DIRTY) continue;
        st[h] = DIRTY;
        if (qn === qa.length) { const x = new Int32Array(qa.length * 2); x.set(qa); qa = x; }
        qa[qn++] = base + h;
        if (ln === la.length) { const x = new Int32Array(la.length * 2); x.set(la); la = x; }
        la[ln++] = h;
      }
      this.notClean[hc] += ln - dl.n;
      q.a = qa; q.n = qn; dl.a = la; dl.n = ln;
      if (wasEmpty && ln > 0) this.dirtyCols.push(hc);
    }
  }

  // ---------- editing and the resumable recalc ----------

  // Writes input and recalculates to the end. Throws ParseError for a bad formula (nothing changes).
  setInput(c: number, r: number, text: string): RecalcStats {
    this.beginInput(c, r, text);
    return this.step()!;
  }

  // Writes input and marks dependents, but evaluates nothing yet. Call step() to do the work.
  beginInput(c: number, r: number, text: string) {
    this.finish();
    const tpl = text.startsWith("=") && text.length > 1 ? this.template(parseFormula(text.slice(1), c, r), c) : null;
    const k = tpl ? this.formulaCol(c) : this.col(c);
    if (k.f && k.f[r] !== 0) { this.unhost(this.templates[k.f[r] - 1]); k.f[r] = 0; k.st![r] = CLEAN; }
    this.startRun();
    if (tpl) {
      k.f![r] = tpl.id + 1;
      this.host(tpl, r);
      this.markDirty(k, c, r);
    } else {
      this.writeConstant(k, c, r, text);
      if (k.stamp) k.stamp[r] = this.epoch;
      this.queue.push(c * this.rows + r);
    }
    const q = this.queue;
    for (let i = 0; i < q.n; i++) {
      const id = q.a[i];
      const cc = (id / this.rows) | 0;
      this.markDependents(cc, id - cc * this.rows);
    }
  }

  private writeConstant(k: Column, c: number, r: number, text: string) {
    const s = text.trim();
    if (s === "") return this.put(k, c, r, EMPTY, 0);
    const up = s.toUpperCase();
    if (up === "TRUE" || up === "FALSE") return this.put(k, c, r, BOOL, up === "TRUE" ? 1 : 0);
    const pct = s.endsWith("%");
    const n = Number((pct ? s.slice(0, -1) : s).replace(/,/g, ""));
    if (Number.isFinite(n) && !/^0x/i.test(s)) return this.put(k, c, r, NUM, pct ? n / 100 : n);
    this.put(k, c, r, STR, this.intern(text));
  }

  // Full recalculation of every formula. Used at load and by the differential test.
  recalcAll(): RecalcStats {
    this.finish();
    this.startRun();
    for (let c = 0; c < this.cols; c++) {
      const k = this.c[c];
      if (!k || !k.f) continue;
      const f = k.f;
      for (let r = 0; r < this.rows; r++) if (f[r] !== 0) this.markDirty(k, c, r);
    }
    return this.step()!;
  }

  private startRun() {
    this.epoch++;
    this.queue.n = 0;
    for (const c of this.dirtyCols) this.dirtyRows[c]!.n = 0;
    this.dirtyCols.length = 0;
    this.notClean.fill(0);
    this.sp = 0;
    this.run = { qi: 0, recomputed: 0, cycles: 0, computeMs: 0, wallStart: performance.now() };
  }

  // Finishes any paused recalc.
  finish() { if (this.run) this.step(); }

  // Evaluates dirty cells for up to `budgetMs` (or `maxEvals` cells). Returns stats when done, null when paused.
  step(budgetMs = Infinity, maxEvals = Infinity): RecalcStats | null {
    const run = this.run;
    if (!run) return null;
    const t0 = performance.now();
    const deadline = t0 + budgetMs;
    const q = this.queue, R = this.rows;
    let evals = 0;
    let paused = false;
    for (;;) {
      if (this.sp > 0) {
        const res = this.dfs(deadline, maxEvals - evals);
        evals += res;
        run.recomputed += res;
        if (this.sp > 0) { paused = true; break; }
        continue;
      }
      if (run.qi >= q.n) break;
      if (evals >= maxEvals || ((run.qi & 255) === 0 && performance.now() > deadline)) { paused = true; break; }
      const id = q.a[run.qi++];
      const c = (id / R) | 0, r = id - c * R;
      const st = this.c[c]!.st;
      if (st && st[r] === DIRTY) { st[r] = VISITING; this.push(id); }
    }
    run.computeMs += performance.now() - t0;
    if (paused) return null;
    this.run = null;
    return { recomputed: run.recomputed, ms: performance.now() - run.wallStart, computeMs: run.computeMs, epoch: this.epoch, cycles: run.cycles };
  }

  private push(id: number) {
    if (this.sp === this.stk.length) {
      const n = this.stk.length * 2;
      const grow = (x: Int32Array) => { const y = new Int32Array(n); y.set(x); return y; };
      this.stk = grow(this.stk); this.curA = grow(this.curA); this.curB = grow(this.curB); this.curC = grow(this.curC);
    }
    this.stk[this.sp] = id;
    this.curA[this.sp] = 0;
    this.curB[this.sp] = 0;
    this.curC[this.sp] = 0;
    this.sp++;
  }

  // Runs the DFS until the stack is empty, the deadline passes, or `maxEvals` cells are done.
  // Returns the number of cells it evaluated.
  private dfs(deadline: number, maxEvals: number): number {
    const R = this.rows;
    let evaluated = 0;
    while (this.sp > 0) {
      if (evaluated >= maxEvals || ((evaluated & 127) === 127 && performance.now() > deadline)) break;
      const top = this.stk[this.sp - 1];
      const p = this.nextDirtyPrecedent(top);
      if (p >= 0) {
        this.c[(p / R) | 0]!.st![p % R] = VISITING;
        this.push(p);
        continue;
      }
      if (p === -2) {
        // A precedent is already on the stack: a cycle. Every frame from it to the top gets #CYCLE!.
        this.run!.cycles++;
        const back = this.cycleTarget;
        let i = this.sp - 1;
        while (i > 0 && this.stk[i] !== back) i--;
        for (let j = this.sp - 1; j >= i; j--) {
          const id = this.stk[j];
          const c = (id / R) | 0, r = id - c * R;
          const k = this.c[c]!;
          this.put(k, c, r, ERR, E_CYCLE);
          k.st![r] = CLEAN;
          this.notClean[c]--;
          k.stamp![r] = this.epoch;
          evaluated++;
        }
        this.sp = i;
        continue;
      }
      const c = (top / R) | 0, r = top - c * R;
      const k = this.c[c]!;
      const tpl = this.templates[k.f![r] - 1];
      this.ad = 0;
      let x: Value;
      if (this.cycleTotal > 0 && this.readsCycle(tpl, r)) x = ERR_OBJ[E_CYCLE];
      else try { x = tpl.fn(r); } catch (e) { if (e instanceof CellError) x = e; else throw e; }
      this.store(k, c, r, x);
      k.st![r] = CLEAN;
      this.notClean[c]--;
      k.stamp![r] = this.epoch;
      evaluated++;
      this.sp--;
    }
    return evaluated;
  }

  // A cell that reads a #CYCLE! cell is #CYCLE! too, even through a function that skips errors (SUMIF).
  // So every cell in or below a cycle gets #CYCLE!, whatever order the search visits them in.
  private readsCycle(tpl: Template, r: number): boolean {
    const R = this.rows;
    for (const ref of tpl.refs) {
      if (this.cycleCount[ref.col] === 0) continue;
      const tr = ref.ra ? ref.r : r + ref.r;
      if (tr >= 0 && tr < R && this.T[ref.col]![tr] === ERR && this.V[ref.col]![tr] === E_CYCLE) return true;
    }
    for (const g of tpl.ranges) {
      let lo = g.ra0 ? g.r0 : r + g.r0, hi = g.ra1 ? g.r1 : r + g.r1;
      if (lo < 0) lo = 0;
      if (hi >= R) hi = R - 1;
      for (let c = g.c0; c <= g.c1; c++) {
        if (this.cycleCount[c] === 0) continue;
        const t = this.T[c]!, v = this.V[c]!;
        for (let i = lo; i <= hi; i++) if (t[i] === ERR && v[i] === E_CYCLE) return true;
      }
    }
    return false;
  }

  // Finds the next precedent of `top` that is dirty, resuming from the frame cursor.
  // A range column with few dirty cells is checked through its dirty list, not row by row.
  // Returns a cell id, -1 when none is left, or -2 for a cycle.
  private nextDirtyPrecedent(top: number): number {
    const R = this.rows;
    const fr = this.sp - 1;
    const c = (top / R) | 0, r = top - c * R;
    const tpl = this.templates[this.c[c]!.f![r] - 1];
    let a = this.curA[fr];
    const nRefs = tpl.refs.length;
    while (a < nRefs) {
      const ref = tpl.refs[a++];
      const tr = ref.ra ? ref.r : r + ref.r;
      if (tr < 0 || tr >= R) continue;
      const st = this.c[ref.col]?.st;
      if (!st) continue;
      const s = st[tr];
      if (s === DIRTY) { this.curA[fr] = a; return ref.col * R + tr; }
      if (s === VISITING) { this.curA[fr] = a; this.cycleTarget = ref.col * R + tr; return -2; }
    }
    let b = this.curB[fr], p = this.curC[fr];
    while (a - nRefs < tpl.ranges.length) {
      const g = tpl.ranges[a - nRefs];
      let lo = g.ra0 ? g.r0 : r + g.r0;
      let hi = g.ra1 ? g.r1 : r + g.r1;
      if (lo < 0) lo = 0;
      if (hi >= R) hi = R - 1;
      const height = hi - lo + 1;
      const ncol = height > 0 ? g.c1 - g.c0 + 1 : 0;
      while (b < ncol) {
        const cc = g.c0 + b;
        const st = this.c[cc]?.st;
        const list = this.dirtyRows[cc];
        // notClean is 0 once every dirty cell of the column is done: skip the column in O(1).
        if (st && list && list.n > 0 && this.notClean[cc] > 0) {
          if (list.n < height) {
            const rows = list.a;
            for (; p < list.n; p++) {
              const i = rows[p];
              if (i < lo || i > hi) continue;
              const s = st[i];
              if (s === DIRTY) { this.curA[fr] = a; this.curB[fr] = b; this.curC[fr] = p + 1; return cc * R + i; }
              if (s === VISITING) { this.curA[fr] = a; this.curB[fr] = b; this.curC[fr] = p + 1; this.cycleTarget = cc * R + i; return -2; }
            }
          } else {
            for (let i = lo + p; i <= hi; i++) {
              const s = st[i];
              if (s === DIRTY) { this.curA[fr] = a; this.curB[fr] = b; this.curC[fr] = i - lo + 1; return cc * R + i; }
              if (s === VISITING) { this.curA[fr] = a; this.curB[fr] = b; this.curC[fr] = i - lo + 1; this.cycleTarget = cc * R + i; return -2; }
            }
          }
        }
        b++;
        p = 0;
      }
      a++;
      b = 0;
      p = 0;
    }
    this.curA[fr] = a;
    this.curB[fr] = 0;
    this.curC[fr] = 0;
    return -1;
  }

  // ---------- inspection (read-only: safe while a recalc is paused) ----------

  precedents(c: number, r: number): { refs: { col: number; row: number }[]; ranges: { c0: number; c1: number; r0: number; r1: number }[] } {
    const k = this.c[c];
    if (!k || !k.f || k.f[r] === 0) return { refs: [], ranges: [] };
    const tpl = this.templates[k.f[r] - 1];
    return {
      refs: tpl.refs.map((x) => ({ col: x.col, row: x.ra ? x.r : r + x.r })),
      ranges: tpl.ranges.map((g) => ({
        c0: g.c0, c1: g.c1,
        r0: Math.max(0, g.ra0 ? g.r0 : r + g.r0),
        r1: Math.min(this.rows - 1, g.ra1 ? g.r1 : r + g.r1),
      })),
    };
  }

  // Direct dependents of a cell: the exact count and up to `limit` positions. Writes no engine state.
  dependents(c: number, r: number, limit: number): { count: number; cells: { col: number; row: number }[] } {
    const byTpl = new Map<Template, [number, number][]>();
    for (const ent of this.rev[c]) {
      if (!this.hostInterval(ent, r)) continue;
      const iv: [number, number] = [this.ivLo, this.ivHi];
      const list = byTpl.get(ent.tpl);
      if (list) list.push(iv); else byTpl.set(ent.tpl, [iv]);
    }
    let count = 0;
    const cells: { col: number; row: number }[] = [];
    for (const [tpl, ivs] of byTpl) {
      // Merge intervals so a template that reads the cell twice counts each host once.
      ivs.sort((x, y) => x[0] - y[0]);
      const f = this.c[tpl.hostCol]!.f!;
      const mark = tpl.id + 1;
      let end = -1;
      for (const [lo, hi] of ivs) {
        for (let h = Math.max(lo, end + 1); h <= hi; h++) {
          if (f[h] !== mark) continue;
          count++;
          if (cells.length < limit) cells.push({ col: tpl.hostCol, row: h });
        }
        if (hi > end) end = hi;
      }
    }
    return { count, cells };
  }

  stats() {
    let formulas = 0, cells = 0, bytes = 0;
    for (const k of this.c) {
      if (!k) continue;
      bytes += k.v.byteLength + k.t.byteLength;
      for (let r = 0; r < this.rows; r++) if (k.t[r] !== EMPTY) cells++;
      if (k.f) {
        bytes += k.f.byteLength + k.st!.byteLength + k.stamp!.byteLength;
        for (let r = 0; r < this.rows; r++) if (k.f[r] !== 0) formulas++;
      }
    }
    return {
      cells, formulas, templates: this.templates.filter((t) => t.count > 0).length, strings: this.strs.length, typedArrayMB: bytes / 1048576,
      rangeCaches: this.rangeCaches.length, groupIndexes: this.groups.length,
    };
  }

  // For tests: every cache and index must equal a fresh scan. Returns a list of mismatches.
  checkCaches(): string[] {
    const bad: string[] = [];
    const close = (a: number, b: number) => a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    for (const rc of this.rangeCaches) {
      if (!rc.valid) continue;
      rc.refresh();
      const t = this.T[rc.c]!, v = this.V[rc.c]!;
      let s = 0, n = 0, na = 0, e = 0, mn = Infinity, mx = -Infinity;
      for (let i = rc.lo; i <= rc.hi; i++) {
        if (t[i] === NUM) { s += v[i]; n++; mn = Math.min(mn, v[i]); mx = Math.max(mx, v[i]); }
        else if (t[i] === ERR) e++;
        if (t[i] !== EMPTY) na++;
      }
      if (!close(rc.sum, s) || rc.cnt !== n || rc.cntA !== na || rc.errs !== e || rc.min !== mn || rc.max !== mx)
        bad.push(`range ${rc.c}:${rc.lo}:${rc.hi} sum ${rc.sum}/${s} cnt ${rc.cnt}/${n} cntA ${rc.cntA}/${na} errs ${rc.errs}/${e} min ${rc.min}/${mn} max ${rc.max}/${mx}`);
    }
    for (const g of this.groups) {
      if (!g.built) continue;
      // Compare every key bucket with a scan.
      const kt = this.T[g.keyCol]!, kv = this.V[g.keyCol]!, st = this.T[g.sumCol]!, sv = this.V[g.sumCol]!;
      const sums = new Map<string, number>(), cnts = new Map<string, number>();
      let tot = 0;
      for (let r = g.lo; r <= g.hi; r++) {
        const tg = kt[r];
        const key = tg === STR ? `s${this.fold[kv[r]]}` : tg === NUM ? `n${kv[r]}` : tg === BOOL ? `b${kv[r]}` : null;
        const j = r + g.sOff;
        const x = st[j] === NUM ? sv[j] : 0;
        if (st[j] === NUM) tot += x;
        if (key) { sums.set(key, (sums.get(key) ?? 0) + x); cnts.set(key, (cnts.get(key) ?? 0) + 1); }
      }
      for (const [key, s] of sums) {
        const tag = key[0] === "s" ? STR : key[0] === "n" ? NUM : BOOL;
        const val = Number(key.slice(1));
        if (!close(g.query("=", tag, val, false), s) || g.query("=", tag, val, true) !== cnts.get(key)) bad.push(`group ${g.keyCol} key ${key}`);
      }
      if (!close(g.query("<>", -1, 0, false), tot)) bad.push(`group ${g.keyCol} total`);
    }
    return bad;
  }

  cacheCounters() {
    return {
      rangeScans: this.rangeCaches.reduce((n, c) => n + c.scans, 0),
      groupBuilds: this.groups.reduce((n, g) => n + g.builds, 0),
      lookupBuilds: [...this.lookups.values()].reduce((n, l) => n + l.builds, 0),
    };
  }

  // ---------- compiler: AST -> JS function ----------

  private rangeCacheId(c: number, lo: number, hi: number): number {
    const key = `${c}:${lo}:${hi}`;
    let id = this.rangeCacheIds.get(key);
    if (id === undefined) {
      const k = this.col(c);
      const rc = new RangeCache(c, lo, hi, k.t, k.v);
      id = this.rangeCaches.length;
      this.rangeCaches.push(rc);
      this.rangeCacheIds.set(key, id);
      this.watch(c, rc);
    }
    return id;
  }

  private groupId(keyCol: number, lo: number, hi: number, sumCol: number, sOff: number): number {
    const key = `${keyCol}:${lo}:${hi}:${sumCol}:${sOff}`;
    let id = this.groupIds.get(key);
    if (id === undefined) {
      this.col(keyCol); this.col(sumCol);
      const g = new GroupIndex(keyCol, lo, hi, sumCol, sOff, this.T, this.V, this.fold);
      id = this.groups.length;
      this.groups.push(g);
      this.groupIds.set(key, id);
      this.watch(keyCol, g);
      if (sumCol !== keyCol) this.watch(sumCol, g);
    }
    return id;
  }

  private compile(ast: Node, hostCol: number, refs: AbsRef[], ranges: AbsRange[]): (r: number) => Value {
    const R = this.rows;
    const cols = new Set<number>();
    let bad = false;
    const colOf = (x: Ref) => (x.ca ? x.c : hostCol + x.c);
    const rowCode = (x: Ref): string | null => {
      if (x.ra) return x.r >= 0 && x.r < R ? String(x.r) : null;
      return x.r === 0 ? "r" : `r${x.r > 0 ? "+" : ""}${x.r}`;
    };
    const rowExpr = (abs: boolean, d: number) => (abs ? String(d) : d === 0 ? "r" : `r${d > 0 ? "+" : ""}${d}`);

    type Out = { code: string; type: "num" | "str" | "bool" | "any" };

    const refRead = (x: Ref, want: "num" | "any"): string => {
      const col = colOf(x);
      if (col < 0 || col >= this.cols) { bad = true; return "$err(2)"; }
      const rc = rowCode(x);
      if (rc === null) return "$err(2)";
      cols.add(col);
      refs.push({ col, ra: x.ra, r: x.r });
      const check = x.ra || x.r === 0 ? "" : x.r < 0 ? `(i=${rc})<0?$err(2):` : `(i=${rc})>=${R}?$err(2):`;
      const idx = x.ra || x.r === 0 ? rc : "i";
      if (want === "num") return `(${check}(t${col}[${idx}]===1?v${col}[${idx}]:$n(${col},${idx})))`;
      return `(${check}$g(${col},${idx}))`;
    };

    // A range argument: registers the dependency and returns its bounds as code.
    type RangeArg = { g: AbsRange; lo: string; hi: string; abs: boolean; height: number };
    const rangeArg = (n: Node): RangeArg | null => {
      const rn = n.k === "range" ? n : n.k === "ref" ? { a: n.ref, b: n.ref } : null;
      if (!rn) return null;
      const c0 = colOf(rn.a), c1 = colOf(rn.b);
      const lo = Math.min(c0, c1), hi = Math.max(c0, c1);
      if (lo < 0 || hi >= this.cols) return null;
      const g: AbsRange = { c0: lo, c1: hi, ra0: rn.a.ra, r0: rn.a.r, ra1: rn.b.ra, r1: rn.b.ra ? Math.min(rn.b.r, MAX_ROW) : rn.b.r };
      if (g.ra1 && g.r1 >= R) g.r1 = R - 1;
      for (let c = lo; c <= hi; c++) cols.add(c);
      ranges.push(g);
      const abs = g.ra0 && g.ra1;
      return { g, lo: rowExpr(g.ra0, g.r0), hi: rowExpr(g.ra1, g.r1), abs, height: abs ? g.r1 - g.r0 + 1 : 0 };
    };

    const num = (n: Node): string => {
      if (n.k === "ref") return refRead(n.ref, "num");
      const o = go(n);
      return o.type === "num" ? o.code : o.type === "bool" ? `(+${o.code})` : `$N(${o.code})`;
    };
    const str = (n: Node): string => { const o = go(n); return o.type === "str" ? o.code : `$S(${o.code})`; };
    const bool = (n: Node): string => { const o = go(n); return o.type === "bool" ? o.code : `$B(${o.code})`; };
    const any = (n: Node): string => go(n).code;

    // Aggregate arguments: ranges skip text; literals and expressions are converted.
    // A tall absolute range reads its incremental cache instead of scanning.
    const aggArgs = (args: Node[]): string => {
      const parts: string[] = [];
      for (const a of args) {
        if (a.k === "range" || a.k === "ref") {
          const ra = rangeArg(a);
          if (!ra) { parts.push("$err(2)"); continue; }
          if (a.k === "ref") refs.push({ col: ra.g.c0, ra: ra.g.ra0, r: ra.g.r0 });
          if (a.k === "ref") ranges.pop();
          for (let c = ra.g.c0; c <= ra.g.c1; c++) {
            if (ra.abs && ra.height >= this.cacheMin) parts.push(`$rgc(${this.rangeCacheId(c, ra.g.r0, ra.g.r1)})`);
            else parts.push(`$rg(${c},${ra.lo},${ra.hi})`);
          }
        } else parts.push(`$nm(${num(a)})`);
      }
      return parts.join(",");
    };

    const go = (n: Node): Out => {
      switch (n.k) {
        case "num": return { code: String(n.v), type: "num" };
        case "str": return { code: JSON.stringify(n.v), type: "str" };
        case "bool": return { code: String(n.v), type: "bool" };
        case "err": return { code: `$err(${ERRORS.indexOf(n.v as never)})`, type: "any" };
        case "ref": return { code: refRead(n.ref, "any"), type: "any" };
        case "range": return { code: "$err(1)", type: "any" };
        case "un":
          if (n.op === "%") return { code: `(${num(n.a)}/100)`, type: "num" };
          return { code: n.op === "-" ? `(-${num(n.a)})` : num(n.a), type: "num" };
        case "bin": {
          const op = n.op;
          if (op === "+" || op === "-" || op === "*") return { code: `(${num(n.a)}${op}${num(n.b)})`, type: "num" };
          if (op === "/") return { code: `$div(${num(n.a)},${num(n.b)})`, type: "num" };
          if (op === "^") return { code: `Math.pow(${num(n.a)},${num(n.b)})`, type: "num" };
          if (op === "&") return { code: `(${str(n.a)}+${str(n.b)})`, type: "str" };
          const jsOp = op === "=" ? "===" : op === "<>" ? "!==" : op;
          const a = go(n.a), b = go(n.b);
          if (a.type === "num" && b.type === "num") return { code: `(${a.code}${jsOp}${b.code})`, type: "bool" };
          return { code: `($cmp(${a.code},${b.code})${jsOp}0)`, type: "bool" };
        }
        case "call": return call(n.name, n.args);
      }
    };

    const ARITY: Record<string, [number, number]> = {
      NOT: [1, 1], ABS: [1, 1], INT: [1, 1], SQRT: [1, 1], LEN: [1, 1], UPPER: [1, 1], LOWER: [1, 1], MOD: [2, 2], POWER: [2, 2],
      ROUND: [1, 2], IF: [2, 3], IFERROR: [2, 2], SUMIF: [2, 3], COUNTIF: [2, 2], SUMIFS: [3, 255], COUNTIFS: [2, 255],
      VLOOKUP: [3, 4], MATCH: [2, 3], INDEX: [2, 3], XLOOKUP: [3, 6], DATE: [3, 3], YEAR: [1, 1], MONTH: [1, 1], DAY: [1, 1],
    };
    const ERRV = { code: "$err(1)", type: "any" as const };
    const ERRREF = { code: "$err(2)", type: "any" as const };

    const call = (name: string, args: Node[]): Out => {
      const ar = ARITY[name];
      if (ar && (args.length < ar[0] || args.length > ar[1])) return ERRV;
      switch (name) {
        case "SUM": return { code: `($P(),${aggArgs(args)},$pop(0))`, type: "num" };
        case "COUNT": return { code: `($P(),${aggArgs(args)},$pop(1))`, type: "num" };
        case "AVERAGE": return { code: `($P(),${aggArgs(args)},$pop(2))`, type: "num" };
        case "MIN": return { code: `($P(),${aggArgs(args)},$pop(3))`, type: "num" };
        case "MAX": return { code: `($P(),${aggArgs(args)},$pop(4))`, type: "num" };
        case "COUNTA": return { code: `($P(),${aggArgs(args)},$pop(5))`, type: "num" };
        case "IF": {
          const t = go(args[1]);
          const f = args[2] ? go(args[2]) : { code: "false", type: "bool" as const };
          return { code: `(${bool(args[0])}?${t.code}:${f.code})`, type: t.type === f.type ? t.type : "any" };
        }
        case "IFERROR": return { code: `$try(()=>${any(args[0])},()=>${any(args[1])})`, type: "any" };
        case "AND": case "OR": return { code: `(${args.map(bool).join(name === "AND" ? "&&" : "||") || "true"})`, type: "bool" };
        case "NOT": return { code: `(!${bool(args[0])})`, type: "bool" };
        case "ABS": return { code: `Math.abs(${num(args[0])})`, type: "num" };
        case "INT": return { code: `Math.floor(${num(args[0])})`, type: "num" };
        case "SQRT": return { code: `Math.sqrt(${num(args[0])})`, type: "num" };
        case "MOD": return { code: `$mod(${num(args[0])},${num(args[1])})`, type: "num" };
        case "POWER": return { code: `Math.pow(${num(args[0])},${num(args[1])})`, type: "num" };
        case "ROUND": return { code: `$round(${num(args[0])},${args[1] ? num(args[1]) : "0"})`, type: "num" };
        case "LEN": return { code: `${str(args[0])}.length`, type: "num" };
        case "UPPER": return { code: `${str(args[0])}.toUpperCase()`, type: "str" };
        case "LOWER": return { code: `${str(args[0])}.toLowerCase()`, type: "str" };
        case "CONCAT": case "CONCATENATE": return { code: `(""+${args.map(str).join("+") || '""'})`, type: "str" };
        case "DATE": return { code: `$date(${num(args[0])},${num(args[1])},${num(args[2])})`, type: "num" };
        case "YEAR": case "MONTH": case "DAY": return { code: `$datePart(${num(args[0])},${name === "YEAR" ? 0 : name === "MONTH" ? 1 : 2})`, type: "num" };
        case "SUMIF": case "COUNTIF": {
          const g1 = rangeArg(args[0]);
          if (!g1 || g1.g.c0 !== g1.g.c1) return ERRV;
          const crit = any(args[1]);
          let sc = g1.g.c0, sOff = 0;
          if (name === "SUMIF" && args[2]) {
            // Excel reads sum_range from its top-left cell, with the size of the criteria range.
            const top = args[2].k === "range" ? args[2].a : args[2].k === "ref" ? args[2].ref : null;
            if (!top || top.ra !== g1.g.ra0) return ERRV;
            sc = colOf(top);
            if (sc < 0 || sc >= this.cols) return ERRREF;
            sOff = top.r - g1.g.r0;
            cols.add(sc);
            ranges.push({ c0: sc, c1: sc, ra0: g1.g.ra0, r0: g1.g.r0 + sOff, ra1: g1.g.ra1, r1: g1.g.ra1 ? Math.min(g1.g.r1 + sOff, R - 1) : g1.g.r1 + sOff });
          }
          const count = name === "COUNTIF" ? 1 : 0;
          if (g1.abs && g1.height >= this.cacheMin && g1.g.r1 + sOff < R && g1.g.r0 + sOff >= 0) {
            const gid = this.groupId(g1.g.c0, g1.g.r0, g1.g.r1, sc, sOff);
            return { code: `$sumifx(${gid},${g1.g.c0},${g1.lo},${g1.hi},${crit},${sc},${sOff},${count})`, type: "num" };
          }
          return { code: `$sumif(${g1.g.c0},${g1.lo},${g1.hi},${crit},${sc},${sOff},${count})`, type: "num" };
        }
        case "SUMIFS": case "COUNTIFS": {
          // SUMIFS(sum_range, range1, crit1, ...). COUNTIFS(range1, crit1, ...). Every range is one column, same height.
          const first = name === "SUMIFS" ? 1 : 0;
          if ((args.length - first) % 2 !== 0) return ERRV;
          let sumPart = "-1,0";
          if (first) {
            const s = rangeArg(args[0]);
            if (!s || s.g.c0 !== s.g.c1) return ERRV;
            sumPart = `${s.g.c0},${s.lo}`;
          }
          const pairs: string[] = [];
          let height = "";
          for (let i = first; i < args.length; i += 2) {
            const g = rangeArg(args[i]);
            if (!g || g.g.c0 !== g.g.c1) return ERRV;
            if (!height) height = `${g.hi}-(${g.lo})+1`;
            pairs.push(`${g.g.c0},${g.lo},${any(args[i + 1])}`);
          }
          return { code: `$sumifs(${sumPart},${height},[${pairs.join(",")}])`, type: "num" };
        }
        case "MATCH": {
          const g = rangeArg(args[1]);
          if (!g || g.g.c0 !== g.g.c1) return ERRV; // vertical ranges only
          const mode = args[2] ? num(args[2]) : "1"; // Excel default: 1, approximate, ascending
          return { code: `$match(${any(args[0])},${g.g.c0},${g.lo},${g.hi},${mode},${g.abs && g.height >= this.cacheMin ? 1 : 0})`, type: "num" };
        }
        case "VLOOKUP": {
          const g = rangeArg(args[1]);
          if (!g) return ERRV;
          const approx = args[3] ? bool(args[3]) : "true"; // Excel default: TRUE, approximate
          return { code: `$vlookup(${any(args[0])},${g.g.c0},${g.g.c1},${g.lo},${g.hi},${num(args[2])},${approx},${g.abs && g.height >= this.cacheMin ? 1 : 0})`, type: "any" };
        }
        case "XLOOKUP": {
          const l = rangeArg(args[1]), rr = rangeArg(args[2]);
          if (!l || !rr || l.g.c0 !== l.g.c1 || rr.g.c0 !== rr.g.c1) return ERRV;
          const nf = args[3] ? `()=>${any(args[3])}` : "null";
          const mm = args[4] ? num(args[4]) : "0"; // Excel default: 0, exact
          const sm = args[5] ? num(args[5]) : "1";
          return { code: `$xlookup(${any(args[0])},${l.g.c0},${l.lo},${l.hi},${rr.g.c0},${rr.lo},${rr.hi},${nf},${mm},${sm},${l.abs && l.height >= this.cacheMin ? 1 : 0})`, type: "any" };
        }
        case "INDEX": {
          const g = rangeArg(args[0]);
          if (!g) return ERRV;
          return { code: `$index(${g.g.c0},${g.g.c1},${g.lo},${g.hi},${num(args[1])},${args[2] ? num(args[2]) : "1"})`, type: "any" };
        }
        default: return { code: "$err(3)", type: "any" };
      }
    };

    const body = go(ast);
    let src = "";
    for (const col of cols) { this.col(col); src += `const v${col}=V[${col}],t${col}=T[${col}];`; }
    src += `return function(r){let i;return ${bad ? "$err(2)" : body.code};};`;
    return new Function("V", "T", ...HELPER_NAMES, src)(this.V, this.T, ...this.helpers());
  }

  // ---------- runtime helpers used by compiled code ----------

  private _helpers: unknown[] | null = null;
  private helpers(): unknown[] {
    if (this._helpers) return this._helpers;
    const self = this;
    const R = this.rows;
    const V = this.V, T = this.T;
    const strs = this.strs;
    const err = (code: number): never => { throw ERR_OBJ[code]; };
    const n = (c: number, i: number): number => {
      const t = T[c]![i];
      if (t === NUM || t === BOOL) return V[c]![i];
      if (t === EMPTY) return 0;
      if (t === ERR) throw ERR_OBJ[V[c]![i]];
      const s = strs[V[c]![i]];
      const x = Number(s);
      if (s.trim() === "" || !Number.isFinite(x)) throw ERR_OBJ[E_VALUE];
      return x;
    };
    const g = (c: number, i: number): Value => {
      const t = T[c]![i];
      if (t === NUM) return V[c]![i];
      if (t === STR) return strs[V[c]![i]];
      if (t === BOOL) return V[c]![i] !== 0;
      if (t === ERR) throw ERR_OBJ[V[c]![i]];
      return null;
    };
    const N = (x: Value): number => {
      if (typeof x === "number") return x;
      if (x === null) return 0;
      if (typeof x === "boolean") return x ? 1 : 0;
      if (x instanceof CellError) throw x;
      const y = Number(x);
      if (x.trim() === "" || !Number.isFinite(y)) throw ERR_OBJ[E_VALUE];
      return y;
    };
    const S = (x: Value): string => {
      if (typeof x === "string") return x;
      if (x === null) return "";
      if (typeof x === "boolean") return x ? "TRUE" : "FALSE";
      if (typeof x === "number") return String(+x.toPrecision(15));
      throw x;
    };
    const B = (x: Value): boolean => {
      if (typeof x === "boolean") return x;
      if (typeof x === "number") return x !== 0;
      if (x === null) return false;
      if (typeof x === "string") { const u = x.toUpperCase(); if (u === "TRUE") return true; if (u === "FALSE") return false; }
      throw ERR_OBJ[E_VALUE];
    };
    const rank = (x: Value) => (typeof x === "number" ? 0 : typeof x === "string" ? 1 : 2);
    const cmp = (a: Value, b: Value): number => {
      if (a === null) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
      if (b === null) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (typeof a === "string") { const x = a.toLowerCase(), y = (b as string).toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
      return a < b! ? -1 : a > b! ? 1 : 0;
    };
    const div = (a: number, b: number) => (b === 0 ? err(E_DIV0) : a / b);
    const mod = (a: number, b: number) => (b === 0 ? err(E_DIV0) : a - b * Math.floor(a / b));
    const round = (x: number, d: number) => { const m = Math.pow(10, Math.trunc(d)); return (Math.sign(x) * Math.round(Math.abs(x) * m + 1e-9)) / m; };
    const tryFn = (a: () => Value, b: () => Value): Value => {
      const depth = self.ad;
      try { return a(); } catch (e) { if (e instanceof CellError) { self.ad = depth; return b(); } throw e; }
    };
    const P = () => {
      const d = ++self.ad;
      self.aSum[d] = 0; self.aCnt[d] = 0; self.aCntA[d] = 0; self.aMin[d] = Infinity; self.aMax[d] = -Infinity;
    };
    const pop = (kind: number): number => {
      const d = self.ad--;
      switch (kind) {
        case 0: return self.aSum[d];
        case 1: return self.aCnt[d];
        case 2: return self.aCnt[d] === 0 ? err(E_DIV0) : self.aSum[d] / self.aCnt[d];
        case 3: return self.aCnt[d] === 0 ? 0 : self.aMin[d];
        case 4: return self.aCnt[d] === 0 ? 0 : self.aMax[d];
        default: return self.aCntA[d];
      }
    };
    const nm = (x: number) => {
      const d = self.ad;
      self.aSum[d] += x; self.aCnt[d]++; self.aCntA[d]++;
      if (x < self.aMin[d]) self.aMin[d] = x;
      if (x > self.aMax[d]) self.aMax[d] = x;
    };
    const rg = (c: number, lo: number, hi: number) => {
      if (lo < 0) err(E_REF);
      if (hi >= R) hi = R - 1;
      const t = T[c]!, v = V[c]!;
      const d = self.ad;
      let s = 0, cnt = 0, cntA = 0, mn = self.aMin[d], mx = self.aMax[d];
      for (let i = lo; i <= hi; i++) {
        const tg = t[i];
        if (tg === NUM) { const x = v[i]; s += x; cnt++; if (x < mn) mn = x; if (x > mx) mx = x; }
        else if (tg === ERR) throw ERR_OBJ[v[i]];
        if (tg !== EMPTY) cntA++;
      }
      self.aSum[d] += s; self.aCnt[d] += cnt; self.aCntA[d] += cntA; self.aMin[d] = mn; self.aMax[d] = mx;
    };
    // A cached range: O(1) unless the cache needs a rescan.
    const rgc = (id: number) => {
      const rc = self.rangeCaches[id];
      rc.refresh();
      if (rc.errs > 0) throw ERR_OBJ[rc.firstError()];
      const d = self.ad;
      self.aSum[d] += rc.sum; self.aCnt[d] += rc.cnt; self.aCntA[d] += rc.cntA;
      if (rc.min < self.aMin[d]) self.aMin[d] = rc.min;
      if (rc.max > self.aMax[d]) self.aMax[d] = rc.max;
    };

    // Criteria, shared by SUMIF, COUNTIF, SUMIFS and COUNTIFS.
    type Crit = { op: string; rhs: number | string | boolean };
    const parseCrit = (crit: Value): Crit => {
      if (typeof crit === "string") {
        const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(crit)!;
        const num = Number(m[2]);
        return { op: m[1] ?? "=", rhs: m[2] !== "" && Number.isFinite(num) ? num : m[2] };
      }
      if (typeof crit === "boolean") return { op: "=", rhs: crit };
      if (crit === null) return { op: "=", rhs: 0 };
      if (crit instanceof CellError) throw crit;
      return { op: "=", rhs: crit };
    };
    const predicate = (cr: Crit): ((t: number, v: number) => boolean) => {
      const { op, rhs } = cr;
      if (typeof rhs === "number") {
        const x = rhs;
        switch (op) {
          case "=": return (t, v) => t === NUM && v === x;
          case "<>": return (t, v) => t !== NUM || v !== x;
          case "<": return (t, v) => t === NUM && v < x;
          case ">": return (t, v) => t === NUM && v > x;
          case "<=": return (t, v) => t === NUM && v <= x;
          default: return (t, v) => t === NUM && v >= x;
        }
      }
      if (typeof rhs === "string") {
        const lower = rhs.toLowerCase();
        const target = self.strIds.get(lower);
        const fold = self.fold;
        if (op === "=") return (t, v) => t === STR && target !== undefined && fold[v] === target;
        if (op === "<>") return (t, v) => !(t === STR && target !== undefined && fold[v] === target);
        return (t, v) => {
          if (t !== STR) return false;
          const s = strs[v].toLowerCase();
          return op === "<" ? s < lower : op === ">" ? s > lower : op === "<=" ? s <= lower : s >= lower;
        };
      }
      const want = rhs ? 1 : 0;
      return (t, v) => t === BOOL && v === want;
    };

    // SUMIF / COUNTIF by scan.
    const sumif = (c: number, lo: number, hi: number, crit: Value, sc: number, sOff: number, countOnly: number): number => {
      if (lo < 0 || lo + sOff < 0) err(E_REF);
      if (hi >= R) hi = R - 1;
      if (hi + sOff >= R) hi = R - 1 - sOff;
      const t = T[c]!, v = V[c]!, st = T[sc]!, sv = V[sc]!;
      const pred = predicate(parseCrit(crit));
      let total = 0;
      for (let i = lo; i <= hi; i++) {
        if (!pred(t[i], v[i])) continue;
        if (countOnly) total++;
        else if (st[i + sOff] === NUM) total += sv[i + sOff];
      }
      return total;
    };
    // SUMIF / COUNTIF through the group index when the criterion is = or <>. Other operators scan.
    const sumifx = (gid: number, c: number, lo: number, hi: number, crit: Value, sc: number, sOff: number, countOnly: number): number => {
      const cr = parseCrit(crit);
      if (cr.op !== "=" && cr.op !== "<>") return sumif(c, lo, hi, crit, sc, sOff, countOnly);
      let tag = -1, val = 0;
      if (typeof cr.rhs === "number") { tag = NUM; val = cr.rhs; }
      else if (typeof cr.rhs === "boolean") { tag = BOOL; val = cr.rhs ? 1 : 0; }
      else { const id = self.strIds.get(cr.rhs.toLowerCase()); if (id !== undefined) { tag = STR; val = id; } }
      return self.groups[gid].query(cr.op, tag, val, countOnly === 1);
    };
    const sumifs = (sc: number, sLo: number, height: number, pairs: (number | Value)[]): number => {
      const crits: { t: Uint8Array; v: Float64Array; lo: number; pred: (t: number, v: number) => boolean }[] = [];
      for (let i = 0; i < pairs.length; i += 3) {
        const c = pairs[i] as number, lo = pairs[i + 1] as number;
        if (lo < 0) err(E_REF);
        crits.push({ t: T[c]!, v: V[c]!, lo, pred: predicate(parseCrit(pairs[i + 2] as Value)) });
      }
      let h = height;
      for (const k of crits) if (k.lo + h > R) h = R - k.lo;
      if (sc >= 0 && sLo + h > R) h = R - sLo;
      const st = sc >= 0 ? T[sc]! : null, sv = sc >= 0 ? V[sc]! : null;
      let total = 0;
      outer: for (let j = 0; j < h; j++) {
        for (const k of crits) if (!k.pred(k.t[k.lo + j], k.v[k.lo + j])) continue outer;
        if (!st) total++;
        else if (st[sLo + j] === NUM) total += sv![sLo + j];
      }
      return total;
    };

    // Lookups.
    const keyOf = (x: Value): [number, number] => {
      if (typeof x === "number") return [NUM, x];
      if (typeof x === "boolean") return [BOOL, x ? 1 : 0];
      if (typeof x === "string") { const id = self.strIds.get(x.toLowerCase()); return id === undefined ? [-1, 0] : [STR, id]; }
      if (x instanceof CellError) throw x;
      return [-1, 0];
    };
    const cellCmp = (t: Uint8Array, v: Float64Array, i: number, x: Value): number => {
      const tg = t[i];
      const y: Value = tg === NUM ? v[i] : tg === STR ? strs[v[i]] : tg === BOOL ? v[i] !== 0 : null;
      return cmp(y, x);
    };
    // Returns the row (absolute) or -1.
    const findRow = (x: Value, c: number, lo: number, hi: number, mode: number, cacheable: number): number => {
      if (lo < 0) err(E_REF);
      if (hi >= R) hi = R - 1;
      const t = T[c]!, v = V[c]!;
      if (mode === 0) {
        const [tag, val] = keyOf(x);
        if (tag === -1) return -1;
        if (cacheable) {
          const key = `${c}:${lo}:${hi}`;
          let li = self.lookups.get(key);
          if (!li) { li = new LookupIndex(c, lo, hi); self.lookups.set(key, li); }
          li.ensure(self.colVersion[c], t, v, self.fold);
          return li.find(tag, val, self.fold);
        }
        for (let i = lo; i <= hi; i++) {
          if (t[i] !== tag) continue;
          if (tag === STR ? self.fold[v[i]] === self.fold[val] : v[i] === val) return i;
        }
        return -1;
      }
      // Approximate: binary search on sorted data. 1 = largest value <= x (ascending), -1 = smallest >= x (descending).
      let a = lo, b = hi, found = -1;
      while (a <= b) {
        const m = (a + b) >> 1;
        const d = cellCmp(t, v, m, x);
        if (mode > 0 ? d <= 0 : d >= 0) { found = m; a = m + 1; } else b = m - 1;
      }
      return found;
    };
    const match = (x: Value, c: number, lo: number, hi: number, mode: number, cacheable: number): number => {
      const m = mode > 0 ? 1 : mode < 0 ? -1 : 0;
      const row = findRow(x, c, lo, hi, m, cacheable);
      if (row < 0) err(E_NA);
      return row - lo + 1;
    };
    const vlookup = (x: Value, c0: number, c1: number, lo: number, hi: number, ci: number, approx: boolean, cacheable: number): Value => {
      ci = Math.trunc(ci);
      if (ci < 1) err(E_VALUE);
      if (c0 + ci - 1 > c1) err(E_REF);
      const row = findRow(x, c0, lo, hi, approx ? 1 : 0, cacheable);
      if (row < 0) err(E_NA);
      return g(c0 + ci - 1, row);
    };
    const xlookup = (x: Value, lc: number, llo: number, lhi: number, rc: number, rlo: number, rhi: number, nf: (() => Value) | null, mm: number, sm: number, cacheable: number): Value => {
      if (mm !== 0 || sm !== 1) err(E_VALUE); // only exact match, first-to-last search
      if (lhi - llo !== rhi - rlo) err(E_VALUE);
      const row = findRow(x, lc, llo, lhi, 0, cacheable);
      if (row < 0) return nf ? nf() : err(E_NA);
      return g(rc, rlo + (row - llo));
    };
    const index = (c0: number, c1: number, lo: number, hi: number, r: number, c: number): Value => {
      r = Math.trunc(r); c = Math.trunc(c);
      if (r < 1 || c < 1) err(E_VALUE);
      if (hi >= R) hi = R - 1;
      if (lo + r - 1 > hi || c0 + c - 1 > c1) err(E_REF);
      return g(c0 + c - 1, lo + r - 1);
    };

    // Dates: Excel serial numbers, day 0 = 1899-12-30.
    const date = (y: number, m: number, d: number): number => {
      y = Math.trunc(y);
      if (y >= 0 && y < 1900) y += 1900;
      if (y < 1900 || y > 9999) err(E_NUM);
      return (Date.UTC(y, Math.trunc(m) - 1, Math.trunc(d)) - DAY0) / 864e5;
    };
    const datePart = (s: number, part: number): number => {
      if (s < 0) err(E_NUM);
      const dt = new Date(DAY0 + Math.floor(s) * 864e5);
      return part === 0 ? dt.getUTCFullYear() : part === 1 ? dt.getUTCMonth() + 1 : dt.getUTCDate();
    };

    this._helpers = [err, n, g, N, S, B, cmp, div, mod, round, tryFn, P, pop, nm, rg, rgc, sumif, sumifx, sumifs, match, vlookup, xlookup, index, date, datePart];
    return this._helpers;
  }
}

const HELPER_NAMES = ["$err", "$n", "$g", "$N", "$S", "$B", "$cmp", "$div", "$mod", "$round", "$try", "$P", "$pop", "$nm", "$rg", "$rgc", "$sumif", "$sumifx", "$sumifs", "$match", "$vlookup", "$xlookup", "$index", "$date", "$datePart"];

export { ParseError, cellName };
