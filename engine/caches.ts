// Incremental structures that watch cell writes.
//
// RangeCache: SUM / COUNT / COUNTA / AVERAGE / MIN / MAX over one column of an absolute range.
//   A write applies a delta in O(1). MIN and MAX rescan only when the current extreme leaves.
// GroupIndex: SUMIF / COUNTIF with an equality criterion. One bucket per key (a GROUP BY index).
//   A write moves one row between buckets in O(1).
//
// Both use Neumaier compensated sums, so a total built from deltas matches a fresh scan to about
// one ulp. Both stop applying deltas after a budget (an eighth of the range) and rebuild on the next
// read, so a mass update (every row changes) costs one scan, not a slow delta per row.

export const EMPTY = 0, NUM = 1, STR = 2, BOOL = 3, ERR = 4;

export interface Watcher {
  onWrite(c: number, r: number, ot: number, ov: number, nt: number, nv: number): void;
}

// Neumaier addition. Returns nothing; updates s[i] and comp[i].
function nAdd(s: Float64Array | number[], comp: Float64Array | number[], i: number, x: number) {
  const a = s[i], t = a + x;
  if (Math.abs(a) >= Math.abs(x)) comp[i] += (a - t) + x;
  else comp[i] += (x - t) + a;
  s[i] = t;
}

export class RangeCache implements Watcher {
  valid = false;
  // [0] is the sum. Arrays so nAdd can work in place.
  private s = new Float64Array(1);
  private comp = new Float64Array(1);
  cnt = 0;
  cntA = 0;
  errs = 0;
  min = Infinity;
  max = -Infinity;
  minOk = false;
  maxOk = false;
  private deltas = 0;
  private readonly budget: number;
  scans = 0; // full scans so far (for tests and the report)

  constructor(readonly c: number, readonly lo: number, readonly hi: number, private t: Uint8Array, private v: Float64Array) {
    this.budget = Math.max(1024, (hi - lo + 1) >> 3);
  }

  get sum() { return this.s[0] + this.comp[0]; }

  onWrite(_c: number, r: number, ot: number, ov: number, nt: number, nv: number) {
    if (!this.valid || r < this.lo || r > this.hi) return;
    if (++this.deltas > this.budget) { this.valid = false; return; }
    // Remove the old value.
    if (ot === NUM) {
      nAdd(this.s, this.comp, 0, -ov);
      this.cnt--;
      if (this.cnt === 0) { this.min = Infinity; this.max = -Infinity; this.minOk = this.maxOk = true; }
      else {
        if (ov === this.min) this.minOk = false;
        if (ov === this.max) this.maxOk = false;
      }
    } else if (ot === ERR) this.errs--;
    if (ot !== EMPTY) this.cntA--;
    // Add the new value.
    if (nt === NUM) {
      nAdd(this.s, this.comp, 0, nv);
      this.cnt++;
      if (this.minOk && nv < this.min) this.min = nv;
      if (this.maxOk && nv > this.max) this.max = nv;
    } else if (nt === ERR) this.errs++;
    if (nt !== EMPTY) this.cntA++;
  }

  // Makes the cache exact. Cheap unless a rescan is due.
  refresh() {
    if (!this.valid) {
      this.scans++;
      const t = this.t, v = this.v;
      let sum = 0, comp = 0;
      let cnt = 0, cntA = 0, errs = 0, mn = Infinity, mx = -Infinity;
      for (let i = this.lo; i <= this.hi; i++) {
        const tg = t[i];
        if (tg === NUM) {
          const x = v[i];
          // Neumaier step, inlined: this loop is the full rescan.
          const u = sum + x;
          if (Math.abs(sum) >= Math.abs(x)) comp += (sum - u) + x; else comp += (x - u) + sum;
          sum = u;
          cnt++;
          if (x < mn) mn = x;
          if (x > mx) mx = x;
        } else if (tg === ERR) errs++;
        if (tg !== EMPTY) cntA++;
      }
      this.s[0] = sum; this.comp[0] = comp;
      this.cnt = cnt; this.cntA = cntA; this.errs = errs; this.min = mn; this.max = mx;
      this.minOk = this.maxOk = true;
      this.valid = true;
      this.deltas = 0;
      return;
    }
    if (!this.minOk || !this.maxOk) {
      const t = this.t, v = this.v;
      let mn = Infinity, mx = -Infinity;
      for (let i = this.lo; i <= this.hi; i++) if (t[i] === NUM) { const x = v[i]; if (x < mn) mn = x; if (x > mx) mx = x; }
      this.min = mn; this.max = mx; this.minOk = this.maxOk = true;
    }
  }

  // The first error in the range, in row order (Excel returns the first one).
  firstError(): number {
    for (let i = this.lo; i <= this.hi; i++) if (this.t[i] === ERR) return this.v[i];
    return -1;
  }
}

// Equality SUMIF / COUNTIF. Keys: text by case-folded pool id, numbers by value, booleans.
// Empty and error cells have no bucket: no equality criterion matches them.
export class GroupIndex implements Watcher {
  built = false;
  private sum: number[] = [];
  private comp: number[] = [];
  private cnt: number[] = [];
  private strSlot = new Int32Array(64); // fold id -> slot + 1
  private numSlot = new Map<number, number>();
  private boolSlot = [-1, -1];
  private tot = new Float64Array(1);
  private totComp = new Float64Array(1);
  private deltas = 0;
  private readonly budget: number;
  builds = 0;

  constructor(
    readonly keyCol: number, readonly lo: number, readonly hi: number, readonly sumCol: number, readonly sOff: number,
    private T: (Uint8Array | undefined)[], private V: (Float64Array | undefined)[], private fold: number[],
  ) {
    this.budget = Math.max(1024, (hi - lo + 1) >> 3);
  }

