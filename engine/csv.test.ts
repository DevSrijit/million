import { describe, expect, test } from "bun:test";
import { BOOL, CsvParser, CsvTooLarge, EMPTY, NUM, STR } from "./csv";

// Parses text in the given chunk sizes and returns rows of [tag, value] pairs as display strings.
function parse(text: string, chunks: number[] = [text.length]) {
  const p = new CsvParser();
  let i = 0, k = 0;
  while (i < text.length) { const n = chunks[k++ % chunks.length]; p.push(text.slice(i, i + n)); i += n; }
  p.end();
  const out: string[][] = [];
  for (let r = 0; r < p.rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < p.cols; c++) {
      const { t, v } = p.column(c);
      row.push(t[r] === EMPTY ? "" : t[r] === NUM ? `n:${v[r]}` : t[r] === BOOL ? `b:${v[r]}` : `s:${p.strings[v[r]]}`);
    }
    out.push(row);
  }
  return { rows: out, parser: p };
}

describe("CSV parsing", () => {
  test("quotes, escaped quotes, delimiters and newlines inside quotes", () => {
    const { rows } = parse('name,note,qty\n"Smith, Jo","said ""hi""\nthen left",3\nLee,,4\n');
    expect(rows).toEqual([
      ["s:name", "s:note", "s:qty"],
      ["s:Smith, Jo", 's:said "hi"\nthen left', "n:3"],
      ["s:Lee", "", "n:4"],
    ]);
  });
  test("CRLF, blank lines, no final newline, a trailing empty field", () => {
    const { rows } = parse("a,b\r\n1,2\r\n\r\n3,\r\n4,5");
    expect(rows).toEqual([["s:a", "s:b"], ["n:1", "n:2"], ["n:3", ""], ["n:4", "n:5"]]);
  });
  test("delimiter detection: semicolon and tab", () => {
    expect(parse("a;b;c\n1;2,5;3\n").rows).toEqual([["s:a", "s:b", "s:c"], ["n:1", "s:2,5", "n:3"]]);
    expect(parse("a\tb\n1\t2\n").rows).toEqual([["s:a", "s:b"], ["n:1", "n:2"]]);
  });
  test("types: numbers, leading zeros, long IDs, booleans", () => {
    const { rows } = parse("x\n-1.5e3\n00123\n1234567890123456\n123456789012345\nTRUE\nfalse\n.5\n1.\n12abc\n");
    expect(rows.map((r) => r[0])).toEqual([
      "s:x", "n:-1500", "s:00123", "s:1234567890123456", "n:123456789012345", "b:1", "b:0", "n:0.5", "n:1", "s:12abc",
    ]);
  });
  test("ragged rows widen the sheet", () => {
    const { rows } = parse("a\n1,2,3\n4\n");
    expect(rows).toEqual([["s:a", "", ""], ["n:1", "n:2", "n:3"], ["n:4", "", ""]]);
  });
  test("header detection", () => {
    expect(parse("name,qty\nA,1\n").parser.hasHeader).toBe(true);
    expect(parse("1,2\n3,4\n").parser.hasHeader).toBe(false);
  });
  test("too many cells is a clear error", () => {
    const p = new CsvParser(10);
    expect(() => { p.push("a,b,c\n1,2,3\n4,5,6\n7,8,9\n"); p.end(); }).toThrow(CsvTooLarge);
  });

  // Differential: any chunking must give the same result as one chunk.
  test("random chunk splits give the same result as the whole file", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const field = () => pick([
      () => String(Math.floor(rnd() * 1000)), () => (rnd() * 100).toFixed(2), () => "", () => "plain",
      () => '"quoted, with comma"', () => '"has ""quotes"""', () => '"multi\nline"', () => '"crlf\r\ninside"', () => "TRUE", () => "007",
    ])();
    for (let round = 0; round < 40; round++) {
      const lines: string[] = [];
      const cols = 1 + Math.floor(rnd() * 6);
      for (let r = 0; r < 60; r++) lines.push(Array.from({ length: cols }, field).join(","));
      const text = lines.join(pick(["\n", "\r\n"])) + pick(["", "\n", "\r\n"]);
      const whole = parse(text).rows;
      const sizes = Array.from({ length: 5 }, () => 1 + Math.floor(rnd() * 40));
      expect(parse(text, sizes).rows).toEqual(whole);
      expect(parse(text, [1]).rows).toEqual(whole); // one character at a time
    }
  });
});
