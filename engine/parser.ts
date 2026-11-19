// Formula parser. The parser turns formula text into an AST.
// Every reference is stored relative to the host cell, unless the text marks it absolute with "$".
// Two cells with the same relative formula (a fill-down) therefore produce the same AST.

export const MAX_ROW = 0x7fffffff; // sentinel for "to the end of the column" (A:A)

export type Ref = { c: number; ca: boolean; r: number; ra: boolean };
export type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "err"; v: string }
  | { k: "ref"; ref: Ref }
  | { k: "range"; a: Ref; b: Ref }
  | { k: "un"; op: "-" | "+" | "%"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "call"; name: string; args: Node[] };

export class ParseError extends Error {}

export function colToIndex(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n - 1;
}

export function indexToCol(n: number): string {
  let s = "";
  n++;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = ((n - 1) / 26) | 0;
  }
  return s;
}

export function cellName(col: number, row: number): string {
  return indexToCol(col) + (row + 1);
}

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "op"; v: string }
  | { t: "name"; v: string }
  | { t: "cell"; col: number; ca: boolean; row: number; ra: boolean }
  | { t: "colref"; col: number; ca: boolean }
  | { t: "err"; v: string };

const CELL_RE = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)/;
const COL_RE = /^(\$?)([A-Za-z]{1,3})(?=:)/;
const COL_AFTER_COLON_RE = /^(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9(])/;
const NUM_RE = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*/;
const ERR_RE = /^#(?:DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|CYCLE!)/;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n") { i++; continue; }
    const rest = src.slice(i);
    if (ch === '"') {
      let j = i + 1, s = "";
      for (;;) {
        if (j >= src.length) throw new ParseError("Unclosed string");
        if (src[j] === '"') {
          if (src[j + 1] === '"') { s += '"'; j += 2; continue; }
          break;
        }
        s += src[j++];
      }
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    let m = ERR_RE.exec(rest);
    if (m) { out.push({ t: "err", v: m[0] }); i += m[0].length; continue; }
    m = NUM_RE.exec(rest);
    if (m) { out.push({ t: "num", v: parseFloat(m[0]) }); i += m[0].length; continue; }
    // A whole-column reference only exists next to a colon: "A:A". After a colon, accept a bare column too.
    const prev = out[out.length - 1];
    const afterColon = prev && prev.t === "op" && prev.v === ":";
    m = CELL_RE.exec(rest);
    if (m && !/[A-Za-z0-9_(]/.test(rest[m[0].length] ?? "")) {
      out.push({ t: "cell", ca: m[1] === "$", col: colToIndex(m[2].toUpperCase()), ra: m[3] === "$", row: parseInt(m[4], 10) - 1 });
      i += m[0].length;
      continue;
    }
    m = afterColon ? COL_AFTER_COLON_RE.exec(rest) : COL_RE.exec(rest);
    if (m) { out.push({ t: "colref", ca: m[1] === "$", col: colToIndex(m[2].toUpperCase()) }); i += m[0].length; continue; }
    m = NAME_RE.exec(rest);
    if (m) { out.push({ t: "name", v: m[0].toUpperCase() }); i += m[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") { out.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/^&=<>(),:%".includes(ch)) { out.push({ t: "op", v: ch }); i++; continue; }
    throw new ParseError(`Unexpected "${ch}"`);
  }
  return out;
}

// Binding power for binary operators. Higher binds tighter. Matches Excel precedence.
const BP: Record<string, number> = { "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5 };

export function parseFormula(src: string, hostCol: number, hostRow: number): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const isOp = (v: string) => { const t = toks[p]; return t !== undefined && t.t === "op" && t.v === v; };
  const expectOp = (v: string) => { if (!isOp(v)) throw new ParseError(`Expected "${v}"`); p++; };

  const rel = (col: number, ca: boolean, row: number, ra: boolean): Ref => ({
    c: ca ? col : col - hostCol, ca,
    r: ra ? row : row - hostRow, ra,
  });

  function primary(): Node {
    const t = next();
    if (!t) throw new ParseError("Unexpected end of formula");
    switch (t.t) {
      case "num": return { k: "num", v: t.v };
      case "str": return { k: "str", v: t.v };
      case "err": return { k: "err", v: t.v };
      case "cell": {
        const a = rel(t.col, t.ca, t.row, t.ra);
        if (isOp(":")) {
          p++;
          const u = next();
          if (!u || u.t !== "cell") throw new ParseError("Bad range");
          return { k: "range", a, b: rel(u.col, u.ca, u.row, u.ra) };
        }
        return { k: "ref", ref: a };
      }
      case "colref": {
        expectOp(":");
        const u = next();
        if (!u || u.t !== "colref") throw new ParseError("Bad column range");
        return { k: "range", a: rel(t.col, t.ca, 0, true), b: rel(u.col, u.ca, MAX_ROW, true) };
      }
      case "name": {
        if (t.v === "TRUE") return { k: "bool", v: true };
        if (t.v === "FALSE") return { k: "bool", v: false };
        expectOp("(");
        const args: Node[] = [];
        if (!isOp(")")) {
          for (;;) {
            args.push(expr(0));
            if (isOp(",")) { p++; continue; }
            break;
          }
        }
        expectOp(")");
        return { k: "call", name: t.v, args };
      }
      case "op": {
        if (t.v === "(") { const e = expr(0); expectOp(")"); return e; }
        if (t.v === "-" || t.v === "+") return { k: "un", op: t.v, a: expr(5) }; // Excel: unary minus binds tighter than ^, so =-2^2 is 4
        throw new ParseError(`Unexpected "${t.v}"`);
      }
    }
  }

  function expr(minBp: number): Node {
    let left = primary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== "op") break;
      if (t.v === "%") { p++; left = { k: "un", op: "%", a: left }; continue; }
      const bp = BP[t.v];
      if (bp === undefined || bp <= minBp) break;
      p++;
      // "^" is left-associative in Excel, so every operator uses the same rule.
      const right = expr(bp);
      left = { k: "bin", op: t.v, a: left, b: right };
    }
    return left;
  }

  const node = expr(0);
  if (p < toks.length) throw new ParseError("Unexpected text after formula");
  return node;
}

