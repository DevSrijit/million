// The engine runs here, off the main thread. The main thread only pulls the visible window.
//
// A big edit runs in slices of SLICE_MS. Between slices the worker answers view and inspect
// messages, so the grid keeps scrolling while 3M cells recompute, and the values update in place.
import { buildLedger, DEMO_COLS } from "./demo";
import { ParseError, RecalcStats, Sheet } from "./sheet";
import { shiftFormula } from "./parser";
import { CsvTooLarge, parseCsvFile, NUM, STR } from "./csv";

export type ViewReply = {
  type: "view"; id: number; r0: number; r1: number; cols: number;
  texts: string[]; tags: Uint8Array;
  flags: Uint8Array; // bit0 formula, bit1 recomputed in the current or last edit, bit2 stale (not recomputed yet)
  epoch: number;
};

const SLICE_MS = 8;

let sheet: Sheet;

// Shared memory: when the page is cross-origin isolated, every column lives in SharedArrayBuffers.
// The worker posts each column's buffers once; the renderer then reads cells straight from engine
// memory, so any scroll speed, even a scrollbar drag across a million rows, draws real values.
const SHARED = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined";
const sharedOpts = SHARED
  ? {
      alloc: (bytes: number) => new SharedArrayBuffer(bytes),
      onColumn: (c: number, col: { v: Float64Array; t: Uint8Array; f: Int32Array | null; st: Uint8Array | null; stamp: Uint32Array | null }) =>
        post({ type: "column", c, v: col.v, t: col.t, f: col.f, st: col.st, stamp: col.stamp }),
    }
  : {};
// The renderer mirrors the string pool; this is how much of it it has.
let sentStrings = 0;
function syncStrings() {
  if (!SHARED || !sheet || sheet.stringCount === sentStrings) return;
  post({ type: "strings", from: sentStrings, list: sheet.stringsFrom(sentStrings) });
  sentStrings = sheet.stringCount;
}
const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

// Undo history: inputs before and after each edit.
// One undo step: every cell it changed. A single edit has one cell; a paste or a cleared range many.
type Change = { col: number; row: number; cells: { col: number; row: number; before: string; after: string }[] };
const undo: Change[] = [];
const redo: Change[] = [];

// The cell of the edit that is running, for the reply.
let running: { col: number; row: number; slices: number; kind: "edit" | "undo" | "redo" | "paste" | "clear"; count: number } | null = null;

// Batch edits are capped: the undo step keeps every old input in memory.
const MAX_BATCH = 1_000_000;

// The block copied last, kept with its formulas so a paste can shift them like Excel.
let clip: { c0: number; r0: number; inputs: string[][] } | null = null;

// A zero-delay yield. setTimeout(0) is clamped to 4 ms after a few nested calls; a MessageChannel is not.
const channel = new MessageChannel();
channel.port1.onmessage = () => pump();
const yieldThenPump = () => channel.port2.postMessage(null);

function reply(st: RecalcStats) {
  const r = running!;
  running = null;
  syncStrings();
  post({ type: "edited", col: r.col, row: r.row, slices: r.slices, kind: r.kind, count: r.count, ...st });
}

function pump() {
  if (!running) return;
  running.slices++;
  const st = sheet.step(SLICE_MS);
  if (st) { reply(st); return; }
  syncStrings();
  post({ type: "progress", epoch: sheet.epoch, col: running.col, row: running.row });
  yieldThenPump();
}

// Finishes a paused edit at once (before another edit, an undo, or a benchmark).
function settle() {
  if (!running) return;
  const st = sheet.step();
  if (st) reply(st);
}

function begin(col: number, row: number, text: string, history: "push" | "undo" | "redo"): boolean {
  return beginBatch([[col, row, text]], { col, row }, history === "push" ? "edit" : history, false);
}

// Applies one undoable edit of any size. `kind` labels it for the status bar.
function beginBatch(cells: [number, number, string][], at: { col: number; row: number }, kind: "edit" | "undo" | "redo" | "paste" | "clear", lenient: boolean): boolean {
  settle();
  cells = cells.filter(([c, r]) => c >= 0 && r >= 0 && c < sheet.cols && r < sheet.rows);
  if (cells.length > MAX_BATCH) {
    post({ type: "editError", col: at.col, row: at.row, text: "", message: `That is ${cells.length.toLocaleString("en-US")} cells. Edit up to ${MAX_BATCH.toLocaleString("en-US")} at a time.`, quiet: true });
    return false;
  }
  const before = cells.map(([c, r]) => sheet.getInput(c, r));
  try {
    sheet.beginInputs(cells, lenient);
  } catch (err) {
    const [c, r, text] = cells[0];
    post({ type: "editError", col: c, row: r, text, message: err instanceof ParseError ? err.message : String(err) });
    return false;
  }
  if (kind !== "undo" && kind !== "redo") {
    undo.push({ col: at.col, row: at.row, cells: cells.map(([c, r, after], i) => ({ col: c, row: r, before: before[i], after })) });
    redo.length = 0;
  }
  running = { col: at.col, row: at.row, slices: 0, kind, count: cells.length };
  pump();
  return true;
}

