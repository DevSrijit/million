// Streaming CSV parser (RFC 4180 plus the usual real-world variants).
//
// - Feed decoded text with push(), then call end(). Chunks can split anywhere: inside a field,
//   inside quotes, between \r and \n. A row that is not complete at the end of a chunk is carried
//   into the next one and parsed again. Cells are written at fixed (row, column) positions, so
//   parsing a row twice is harmless.
// - Quoted fields may hold the delimiter, newlines and "" (an escaped quote).
// - The delimiter is detected from the first lines: comma, semicolon, tab or pipe.
// - Types: numbers become numbers, TRUE/FALSE become booleans, everything else is text. Codes with
//   a leading zero ("00123") and digit strings longer than 15 digits stay text, so IDs keep every
//   digit.
//
// Output: one pair of typed arrays per column (type tag, value), plus a string table. The values
// of text cells are indexes into that table.

export const EMPTY = 0, NUM = 1, STR = 2, BOOL = 3;

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const LEADING_ZERO_RE = /^[+-]?0\d/;

export class CsvTooLarge extends Error {}

export class CsvParser {
  delimiter = -1; // char code; -1 until detected
  rows = 0;
  cols = 0;
  strings: string[] = [];
  private strIds = new Map<string, number>();
  private t: Uint8Array[] = [];
  private v: Float64Array[] = [];
  private cap = 1 << 14;
  private carry = "";
  private skipLF = false; // the last chunk ended with \r: a \n at the start of the next one belongs to it

  constructor(private readonly maxCells = 60_000_000, private readonly maxCols = 512) {}

  push(text: string) { this.parse(this.carry + text, false); }

  end() {
    if (this.carry) this.parse(this.carry, true);
    this.carry = "";
  }

  // Column c as typed arrays trimmed to the row count.
  column(c: number): { t: Uint8Array; v: Float64Array } {
    return { t: this.t[c].subarray(0, this.rows), v: this.v[c].subarray(0, this.rows) };
  }

  // Row 0 looks like a header when it is all text and the next row holds a number.
  get hasHeader(): boolean {
    if (this.rows < 2) return false;
    let text0 = true, num1 = false;
    for (let c = 0; c < this.cols; c++) {
      const a = this.t[c][0], b = this.t[c][1];
      if (a !== STR && a !== EMPTY) text0 = false;
      if (b === NUM) num1 = true;
    }
    return text0 && num1;
  }

  private detect(s: string) {
    // Count candidates outside quotes in the first few lines.
    const cands = [44, 59, 9, 124]; // , ; \t |
    const counts = [0, 0, 0, 0];
    let inQ = false, lines = 0;
    for (let i = 0; i < s.length && lines < 10; i++) {
      const c = s.charCodeAt(i);
      if (c === 34) inQ = !inQ;
      else if (!inQ) {
        if (c === 10) lines++;
        const k = cands.indexOf(c);
        if (k >= 0) counts[k]++;
      }
    }
    let best = 0;
    for (let k = 1; k < 4; k++) if (counts[k] > counts[best]) best = k;
    this.delimiter = cands[best];
  }

  private grow(minRows: number) {
    let cap = this.cap;
    while (cap <= minRows) cap *= 2;
    if (cap === this.cap) return;
    for (let c = 0; c < this.t.length; c++) {
      const t = new Uint8Array(cap); t.set(this.t[c]); this.t[c] = t;
      const v = new Float64Array(cap); v.set(this.v[c]); this.v[c] = v;
    }
    this.cap = cap;
  }

  private ensureCol(c: number) {
    if (c >= this.maxCols) throw new CsvTooLarge(`More than ${this.maxCols} columns`);
    while (this.t.length <= c) { this.t.push(new Uint8Array(this.cap)); this.v.push(new Float64Array(this.cap)); }
    if (c >= this.cols) this.cols = c + 1;
  }