// Print an AST back to A1 text for a given host cell. The formula bar uses this.
export function printFormula(n: Node, hostCol: number, hostRow: number): string {
  const ref = (r: Ref, colOnly = false) => {
    const col = r.ca ? r.c : r.c + hostCol;
    const row = r.ra ? r.r : r.r + hostRow;
    const cs = (r.ca ? "$" : "") + (col >= 0 ? indexToCol(col) : "#REF");
    if (colOnly) return cs;
    return cs + (r.ra ? "$" : "") + (row >= 0 ? row + 1 : "#REF");
  };
  const go = (n: Node, parentBp: number): string => {
    switch (n.k) {
      case "num": return String(n.v);
      case "str": return `"${n.v.replace(/"/g, '""')}"`;
      case "bool": return n.v ? "TRUE" : "FALSE";
      case "err": return n.v;
      case "ref": return ref(n.ref);
      case "range":
        if (n.a.ra && n.a.r === 0 && n.b.ra && n.b.r === MAX_ROW) return `${ref(n.a, true)}:${ref(n.b, true)}`;
        return `${ref(n.a)}:${ref(n.b)}`;
      case "un": return n.op === "%" ? `${go(n.a, 6)}%` : `${n.op}${go(n.a, 5)}`;
      case "bin": {
        const bp = BP[n.op];
        const s = `${go(n.a, bp - 0.1)}${n.op}${go(n.b, bp)}`;
        return bp <= parentBp ? `(${s})` : s;
      }
      case "call": return `${n.name}(${n.args.map((a) => go(a, 0)).join(",")})`;
    }
  };
  return "=" + go(n, 0);
}
