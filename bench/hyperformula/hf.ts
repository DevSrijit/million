// Same ledger in HyperFormula. Run with: bun bench/hyperformula/hf.ts [orders]
import { HyperFormula } from "hyperformula";

const orders = Number(process.argv[2] ?? 100_000);
const REGIONS = ["North", "South", "East", "West"];
const median = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1];
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const t0 = performance.now();
const data: (string | number | null)[][] = [["Order", "Region", "Units", "Price", "Revenue", "Tax", "Total", "Running total", null, "Summary", null]];
for (let r = 1; r <= orders; r++) {
  const n = r + 1; // A1 row number
  data.push([100000 + r, REGIONS[(rnd() * 4) | 0], 1 + ((rnd() * 20) | 0), Math.round((5 + rnd() * 495) * 100) / 100,
    `=C${n}*D${n}`, `=E${n}*$K$2`, `=E${n}+F${n}`, r === 1 ? `=G${n}` : `=H${n - 1}+G${n}`]);
}
const put = (row: number, c: number, v: string | number) => { while (data[row].length <= c) data[row].push(null); data[row][c] = v; };
put(1, 9, "Tax rate"); put(1, 10, 0.08);
put(3, 9, "Grand total"); put(3, 10, "=SUM(G:G)");
REGIONS.forEach((reg, i) => { put(4 + i, 9, reg); put(4 + i, 10, `=SUMIF(B:B,J${5 + i},G:G)`); });
put(9, 10, "=COUNT(A:A)"); put(10, 10, "=AVERAGE(G:G)"); put(11, 10, "=MAX(G:G)");
const tData = performance.now() - t0;

const t1 = performance.now();
const hf = HyperFormula.buildFromArray(data, { licenseKey: "gpl-v3", maxRows: orders + 10, useColumnIndex: true });
const tBuild = performance.now() - t1;
console.log(`HyperFormula ${orders.toLocaleString()} orders: build+full calc ${tBuild.toFixed(0)} ms (array prep ${tData.toFixed(0)} ms) rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);

console.log(`before edits: K4 = ${hf.getCellValue({ sheet: 0, col: 10, row: 3 })}  K5 North = ${hf.getCellValue({ sheet: 0, col: 10, row: 4 })}  H last = ${hf.getCellValue({ sheet: 0, col: 7, row: orders })}`);
const runs = (label: string, f: (i: number) => void) => {
  const ms: number[] = [];
  for (let i = 0; i < 5; i++) { const t = performance.now(); f(i); ms.push(performance.now() - t); }
  console.log(`${label.padEnd(44)} ${median(ms).toFixed(2).padStart(9)} ms`);
};
const sheet = 0;
const mid = orders >> 1;
runs("edit Units in the last row (C last)", (i) => hf.setCellContents({ sheet, col: 2, row: orders }, 3 + i));
runs("edit Region in the middle (SUMIF only)", (i) => hf.setCellContents({ sheet, col: 1, row: mid }, REGIONS[i % 4]));
runs("edit Units in the middle (half the chain)", (i) => hf.setCellContents({ sheet, col: 2, row: mid }, 3 + i));
runs("edit Units in row 1 (the whole chain)", (i) => hf.setCellContents({ sheet, col: 2, row: 1 }, 3 + i));
runs("edit the tax rate K2 (every formula)", (i) => hf.setCellContents({ sheet, col: 10, row: 1 }, 0.05 + i / 100));
console.log(`grand total K4 = ${hf.getCellValue({ sheet, col: 10, row: 3 })}`);