  private cell(row: number, col: number, text: string) {
    this.ensureCol(col);
    const t = this.t[col], v = this.v[col];
    if (text === "") { t[row] = EMPTY; v[row] = 0; return; }
    const c0 = text.charCodeAt(0);
    // Fast reject for text: a number starts with a digit, a sign or a dot.
    if ((c0 >= 48 && c0 <= 57) || c0 === 45 || c0 === 43 || c0 === 46) {
      if (NUMBER_RE.test(text) && !LEADING_ZERO_RE.test(text)) {
        let digits = 0;
        for (let i = 0; i < text.length; i++) { const ch = text.charCodeAt(i); if (ch >= 48 && ch <= 57) digits++; }
        if (digits <= 15) { t[row] = NUM; v[row] = Number(text); return; }
      }
    } else if (text.length <= 5) {
      const u = text.toUpperCase();
      if (u === "TRUE" || u === "FALSE") { t[row] = BOOL; v[row] = u === "TRUE" ? 1 : 0; return; }
    }
    let id = this.strIds.get(text);
    if (id === undefined) { id = this.strings.length; this.strings.push(text); this.strIds.set(text, id); }
    t[row] = STR;
    v[row] = id;
  }

  private parse(s: string, final: boolean) {
    if (this.delimiter < 0) this.detect(s);
    const D = this.delimiter;
    const n = s.length;
    let i = 0;
    if (this.skipLF && n > 0) { if (s.charCodeAt(0) === 10) i = 1; this.skipLF = false; }
    rows: while (i < n) {
      const rowStart = i;
      const row = this.rows;
      if (row >= this.cap - 1) this.grow(row + 1);
      let col = 0;
      for (;;) {
        // One field.
        let value: string;
        if (i < n && s.charCodeAt(i) === 34) {
          let start = i + 1, j = start, parts = "";
          for (;;) {
            const q = s.indexOf('"', j);
            if (q < 0 || (q + 1 === n && !final)) {
              // The quote is not closed in this chunk (or "" may continue in the next one).
              if (!final) { this.carry = s.slice(rowStart); return; }
              value = parts + s.slice(start, q < 0 ? n : q);
              i = n;
              break;
            }
            if (s.charCodeAt(q + 1) === 34) { parts += s.slice(start, q + 1); j = q + 2; start = j; continue; }
            value = parts + s.slice(start, q);
            i = q + 1;
            break;
          }
          // Text after a closing quote, before the delimiter, is ignored (Excel keeps it; RFC says it is invalid).
          while (i < n) { const c = s.charCodeAt(i); if (c === D || c === 10 || c === 13) break; i++; }
        } else {
          let j = i;
          while (j < n) { const c = s.charCodeAt(j); if (c === D || c === 10 || c === 13) break; j++; }
          if (j === n && !final) { this.carry = s.slice(rowStart); return; }
          value = s.slice(i, j);
          i = j;
        }
        if (value === "" && col === 0 && (i >= n || s.charCodeAt(i) === 10 || s.charCodeAt(i) === 13)) {
          // A blank line: skip it without counting a row.
          if (i < n && s.charCodeAt(i) === 13) { i++; if (i < n) { if (s.charCodeAt(i) === 10) i++; } else if (!final) this.skipLF = true; }
          else if (i < n) i++;
          continue rows;
        }
        this.cell(row, col++, value);
        if (this.cols * (row + 1) > this.maxCells) throw new CsvTooLarge(`More than ${this.maxCells.toLocaleString("en-US")} cells`);
        if (i >= n) { this.rows = row + 1; break rows; }
        const c = s.charCodeAt(i);
        if (c === D) {
          i++;
          if (i >= n && !final) { this.carry = s.slice(rowStart); return; } // the next field is in the next chunk
          if (i >= n) { this.cell(row, col++, ""); this.rows = row + 1; break rows; }
          continue;
        }
        // End of the row: \n, \r\n or \r.
        if (c === 13) { i++; if (i < n) { if (s.charCodeAt(i) === 10) i++; } else if (!final) this.skipLF = true; }
        else i++;
        this.rows = row + 1;
        continue rows;
      }
    }
    this.carry = "";
  }
}

// Reads a file as a stream and parses it. Calls onProgress(bytesRead, rows) as it goes.
export async function parseCsvFile(file: Blob, onProgress?: (bytes: number, rows: number) => void): Promise<CsvParser> {
  const p = new CsvParser();
  const reader = file.stream().getReader();
  const dec = new TextDecoder("utf-8");
  let bytes = 0, first = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    let text = dec.decode(value, { stream: true });
    if (first) { if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); first = false; } // byte-order mark
    p.push(text);
    onProgress?.(bytes, p.rows);
  }
  p.push(dec.decode());
  p.end();
  onProgress?.(bytes, p.rows);
  return p;
}
