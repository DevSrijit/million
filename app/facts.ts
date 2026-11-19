// Every number on the landing page was measured: in Chrome (production build) with the in-app
// Benchmark, and in Bun with bench/engine.ts and bench/hyperformula/hf.ts.
export const NAME = "Million";
// Numbers and units are joined with a no-break space, so a unit never wraps alone.
export const FACTS = {
  rows: "1,000,001",
  formulas: "4,000,009",
  smallEdit: "3\u00a0µs", // 12 cells, warm median
  smallCells: "12",
  bigEdit: "185\u00a0ms", // tax rate, 3,000,008 cells, in 8 ms slices
  bigCells: "3,000,008",
  load: "0.2\u00a0s", // build + full recalc
  hfLoad: "84.6\u00a0s", // HyperFormula 3.5.0 at 1M orders, Bun
  hfMem: "7.4\u00a0GB",
  mem: "187\u00a0MB",
  smallEditBun: "5\u00a0µs", // the same 12-cell edit in Bun, for the HyperFormula comparison
  hfSmall: "2,062\u00a0ms", // HyperFormula, the same 12-cell edit at 1M orders
};