self.onmessage = (e: MessageEvent) => {
  try { handle(e.data); } catch (err) {
    post({ type: "workerError", message: String(err), stack: err instanceof Error ? err.stack : "", request: JSON.stringify(e.data).slice(0, 300) });
  }
};

function handle(m: { type: string; [k: string]: any }) {
  switch (m.type) {
    case "init": {
      const t0 = performance.now();
      sentStrings = 0;
      sheet = buildLedger(m.orders, sharedOpts);
      const buildMs = performance.now() - t0;
      const full = sheet.recalcAll();
      const st = sheet.stats();
      syncStrings();
      if (SHARED) post({ type: "formats", formats: sheet.formats, cellFormats: [...sheet.cellFormats] });
      post({ type: "ready", kind: "ledger", rows: sheet.rows, cols: DEMO_COLS, buildMs, recalcMs: full.ms, ...st, epoch: sheet.epoch, isolated: self.crossOriginIsolated, shared: SHARED });
      break;
    }
    case "view": {
      const r0 = Math.max(0, Math.floor(m.r0)), r1 = Math.min(sheet.rows, Math.ceil(m.r1));
      const n = (r1 - r0) * sheet.cols;
      const texts = new Array<string>(n);
      const tags = new Uint8Array(n), flags = new Uint8Array(n);
      let k = 0;
      for (let r = r0; r < r1; r++) for (let c = 0; c < sheet.cols; c++, k++) {
        texts[k] = sheet.display(c, r);
        tags[k] = sheet.tag(c, r);
        flags[k] = (sheet.isFormula(c, r) ? 1 : 0) | (sheet.stamp(c, r) === sheet.epoch ? 2 : 0) | (sheet.isStale(c, r) ? 4 : 0);
      }
      const out: ViewReply = { type: "view", id: m.id, r0, r1, cols: sheet.cols, texts, tags, flags, epoch: sheet.epoch };
      post(out, [tags.buffer, flags.buffer]);
      break;
    }
    case "loadCsv": {
      // Read a file on this machine (nothing is uploaded), then swap it in as the sheet.
      settle();
      const file = m.file as File;
      const t0 = performance.now();
      let lastPost = 0;
      parseCsvFile(file, (bytes, rows) => {
        const now = performance.now();
        if (now - lastPost < 80) return;
        lastPost = now;
        post({ type: "csvProgress", name: file.name, bytes, total: file.size, rows });
      })
        .then((p) => {
          const parseMs = performance.now() - t0;
          if (p.rows === 0) throw new Error("The file has no rows.");
          const t1 = performance.now();
          // Room to work: empty columns to the right and rows below for the user's own formulas.
          const cols = Math.min(p.cols + 6, 702);
          const rows = p.rows + 200;
          sentStrings = 0;
          undo.length = 0; redo.length = 0;
          sheet = new Sheet(rows, cols, sharedOpts);
          const map = sheet.internAll(p.strings);
          for (let c = 0; c < p.cols; c++) { const col = p.column(c); sheet.loadColumn(c, col.t, col.v, map); }
          sheet.formats = new Array(cols).fill("plain");
          // A column whose sampled numbers mostly have cents (prices, amounts) shows two decimals.
          for (let c = 0; c < p.cols; c++) {
            const { t, v } = p.column(c);
            let nums = 0, cents = 0;
            for (let r = 0; r < Math.min(p.rows, 500); r++) {
              if (t[r] !== NUM) continue;
              nums++;
              const x = v[r] * 100;
              if (Math.abs(x - Math.round(x)) < 1e-6 && !Number.isInteger(v[r])) cents++;
            }
            if (nums >= 10 && cents >= nums * 0.5) sheet.formats[c] = "fixed2";
          }
          // Column widths from the header and the first rows, like a spreadsheet's auto-fit.
          const widths: number[] = [];
          for (let c = 0; c < cols; c++) {
            if (c >= p.cols) { widths.push(96); continue; }
            const { t, v } = p.column(c);
            let len = 3;
            for (let r = 0; r < Math.min(p.rows, 300); r++) {
              const tag = t[r];
              const n = tag === STR ? p.strings[v[r]].length : tag === NUM ? String(+v[r].toPrecision(10)).length : tag ? 5 : 0;
              if (n > len) len = n;
            }
            widths.push(Math.max(56, Math.min(300, Math.round(len * 7.4 + 24))));
          }
          const full = sheet.recalcAll();
          const buildMs = performance.now() - t1;
          syncStrings();
          if (SHARED) post({ type: "formats", formats: sheet.formats, cellFormats: [] });
          const st = sheet.stats();
          post({
            type: "ready", kind: "csv", name: file.name, bytes: file.size, header: p.hasHeader, dataRows: p.rows, dataCols: p.cols,
            rows: sheet.rows, cols, widths, parseMs, buildMs, recalcMs: full.ms, ...st, epoch: sheet.epoch, shared: SHARED,
          });
        })
        .catch((err) => {
          post({ type: "csvError", name: file.name, message: err instanceof CsvTooLarge ? `${err.message}. Try a smaller file.` : String(err instanceof Error ? err.message : err) });
        });
      break;
    }
    case "edit":
      begin(m.col, m.row, m.text, "push");
      break;
    case "undo": case "redo": {
      settle();
      const from = m.type === "undo" ? undo : redo;
      const ch = from.pop();
      if (!ch) { post({ type: "historyEmpty", which: m.type }); break; }
      const cells = ch.cells.map((x) => [x.col, x.row, m.type === "undo" ? x.before : x.after] as [number, number, string]);
      if (beginBatch(cells, { col: ch.col, row: ch.row }, m.type, true)) (m.type === "undo" ? redo : undo).push(ch);
      break;
    }
    case "editRange": {
      // A paste from outside, already split into cells by the page.
      beginBatch(m.cells, m.at, m.kind ?? "paste", true);
      break;
    }
    case "clearRange": {
      const { c0, r0, c1, r1 } = m;
      const n = (c1 - c0 + 1) * (r1 - r0 + 1);
      if (n > MAX_BATCH) {
        post({ type: "editError", col: c0, row: r0, text: "", message: `That is ${n.toLocaleString("en-US")} cells. Clear up to ${MAX_BATCH.toLocaleString("en-US")} at a time.`, quiet: true });
        break;
      }
      const cells: [number, number, string][] = [];
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (sheet.getInput(c, r) !== "") cells.push([c, r, ""]);
      if (cells.length) beginBatch(cells, { col: c0, row: r0 }, "clear", true);
      break;
    }
    case "copySnapshot": {
      // Keep the copied block's inputs as they are now, so a later paste uses what was copied.
      const { c0, r0, c1, r1 } = m;
      clip = { c0, r0, inputs: sheet.inputsIn(c0, r0, c1, r1) };
      break;
    }
    case "pasteInternal": {
      // A paste of our own copy: formulas move like Excel's (relative references shift, $ stays).
      // A single copied cell fills the whole target range.
      if (!clip) break;
      const src = clip;
      const h = src.inputs.length, w = src.inputs[0].length;
      const t = m.target as { c0: number; r0: number; c1: number; r1: number };
      const fill = h === 1 && w === 1;
      const rows = fill ? t.r1 - t.r0 + 1 : h, cols = fill ? t.c1 - t.c0 + 1 : w;
      const cells: [number, number, string][] = [];
      for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
        const si = fill ? 0 : i, sj = fill ? 0 : j;
        const tc = t.c0 + j, tr = t.r0 + i;
        cells.push([tc, tr, shiftFormula(src.inputs[si][sj], src.c0 + sj, src.r0 + si, tc, tr)]);
      }
      beginBatch(cells, { col: t.c0, row: t.r0 }, "paste", true);
      break;
    }
    case "inspect": {
      // Read-only, so it is safe while an edit is paused between slices.
      const { col, row } = m;
      const pre = sheet.precedents(col, row);
      const dep = sheet.dependents(col, row, 400);
      let reads = pre.refs.length;
      for (const g of pre.ranges) reads += (g.c1 - g.c0 + 1) * Math.max(0, g.r1 - g.r0 + 1);
      post({ type: "inspect", id: m.id, col, row, input: sheet.getInput(col, row), display: sheet.display(col, row), pre, dep, reads });
      break;
    }
    case "bench": {
      settle();
      // The same edits as bench/engine.ts, in this browser's engine. Small edits are timed as a batch
      // of 50 and divided, because one of them is near the timer resolution. Inputs are restored after.
      const orders = sheet.rows - 1, mid = orders >> 1;
      const cases: [string, number, number, number, (i: number) => string][] = [
        ["Units, last row", 2, orders, 50, (i) => String(3 + (i % 9))],
        ["Region, middle row (SUMIF only)", 1, mid, 50, (i) => ["North", "South", "East", "West"][i % 4]],
        ["Units, middle row (half the chain)", 2, mid, 1, (i) => String(3 + (i % 9))],
        ["Units, row 2 (whole chain)", 2, 1, 1, (i) => String(3 + (i % 9))],
        ["Tax rate K2 (every formula)", 10, 1, 1, (i) => String(0.05 + (i % 9) / 100)],
      ];
      const results = cases.map(([label, col, row, batch, val]) => {
        const before = sheet.getInput(col, row);
        const ms: number[] = [];
        let recomputed = 0;
        for (let round = 0; round < 7; round++) {
          const t = performance.now();
          for (let i = 0; i < batch; i++) recomputed = sheet.setInput(col, row, val(round * batch + i)).recomputed;
          ms.push((performance.now() - t) / batch);
        }
        sheet.setInput(col, row, before);
        ms.sort((a, b) => a - b);
        return { label, median: ms[3], best: ms[0], recomputed };
      });
      const t = performance.now();
      const full = sheet.recalcAll();
      syncStrings();
      post({ type: "bench", results, full: { ms: performance.now() - t, recomputed: full.recomputed }, epoch: sheet.epoch });
      break;
    }
  }
}
