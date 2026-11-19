// The demo workbook: a sales ledger with 1,000,000 orders.
//
//   A Order   B Region   C Units   D Price   E Revenue =C*D   F Tax =E*$K$2   G Total =E+F   H Running total =H(prev)+G
//   J/K: a summary panel. K2 is the tax rate that every row reads (the worst-case edit).

import { Sheet } from "./sheet";

export const DEMO_COLS = 12; // A..L
export const REGIONS = ["North", "South", "East", "West"];

export function buildLedger(orders: number): Sheet {
  const rows = orders + 1;
  const s = new Sheet(rows, DEMO_COLS);
  const headers = ["Order", "Region", "Units", "Price", "Revenue", "Tax", "Total", "Running total"];
  headers.forEach((h, c) => s.setString(c, 0, h));

  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let r = 1; r <= orders; r++) {
    s.setNumber(0, r, 100000 + r);
    s.setString(1, r, REGIONS[(rnd() * 4) | 0]);
    s.setNumber(2, r, 1 + ((rnd() * 20) | 0));
    s.setNumber(3, r, Math.round((5 + rnd() * 495) * 100) / 100);
  }
  const last = orders; // last data row index
  s.fillFormula(4, 1, last, "=C2*D2");
  s.fillFormula(5, 1, last, "=E2*$K$2");
  s.fillFormula(6, 1, last, "=E2+F2");
  s.fillFormula(7, 1, 1, "=G2");
  if (last >= 2) s.fillFormula(7, 2, last, "=H2+G3");

  s.setString(9, 0, "Summary");
  s.setString(9, 1, "Tax rate");
  s.setNumber(10, 1, 0.08);
  s.cellFormats.set(10 * rows + 1, "percent");
  s.setString(9, 3, "Grand total");
  s.fillFormula(10, 3, 3, "=SUM(G:G)");
  REGIONS.forEach((reg, i) => {
    s.setString(9, 4 + i, reg);
    s.fillFormula(10, 4 + i, 4 + i, `=SUMIF(B:B,J${5 + i},G:G)`);
  });
  s.setString(9, 9, "Orders");
  s.fillFormula(10, 9, 9, "=COUNT(A:A)");
  s.cellFormats.set(10 * rows + 9, "int");
  s.setString(9, 10, "Average order");
  s.fillFormula(10, 10, 10, "=AVERAGE(G:G)");
  s.setString(9, 11, "Largest order");
  s.fillFormula(10, 11, 11, "=MAX(G:G)");
  s.setString(9, 12, "Check");
  s.fillFormula(10, 12, 12, `=ROUND(H${last + 1}-K4,2)`);

  s.formats = ["id", "general", "int", "money", "money", "money", "money", "money", "general", "general", "money", "general"];
  return s;
}