  private slot(tag: number, val: number, create: boolean): number {
    if (tag === STR) {
      const f = this.fold[val];
      if (f >= this.strSlot.length) {
        if (!create) return -1;
        const n = new Int32Array(Math.max(f + 1, this.strSlot.length * 2)); n.set(this.strSlot); this.strSlot = n;
      }
      const s = this.strSlot[f] - 1;
      if (s >= 0 || !create) return s;
      return (this.strSlot[f] = this.newSlot() + 1) - 1;
    }
    if (tag === NUM) {
      const s = this.numSlot.get(val);
      if (s !== undefined || !create) return s ?? -1;
      const n = this.newSlot();
      this.numSlot.set(val, n);
      return n;
    }
    if (tag === BOOL) {
      const s = this.boolSlot[val];
      if (s >= 0 || !create) return s;
      return (this.boolSlot[val] = this.newSlot());
    }
    return -1;
  }

  private newSlot() { this.sum.push(0); this.comp.push(0); this.cnt.push(0); return this.sum.length - 1; }

  private build() {
    this.builds++;
    this.sum = []; this.comp = []; this.cnt = [];
    this.strSlot.fill(0); this.numSlot.clear(); this.boolSlot = [-1, -1];
    this.tot[0] = 0; this.totComp[0] = 0;
    const kt = this.T[this.keyCol]!, kv = this.V[this.keyCol]!, st = this.T[this.sumCol]!, sv = this.V[this.sumCol]!;
    const off = this.sOff;
    for (let r = this.lo; r <= this.hi; r++) {
      const s = this.slot(kt[r], kv[r], true);
      const j = r + off;
      const isNum = st[j] === NUM;
      if (s >= 0) { this.cnt[s]++; if (isNum) nAdd(this.sum, this.comp, s, sv[j]); }
      if (isNum) nAdd(this.tot, this.totComp, 0, sv[j]);
    }
    this.built = true;
    this.deltas = 0;
  }

  onWrite(c: number, r: number, ot: number, ov: number, nt: number, nv: number) {
    if (!this.built) return;
    const same = this.keyCol === this.sumCol && this.sOff === 0;
    if (c === this.keyCol && r >= this.lo && r <= this.hi) {
      if (++this.deltas > this.budget) { this.built = false; return; }
      let oT: number, oV: number, nT: number, nV: number;
      if (same) { oT = ot; oV = ov; nT = nt; nV = nv; }
      else { const j = r + this.sOff; oT = nT = this.T[this.sumCol]![j]; oV = nV = this.V[this.sumCol]![j]; }
      const so = this.slot(ot, ov, false), sn = this.slot(nt, nv, true);
      if (so >= 0) { this.cnt[so]--; if (oT === NUM) nAdd(this.sum, this.comp, so, -oV); }
      if (sn >= 0) { this.cnt[sn]++; if (nT === NUM) nAdd(this.sum, this.comp, sn, nV); }
      if (same) {
        if (oT === NUM) nAdd(this.tot, this.totComp, 0, -oV);
        if (nT === NUM) nAdd(this.tot, this.totComp, 0, nV);
      }
    }
    if (c === this.sumCol && !same) {
      const kr = r - this.sOff;
      if (kr < this.lo || kr > this.hi) return;
      if (++this.deltas > this.budget) { this.built = false; return; }
      const s = this.slot(this.T[this.keyCol]![kr], this.V[this.keyCol]![kr], false);
      if (ot === NUM) { nAdd(this.tot, this.totComp, 0, -ov); if (s >= 0) nAdd(this.sum, this.comp, s, -ov); }
      if (nt === NUM) { nAdd(this.tot, this.totComp, 0, nv); if (s >= 0) nAdd(this.sum, this.comp, s, nv); }
    }
  }

  // op is "=" or "<>". key is (tag, value) as stored in a cell; for text, value is any pool id with that fold.
  query(op: string, keyTag: number, keyVal: number, countOnly: boolean): number {
    if (!this.built) this.build();
    const s = keyTag === -1 ? -1 : this.slot(keyTag, keyVal, false);
    const eqCnt = s >= 0 ? this.cnt[s] : 0;
    const eqSum = s >= 0 ? this.sum[s] + this.comp[s] : 0;
    if (op === "=") return countOnly ? eqCnt : eqSum;
    return countOnly ? (this.hi - this.lo + 1) - eqCnt : (this.tot[0] + this.totComp[0]) - eqSum;
  }
}

// Exact-match lookup index: key -> first row. Rebuilt lazily when the column version changes.
export class LookupIndex {
  private num = new Map<number, number>();
  private str = new Map<number, number>(); // fold id -> row
  private bool = [-1, -1];
  version = -1;
  builds = 0;

  constructor(readonly c: number, readonly lo: number, readonly hi: number) {}

  ensure(version: number, t: Uint8Array, v: Float64Array, fold: number[]) {
    if (this.version === version) return;
    this.builds++;
    this.num.clear(); this.str.clear(); this.bool = [-1, -1];
    for (let i = this.hi; i >= this.lo; i--) {
      // Walk upward so the first (lowest) row wins.
      const tg = t[i];
      if (tg === NUM) this.num.set(v[i], i);
      else if (tg === STR) this.str.set(fold[v[i]], i);
      else if (tg === BOOL) this.bool[v[i]] = i;
    }
    this.version = version;
  }

  find(tag: number, val: number, fold: number[]): number {
    if (tag === NUM) return this.num.get(val) ?? -1;
    if (tag === STR) return this.str.get(fold[val]) ?? -1;
    if (tag === BOOL) return this.bool[val];
    return -1;
  }
}
