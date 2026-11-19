// Engine benchmark. Run with: bun bench/engine.ts [orders]
import { buildLedger } from "../engine/demo";

const orders = Number(process.argv[2] ?? 1_000_000);
const median = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1];
const time = <T,>(f: () => T): [T, number] => { const t = performance.now(); const x = f(); return [x, performance.now() - t]; };

const heap0 = process.memoryUsage().rss;
const [s, buildMs] = time(() => buildLedger(orders));
const [full] = time(() => s.recalcAll());
const info = s.stats();
console.log(`orders ${orders.toLocaleString()}  cells ${info.cells.toLocaleString()}  formulas ${info.formulas.toLocaleString()}  templates ${info.templates}`);
console.log(`build+compile ${buildMs.toFixed(0)} ms   full recalc ${full.ms.toFixed(0)} ms (${full.recomputed.toLocaleString()} cells)`);
console.log(`typed arrays ${info.typedArrayMB.toFixed(0)} MB   rss ${((process.memoryUsage().rss - heap0) / 1048576).toFixed(0)} MB`);

console.log(`before edits: K4 = ${s.getValue(10, 3)}  K5 North = ${s.getValue(10, 4)}  H last = ${s.getValue(7, orders)}`);
// Each case: 7 rounds; a round times `batch` edits and divides, so sub-millisecond edits are measurable.
const runs = (label: string, batch: number, f: (i: number) => { recomputed: number; ms: number }) => {
  const ms: number[] = [];
  let n = 0;
  for (let round = 0; round < 7; round++) {
    const t = performance.now();
    for (let i = 0; i < batch; i++) n = f(round * batch + i).recomputed;
    ms.push((performance.now() - t) / batch);
  }
  console.log(`${label.padEnd(44)} ${median(ms).toFixed(3).padStart(9)} ms  ${n.toLocaleString().padStart(10)} recomputed`);
};
const mid = orders >> 1;
runs("edit Units in the last row (C last)", 50, (i) => s.setInput(2, orders, String(3 + (i % 9))));
runs("edit Region in the middle (SUMIF only)", 50, (i) => s.setInput(1, mid, ["North", "South", "East", "West"][i % 4]));
runs("edit Units in the middle (half the chain)", 1, (i) => s.setInput(2, mid, String(3 + (i % 9))));
runs("edit Units in row 1 (the whole chain)", 1, (i) => s.setInput(2, 1, String(3 + (i % 9))));
runs("edit the tax rate K2 (every formula)", 1, (i) => s.setInput(10, 1, String(0.05 + (i % 9) / 100)));
console.log(`check cell K13 = ${s.display(10, 12)}  grand total K4 = ${s.display(10, 3)}`);
