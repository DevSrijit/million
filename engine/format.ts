// Fast number formatting for the viewport. Intl.NumberFormat is too slow to call per cell per frame.

export type NumFormat = "general" | "plain" | "fixed2" | "int" | "id" | "money" | "percent";

function group(intPart: string): string {
  let neg = "";
  if (intPart[0] === "-") { neg = "-"; intPart = intPart.slice(1); }
  if (intPart.length <= 3) return neg + intPart;
  let out = "";
  const head = intPart.length % 3;
  if (head) out = intPart.slice(0, head);
  for (let i = head; i < intPart.length; i += 3) out += (out ? "," : "") + intPart.slice(i, i + 3);
  return neg + out;
}

export function formatNumber(x: number, f: NumFormat): string {
  switch (f) {
    case "id": return String(x);
    case "fixed2": return x.toFixed(2); // imported prices: two decimals, no separators
    // Imported data: no thousands separators (IDs, years, codes), up to 10 significant digits, like Excel's General.
    case "plain": {
      if (Number.isInteger(x) && Math.abs(x) < 1e15) return String(x);
      const ax = Math.abs(x);
      if (ax >= 1e15 || (ax < 1e-6 && ax > 0)) return x.toExponential(4);
      return String(+x.toPrecision(10));
    }
    case "int": return group(Math.round(x).toString());
    case "money": {
      const s = x.toFixed(2);
      const dot = s.length - 3;
      return group(s.slice(0, dot)) + s.slice(dot);
    }
    case "percent": return +(x * 100).toFixed(2) + "%";
    default: {
      if (Number.isInteger(x) && Math.abs(x) < 1e15) return group(String(x));
      const ax = Math.abs(x);
      if (ax >= 1e15 || (ax < 1e-6 && ax > 0)) return x.toExponential(4);
      const s = String(+x.toPrecision(10));
      const dot = s.indexOf(".");
      return dot < 0 ? group(s) : group(s.slice(0, dot)) + s.slice(dot);
    }
  }
}
