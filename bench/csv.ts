// CSV import benchmark. Run with: bun bench/csv.ts [rows]
// Writes a realistic file (quoted names with commas, dates, amounts, leading-zero codes) to the
// temp folder, then times the parser and the sheet build.
import { parseCsvFile } from "../engine/csv";
import { Sheet } from "../engine/sheet";
import { tmpdir } from "os";
import { join } from "path";

const rows = Number(process.argv[2] ?? 1_000_000);
const path = join(tmpdir(), `million-bench-${rows}.csv`);
const first = ["Ana", "Ben", "Chloé", "Dev", "Eli", "Fatima", "Goro", "Hana"];
const last = ["Smith", "O'Neil", "García", "Ng", "Kowalski", "Okafor"];
let seed = 3;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const parts: string[] = ["order_id,date,customer,region,units,price,code,paid\n"];
for (let i = 0; i < rows; i++) {
  const d = new Date(Date.UTC(2025, 0, 1) + Math.floor(rnd() * 365) * 864e5).toISOString().slice(0, 10);
  const name = `"${last[(rnd() * 6) | 0]}, ${first[(rnd() * 8) | 0]}"`;
  parts.push(`${500000 + i},${d},${name},${["North", "South", "East", "West"][(rnd() * 4) | 0]},${1 + ((rnd() * 20) | 0)},${(5 + rnd() * 495).toFixed(2)},0${(rnd() * 9000 + 1000) | 0},${rnd() < 0.8 ? "TRUE" : "FALSE"}\n`);
}
await Bun.write(path, parts.join(""));
const file = Bun.file(path);
console.log(`file ${(file.size / 1048576).toFixed(1)} MB, ${rows.toLocaleString()} rows`);

const t0 = performance.now();
const p = await parseCsvFile(file);
const t1 = performance.now();
const sheet = new Sheet(p.rows + 200, p.cols + 6);
const map = sheet.internAll(p.strings);
for (let c = 0; c < p.cols; c++) { const col = p.column(c); sheet.loadColumn(c, col.t, col.v, map); }
const t2 = performance.now();
console.log(`parse ${(t1 - t0).toFixed(0)} ms (${((file.size / 1048576) / ((t1 - t0) / 1000)).toFixed(0)} MB/s)   build ${(t2 - t1).toFixed(0)} ms   rows ${p.rows.toLocaleString()} cols ${p.cols} strings ${p.strings.length.toLocaleString()} header ${p.hasHeader}`);
console.log(`row 2: ${[0, 1, 2, 3, 4, 5, 6, 7].map((c) => sheet.display(c, 1)).join(" | ")}`);
const t3 = performance.now();
sheet.setInput(9, 0, "=SUM(F:F)");
sheet.setInput(9, 1, '=SUMIF(D:D,"North",F:F)');
console.log(`=SUM(F:F) ${sheet.display(9, 0)}   =SUMIF(D:D,"North",F:F) ${sheet.display(9, 1)}   (${(performance.now() - t3).toFixed(1)} ms)`);
const t4 = performance.now();
sheet.setInput(5, 1, "999");
console.log(`edit F2 then: SUM ${sheet.display(9, 0)} in ${((performance.now() - t4) * 1000).toFixed(0)} µs`);
