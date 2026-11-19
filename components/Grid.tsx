"use client";

// Engine harness for the spike. The grid is one canvas. Scrolling is our own (no 26M px spacer div),
// the worker sends only the visible window, and numbers draw from a tabular glyph atlas.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewReply } from "@/engine/worker";
import { formatNumber, type NumFormat } from "@/engine/format";
import { lockAxis, newAxisState } from "./axis-lock";
import { Cancelled, runPilot, type PilotApi } from "./autopilot";

const ERRS = ["#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#CYCLE!"];
type SharedCol = { v: Float64Array; t: Uint8Array; f: Int32Array | null; st: Uint8Array | null; stamp: Uint32Array | null };

const ORDERS = 1_000_000;
const ROW_H = 26;
const HEAD_H = 26;
const RHDR_W = 76;
// Column layout. The ledger has fixed widths; an imported file brings its own (auto-fit).
const LEDGER_W = [80, 76, 62, 92, 116, 100, 116, 136, 24, 112, 140, 40];
let COL_W: number[] = [];
let COL_X: number[] = [];
let TOTAL_W = 0;
function setColumns(widths: number[]) {
  COL_W = widths;
  COL_X = [];
  let x = 0;
  for (const w of widths) { COL_X.push(x); x += w; }
  TOTAL_W = x;
}
setColumns(LEDGER_W);
const OVERSCAN = 48;
const FADE_MS = 1100;
const LAND_MS = 1400; // the outline on the cell an edit just wrote

// Themes. The canvas reads C; the bars read the same values as CSS variables.
export type GridTheme = {
  name: string;
  bg: string; line: string; headBg: string; headText: string; headSel: string;
  text: string; muted: string; accent: string; accentRgb: string; onAccent: string;
  error: string; frozenLine: string; skeleton: string; font: string; mono: string;
};
const SF = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
export const THEMES: Record<"numbers" | "ink", GridTheme> = {
  numbers: {
    name: "numbers", bg: "#ffffff", line: "#ebebed", headBg: "#f9f9fa", headText: "#8a8a8e", headSel: "#1d1d1f",
    text: "#1d1d1f", muted: "#6e6e73", accent: "#0a6cff", accentRgb: "10,108,255", onAccent: "#ffffff",
    error: "#d70015", frozenLine: "#d2d2d7", skeleton: "#f2f2f4", font: SF, mono: 'ui-monospace, "SF Mono", Menlo, monospace',
  },
  ink: {
    name: "ink", bg: "#0a0a0b", line: "#1c1c1f", headBg: "#0e0e10", headText: "#636366", headSel: "#f5f5f7",
    text: "#ededf0", muted: "#7c7c80", accent: "#f5f5f7", accentRgb: "245,245,247", onAccent: "#0a0a0b",
    error: "#ff453a", frozenLine: "#2c2c30", skeleton: "#161618", font: SF, mono: 'ui-monospace, "SF Mono", Menlo, monospace',
  },
};
const C: GridTheme = { ...THEMES.numbers };
let FONT = `13px ${C.font}`;
let FONT_HEAD = `500 11px ${C.font}`;
let FONT_BOLD = `600 13px ${C.font}`;
function applyTheme(t: GridTheme) {
  Object.assign(C, t);
  FONT = `13px ${t.font}`;
  FONT_HEAD = `500 11px ${t.font}`;
  FONT_BOLD = `600 13px ${t.font}`;
}
const tint = (a: number) => `rgba(${C.accentRgb},${a})`;

// A, B, … Z, AA, AB, …
const colName = (c: number) => { let s = ""; for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const cellName = (c: number, r: number) => colName(c) + (r + 1);
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
// A duration with its unit. Sub-millisecond edits show in microseconds.
const fmtDur = (ms: number) => (ms < 1 ? `${Math.max(1, Math.round(ms * 1000))} µs` : ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`);

type Inspect = {
  id: number; col: number; row: number; input: string; display: string; reads: number;
  pre: { refs: { col: number; row: number }[]; ranges: { c0: number; c1: number; r0: number; r1: number }[] };
  dep: { count: number; cells: { col: number; row: number }[] };
};
type Ready = { rows: number; buildMs: number; recalcMs: number; cells: number; formulas: number; typedArrayMB: number; epoch: number };
type Edited = { col: number; row: number; recomputed: number; ms: number; computeMs: number; slices: number; epoch: number; cycles: number; kind: "edit" | "undo" | "redo" | "paste" | "clear"; count?: number };
type Bench = { results: { label: string; median: number; best: number; recomputed: number }[]; full: { ms: number; recomputed: number } };

// Tabular digits: SF Pro digits are proportional, and canvas has no font-variant-numeric.
// Each glyph is drawn once into an atlas; digits get one shared advance.
function buildAtlas(dpr: number) {
  const chars = "0123456789.,-+%e";
  const m = document.createElement("canvas").getContext("2d")!;
  m.font = FONT;
  const digit = Math.max(...[..."0123456789"].map((d) => m.measureText(d).width));
  const adv: Record<string, number> = {};
  const sx: Record<string, number> = {};
  let x = 0;
  for (const ch of chars) {
    adv[ch] = /[0-9]/.test(ch) ? digit : m.measureText(ch).width;
    sx[ch] = x;
    x += Math.ceil(adv[ch]) + 2;
  }
  const h = ROW_H;
  const cv = document.createElement("canvas");
  cv.width = Math.ceil(x * dpr);
  cv.height = h * dpr;
  const g = cv.getContext("2d")!;
  g.scale(dpr, dpr);
  g.font = FONT;
  g.fillStyle = C.text;
  g.textBaseline = "middle";
  g.textAlign = "center";
  for (const ch of chars) g.fillText(ch, sx[ch] + adv[ch] / 2, h / 2 + 0.5);
  return { cv, adv, sx, h, dpr, color: C.text };
}

// Width of text in the cell font, for growing the in-cell editor.
let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(t: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d")!;
  measureCtx.font = FONT;
  return measureCtx.measureText(t).width;
}

// References in formula text (A1, $B$2, C3:D9, G:G), for outlining them while the user types.
function refsIn(text: string, rows: number): { c0: number; c1: number; r0: number; r1: number }[] {
  const out: { c0: number; c1: number; r0: number; r1: number }[] = [];
  const col = (x: string) => x.replace(/\$/g, "").toUpperCase().split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const noStrings = text.replace(/"[^"]*"?/g, (m) => " ".repeat(m.length));
  const re = /(\$?[A-Za-z]{1,2}\$?\d+)(?::(\$?[A-Za-z]{1,2}\$?\d+))?|(\$?[A-Za-z]{1,2}):(\$?[A-Za-z]{1,2})(?![\w(])/g;
  for (let m; (m = re.exec(noStrings)); ) {
    const before = noStrings[m.index - 1];
    if (before && /[A-Za-z0-9_]/.test(before)) continue; // part of a name like SUMIF
    if (m[3]) {
      const a = col(m[3]), b = col(m[4]);
      out.push({ c0: Math.min(a, b), c1: Math.max(a, b), r0: 0, r1: rows - 1 });
      continue;
    }
    const p = (x: string) => { const mm = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(x)!; return { c: col(mm[1]), r: parseInt(mm[2], 10) - 1 }; };
    const a = p(m[1]), b = m[2] ? p(m[2]) : a;
    out.push({ c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c), r0: Math.min(a.r, b.r), r1: Math.min(rows - 1, Math.max(a.r, b.r)) });
  }
  return out.filter((g) => g.c0 >= 0 && g.c1 < COL_W.length && g.r0 >= 0 && g.r0 < rows);
}

type GridProps = {
  theme?: GridTheme;
  orders?: number;
  // app: the full demo page. embed: a hero window with no Try strip and no benchmark controls.
  variant?: "app" | "embed";
  // Embed only: change the tax rate every few seconds until the visitor touches the grid.
  autoplay?: boolean;
  title?: string;
  // App only: a link back to the landing page, shown before the title.
  home?: { href: string; label: string };
};

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl+";

// F4, as in Excel: cycle the reference at the caret through A1 → $A$1 → A$1 → $A1 → A1.
function cycleAnchor(text: string, caret: number): { text: string; caret: number } | null {
  const re = /\$?[A-Za-z]{1,3}\$?\d+/g;
  for (let m; (m = re.exec(text)); ) {
    const a = m.index, b = a + m[0].length;
    if (caret < a || caret > b) continue;
    if (a > 0 && /[A-Za-z0-9_]/.test(text[a - 1])) continue; // part of a function name
    const p = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(m[0])!;
    const states = [[false, false], [true, true], [false, true], [true, false]];
    const i = states.findIndex(([c, r]) => c === (p[1] === "$") && r === (p[3] === "$"));
    const [c, r] = states[(i + 1) % 4];
    const ref = `${c ? "$" : ""}${p[2].toUpperCase()}${r ? "$" : ""}${p[4]}`;
    return { text: text.slice(0, a) + ref + text.slice(b), caret: a + ref.length };
  }
  return null;
}

// "K5", "$K$5", "k5", or the first cell of "K5:M9" → { col, row } (zero-based), or null.
function parseCellRef(t: string): { col: number; row: number } | null {
  const m = /^\s*\$?([A-Za-z]{1,3})\$?(\d+)(?::.*)?\s*$/.exec(t);
  if (!m) return null;
  const col = m[1].toUpperCase().split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const row = parseInt(m[2], 10) - 1;
  return row >= 0 ? { col, row } : null;
}

// Clipboard text, as Excel and Sheets write it: tabs between cells, newlines between rows, and
// quotes around a cell that holds a tab, a newline or a quote.
function toTSV(rows: string[][]): string {
  return rows.map((r) => r.map((v) => (/[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join("\t")).join("\n");
}
function fromTSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", i = 0, quoted = false;
  const t = text.replace(/\r\n?/g, "\n");
  while (i < t.length) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === "") { quoted = true; i++; continue; }
    if (ch === "\t") { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; continue; }
    cell += ch; i++;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const MAX_COPY = 200_000; // cells; a bigger block would freeze the page while it is formatted

// A name that truncates in the middle, like Finder: "6-LATER-rest-ea…batch-2.csv". The end of the
// name and its extension stay readable; the start gives way first.
function MiddleName({ text }: { text: string }) {
  const keep = Math.min(14, Math.max(0, text.length - 8));
  if (text.length <= 22) return <span className="name">{text}</span>;
  return (
    <span className="name split">
      <span className="head">{text.slice(0, text.length - keep)}</span>
      <span className="tail">{text.slice(text.length - keep)}</span>
    </span>
  );
}

export default function Grid({ theme = THEMES.numbers, orders = ORDERS, variant = "app", autoplay = false, title = "Sales ledger", home }: GridProps) {
  applyTheme(theme);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const vThumbRef = useRef<HTMLDivElement>(null);
  const hThumbRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);

  // Mutable render state. React state is only for the bars.
  const s = useRef({
    rows: 0, scrollX: 0, scrollY: 0, w: 0, h: 0, dpr: 1,
    body: null as ViewReply | null, head: null as ViewReply | null,
    reqId: 0, inflight: false, pending: false, wantEpoch: 0,
    sel: { col: 0, row: 1 }, inspect: null as Inspect | null,
    editAt: -1e9, editEpoch: -1, raf: 0, atlas: null as ReturnType<typeof buildAtlas> | null,
    drawMs: 0, heat: true, arrows: true,
    editing: false, // true once the user types; an inspect reply never overwrites their text
    frames: 0, missFrames: 0, // frames that drew rows the worker had not sent yet
    vel: 0, vFirst: 0, vT: 0, // scroll speed in rows per ms, for overscan ahead of the motion
    recalcing: false,
    // In-cell editing, like Excel and Sheets.
    cellEdit: null as { col: number; row: number } | null,
    editMode: "enter" as "enter" | "edit", // enter: started by typing (arrows commit); edit: F2 or double-click (arrows move the caret)
    editText: "",
    point: null as { start: number; end: number } | null, // the reference that pointing inserted, so the next point replaces it
    pointCell: null as { col: number; row: number } | null,
    pendingEdit: false, // a double-click before the cell's input arrived from the worker
    touched: false, // the visitor used the grid: autoplay stops
    piloting: false, // the hero autopilot drives the grid: the selection draws as focused
    pilotStop: null as null | (() => void), // cancels the autopilot and discards its half-typed text
    pilotWait: null as null | (() => void), // resolves when the engine finishes the autopilot's edit
    inView: true, // the grid is on screen: the autopilot pauses when it is not
    gridFocused: false, // the selection draws in the accent only while the grid has focus
    corner: { col: 0, row: 1 }, // the moving end of the range; the active cell (sel) stays put, like Excel
    copied: null as { c0: number; r0: number; c1: number; r1: number } | null, // dashed outline after a copy
    landed: null as { col: number; row: number; at: number } | null, // the cell an edit just wrote: a fading outline
    clipText: "", // what we last put on the clipboard: a paste of exactly this is our own copy
    statsTimer: 0 as unknown as ReturnType<typeof setTimeout>,
    pageScrollAt: 0, wheelLast: 0, gridGesture: false, // embed wheel routing, per gesture
    axis: newAxisState(), // the soft axis lock for wheel scrolling
    // Shared memory: engine columns read directly, no view messages.
    shared: false,
    cols: [] as (SharedCol | undefined)[],
    strs: [] as string[],
    formats: [] as NumFormat[],
    cellFormats: new Map<number, NumFormat>(),
    prevRows: 0, prevCols: [] as (SharedCol | undefined)[], prevStrs: [] as string[], // restored if an import fails
    inspectId: 0,
  }).current;

  const [ready, setReady] = useState<Ready | null>(null);
  const [lastEdit, setLastEdit] = useState<(Edited & { name: string }) | null>(null);
  const [recalcing, setRecalcing] = useState<string | null>(null);
  const [startError, setStartError] = useState(false);
  const [doc, setDoc] = useState<{ kind: "ledger" } | { kind: "csv"; name: string; dataRows: number; dataCols: number; bytes: number; parseMs: number }>({ kind: "ledger" });
  const [loading, setLoading] = useState<{ name: string; pct: number; rows: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [nameText, setNameText] = useState<string | null>(null); // non-null while the name box is being typed in
  const [announce, setAnnounce] = useState("");
  const [gridFocused, setGridFocused] = useState(false);
  const [rangeStats, setRangeStats] = useState<string | null>(null); // "Sum … · Average … · Count …" for a range
  const nameRef = useRef<HTMLInputElement>(null);
  const benchCloseRef = useRef<HTMLButtonElement>(null);
  const keysCloseRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [formula, setFormulaState] = useState("");
  const [cellEdit, setCellEdit] = useState<{ col: number; row: number } | null>(null);
  // The formula bar and the in-cell editor share one text.
  const setFormula = (t: string) => { s.editText = t; setFormulaState(t); };
  const [sel, setSel] = useState(s.sel);
  const [inspect, setInspect] = useState<Inspect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawMs, setDrawMs] = useState(0);
  const [bench, setBench] = useState<Bench | null>(null);
  const [benchBusy, setBenchBusy] = useState(false);
  const [toggles, setToggles] = useState({ heat: true, arrows: true });

  const viewH = () => s.h - HEAD_H - ROW_H; // below the column header and the frozen row 1
  // When the horizontal scrollbar shows, leave room so the last row is not under it.
  const maxY = () => Math.max(0, (s.rows - 1) * ROW_H - viewH() + (maxX() > 0 ? 14 : 0));
  const maxX = () => Math.max(0, TOTAL_W - (s.w - RHDR_W));

  const requestView = useCallback(() => {
    const w = workerRef.current;
    if (!w || !s.rows) return;
    if (s.shared) { redraw(); return; } // the renderer reads engine memory: nothing to fetch
    if (s.inflight) { s.pending = true; return; }
    const first = 1 + Math.floor(s.scrollY / ROW_H);
    const count = Math.ceil(viewH() / ROW_H) + 1;
    // Overscan grows with scroll speed, in the direction of motion (up to 1,500 rows ahead).
    const now = performance.now();
    const v = (first - s.vFirst) / Math.max(1, now - s.vT);
    s.vel = s.vel * 0.5 + v * 0.5;
    s.vFirst = first;
    s.vT = now;
    const lead = Math.round(Math.min(1500, Math.abs(s.vel) * 150));
    const b = s.body;
    if (b && b.epoch === s.wantEpoch && s.head?.epoch === s.wantEpoch && b.r0 <= Math.max(1, first - 8) && b.r1 >= Math.min(s.rows, first + count + 8 + (s.vel > 0 ? lead / 2 : 0))) return;
    s.inflight = true;
    w.postMessage({ type: "view", id: ++s.reqId, r0: Math.max(1, first - OVERSCAN - (s.vel < 0 ? lead : 0)), r1: first + count + OVERSCAN + (s.vel > 0 ? lead : 0) });
    if (s.head?.epoch !== s.wantEpoch) w.postMessage({ type: "view", id: -1, r0: 0, r1: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const draw = useCallback(() => {
    s.raf = 0;
    const cv = canvasRef.current;
    if (!cv || !s.w) return;
    const t0 = performance.now();
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, s.w, s.h);

    const first = 1 + Math.floor(s.scrollY / ROW_H);
    const offY = -(s.scrollY % ROW_H);
    const count = Math.ceil(viewH() / ROW_H) + 1;
    const bodyTop = HEAD_H + ROW_H;
    const heatAlpha = !s.heat ? 0 : s.recalcing ? 1 : Math.max(0, 1 - (performance.now() - s.editAt) / FADE_MS);
    const heatA = heatAlpha * heatAlpha;

    const xOf = (c: number) => RHDR_W + COL_X[c] - s.scrollX;
    // In the frozen pass of the overlays, scrolled rows stop at the frozen row's lower edge, so a
    // cell half under the frozen row cannot draw its border on top of it.
    let clampBody = false;
    const yOf = (r: number) => {
      if (r === 0) return HEAD_H;
      const y = bodyTop + (r - first) * ROW_H + offY;
      return clampBody ? Math.max(bodyTop, y) : y;
    };
    if (!s.atlas || s.atlas.color !== C.text) s.atlas = buildAtlas(s.dpr);
    const atlas = s.atlas;
    s.frames++;
    if (!s.shared && (!s.body || s.body.r0 > first || s.body.r1 < Math.min(s.rows, first + count))) s.missFrames++;
    (window as unknown as { __grid: object }).__grid = { frames: s.frames, missFrames: s.missFrames, drawMs: s.drawMs, scrollX: s.scrollX, scrollY: s.scrollY };

    const drawNumber = (text: string, right: number, y: number) => {
      let x = right;
      for (let i = text.length - 1; i >= 0; i--) {
        const ch = text[i];
        const a = atlas.adv[ch];
        if (a === undefined) { ctx.fillStyle = C.text; ctx.textAlign = "right"; ctx.fillText(text.slice(0, i + 1), x, y + ROW_H / 2 + 0.5); return; }
        x -= a;
        const sw = Math.ceil(a);
        ctx.drawImage(atlas.cv, atlas.sx[ch] * atlas.dpr, 0, sw * atlas.dpr, atlas.h * atlas.dpr, x, y, sw, atlas.h);
      }
    };

    const drawRowShared = (r: number, y: number, bold: boolean) => {
      for (let c = 0; c < COL_W.length; c++) {
        const x = xOf(c), w = COL_W[c];
        if (x + w < RHDR_W || x > s.w) continue;
        const col = s.cols[c];
        if (!col) continue;
        if (heatA > 0 && col.stamp && col.stamp[r] === s.editEpoch) {
          ctx.fillStyle = tint(+(0.2 * heatA).toFixed(3));
          ctx.fillRect(x, y, w, ROW_H);
        }
        const tag = col.t[r];
        if (tag === 0) continue;
        const val = col.v[r];
        const text = tag === 1 ? formatNumber(val, s.cellFormats.get(c * s.rows + r) ?? s.formats[c] ?? "general")
          : tag === 2 ? (s.strs[val] ?? "") : tag === 3 ? (val ? "TRUE" : "FALSE") : ERRS[val];
        if (!text) continue;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, ROW_H);
        ctx.clip();
        // A stale cell: a running recalc has not reached it yet.
        if (col.st && col.st[r] !== 0) ctx.globalAlpha = 0.3;
        if (tag === 1) drawNumber(text, x + w - 8, y);
        else {
          ctx.font = bold ? FONT_BOLD : FONT;
          ctx.fillStyle = tag === 4 ? C.error : C.text;
          ctx.textAlign = tag === 3 || tag === 4 ? "center" : "left";
          ctx.fillText(text, tag === 3 || tag === 4 ? x + w / 2 : x + 8, y + ROW_H / 2 + 0.5);
        }
        ctx.restore();
      }
    };

    const drawRow = (v: ViewReply | null, r: number, y: number, bold: boolean) => {
      if (s.shared) { drawRowShared(r, y, bold); return; }
      if (!v || r < v.r0 || r >= v.r1) {
        // Not sent by the worker yet: a quiet placeholder instead of an empty row.
        ctx.fillStyle = C.skeleton;
        for (let c = 0; c < COL_W.length; c++) {
          const x = xOf(c), w = COL_W[c];
          if (x + w < RHDR_W || x > s.w || w < 30) continue;
          const bw = Math.round(w * 0.45);
          ctx.beginPath();
          ctx.roundRect(c === 1 ? x + 8 : x + w - 8 - bw, y + ROW_H / 2 - 4, bw, 8, 4);
          ctx.fill();
        }
        return;
      }
      const base = (r - v.r0) * v.cols;
      for (let c = 0; c < v.cols; c++) {
        const x = xOf(c), w = COL_W[c];
        if (x + w < RHDR_W || x > s.w) continue;
        const k = base + c;
        if (heatA > 0 && (v.flags[k] & 2) && v.epoch === s.editEpoch) {
          ctx.fillStyle = tint(+(0.2 * heatA).toFixed(3));
          ctx.fillRect(x, y, w, ROW_H);
        }
        const text = v.texts[k];
        if (!text) continue;
        const tag = v.tags[k];
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, ROW_H);
        ctx.clip();
        // A stale cell: a running recalc has not reached it yet.
        if (v.flags[k] & 4) ctx.globalAlpha = 0.3;
        if (tag === 1) drawNumber(text, x + w - 8, y);
        else {
          ctx.font = bold ? FONT_BOLD : FONT;
          ctx.fillStyle = tag === 4 ? C.error : C.text;
          ctx.textAlign = tag === 3 || tag === 4 ? "center" : "left";
          ctx.fillText(text, tag === 3 || tag === 4 ? x + w / 2 : x + 8, y + ROW_H / 2 + 0.5);
        }
        ctx.restore();
      }
    };

    ctx.textBaseline = "middle";
    ctx.font = FONT;
    // Body rows, clipped under the frozen row.
    ctx.save();
    ctx.beginPath();
    ctx.rect(RHDR_W, bodyTop, s.w - RHDR_W, s.h - bodyTop);
    ctx.clip();
    for (let i = 0; i < count; i++) {
      const r = first + i;
      if (r >= s.rows) break;
      drawRow(s.body, r, bodyTop + i * ROW_H + offY, false);
    }
    // Grid lines.
    ctx.fillStyle = C.line;
    for (let i = 0; i <= count; i++) ctx.fillRect(RHDR_W, Math.round(bodyTop + i * ROW_H + offY) - 0.5, s.w, 1);
    for (let c = 0; c <= COL_W.length; c++) ctx.fillRect(Math.round(c < COL_W.length ? xOf(c) : xOf(c - 1) + COL_W[c - 1]) - 0.5, bodyTop, 1, s.h);
    ctx.restore();

    // Frozen row 1 (the ledger's header row).
    ctx.save();
    ctx.beginPath();
    ctx.rect(RHDR_W, HEAD_H, s.w - RHDR_W, ROW_H);
    ctx.clip();
    ctx.fillStyle = C.bg;
    ctx.fillRect(RHDR_W, HEAD_H, s.w, ROW_H);
    drawRow(s.head, 0, HEAD_H, true);
    ctx.fillStyle = C.line;
    for (let c = 0; c < COL_W.length; c++) ctx.fillRect(Math.round(xOf(c)) - 0.5, HEAD_H, 1, ROW_H);
    ctx.restore();
    ctx.fillStyle = C.frozenLine;
    ctx.fillRect(0, bodyTop - 1, s.w, 1);

    // Overlays: precedents, dependents, selection.
    const ins = s.inspect;
    const visible = (r: number) => r === 0 || (r >= first && r < first + count);
    const rectOf = (c: number, r: number) => ({ x: xOf(c), y: yOf(r), w: COL_W[c], h: ROW_H });
    // Two passes: the scrolling body, then the frozen row. One clip for both let a cell scrolled
    // half under the frozen row draw its border over it.
    let landA = 0;
    for (const frozenPass of [false, true]) {
    clampBody = frozenPass;
    ctx.save();
    ctx.beginPath();
    if (frozenPass) ctx.rect(RHDR_W, HEAD_H, s.w - RHDR_W, ROW_H);
    else ctx.rect(RHDR_W, bodyTop, s.w - RHDR_W, s.h - bodyTop);
    ctx.clip();
    const sr = rectOf(s.sel.col, s.sel.row);
    if (s.cellEdit && s.editText.startsWith("=")) {
      // While a formula is typed, outline every cell and range it names, like Sheets.
      ctx.strokeStyle = C.accent;
      ctx.fillStyle = tint(0.07);
      for (const g of refsIn(s.editText, s.rows)) {
        const top = Math.max(g.r0, first), bot = Math.min(g.r1, first + count);
        const frozen = g.r0 === 0;
        if (bot < top && !frozen) continue;
        const x0 = xOf(g.c0), x1 = xOf(g.c1) + COL_W[g.c1];
        const y0 = frozen ? HEAD_H : yOf(top);
        const y1 = g.r1 === 0 ? HEAD_H + ROW_H : g.r1 >= first + count ? s.h : yOf(bot) + ROW_H;
        if (g.r0 !== g.r1 || g.c0 !== g.c1) ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.lineWidth = 1.5;
        ctx.setLineDash(g.r0 !== g.r1 || g.c0 !== g.c1 ? [4, 3] : []);
        ctx.strokeRect(x0 + 1, y0 + 1, x1 - x0 - 2, y1 - y0 - 2);
      }
      ctx.setLineDash([]);
    } else if (s.arrows && ins && ins.col === s.sel.col && ins.row === s.sel.row && s.corner.col === s.sel.col && s.corner.row === s.sel.row) {
      // Trace arrows only for a single cell: over a block they are clutter, as in Excel.
      ctx.strokeStyle = C.accent;
      ctx.fillStyle = tint(0.06);
      ctx.lineWidth = 1;
      for (const g of ins.pre.ranges) {
        const top = Math.max(g.r0, g.r0 === 0 ? 0 : first), bot = Math.min(g.r1, first + count);
        if (bot < top && !(g.r0 === 0)) continue;
        const x0 = xOf(g.c0), x1 = xOf(g.c1) + COL_W[g.c1];
        const y0 = g.r0 === 0 ? HEAD_H : yOf(Math.max(g.r0, first));
        const y1 = g.r1 >= first + count ? s.h : yOf(Math.min(g.r1, first + count)) + ROW_H;
        if (g.r1 < first && g.r0 !== 0) continue;
        ctx.fillStyle = tint(0.06);
        ctx.strokeStyle = C.accent;
        ctx.lineWidth = 1;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
        ctx.setLineDash([]);
        // Label: the range size, so a whole-column read is obvious.
        const n = (g.c1 - g.c0 + 1) * (g.r1 - g.r0 + 1);
        const whole = g.r0 === 0 && g.r1 === s.rows - 1;
        const label = (whole ? `${colName(g.c0)}:${colName(g.c1)}` : `${colName(g.c0)}${g.r0 + 1}:${colName(g.c1)}${g.r1 + 1}`) + ` · ${n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : fmtInt(n)}`;
        ctx.font = FONT_HEAD;
        const lw = ctx.measureText(label).width + 12;
        const ly = Math.max(y0 + 4, bodyTop + 4);
        ctx.fillStyle = C.accent;
        ctx.beginPath();
        ctx.roundRect(x0 + 4, ly, lw, 18, 9);
        ctx.fill();
        ctx.fillStyle = C.onAccent;
        ctx.textAlign = "left";
        ctx.fillText(label, x0 + 10, ly + 9.5);
        // Arrow from the range edge to the selected cell.
        arrow(ctx, x1, Math.min(Math.max(sr.y + ROW_H / 2, y0 + 10), y1 - 10), sr.x, sr.y + ROW_H / 2);
      }
      for (const p of ins.pre.refs) {
        if (!visible(p.row)) continue;
        const rr = rectOf(p.col, p.row);
        ctx.strokeStyle = C.accent;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(rr.x + 1, rr.y + 1, rr.w - 2, rr.h - 2);
        arrow(ctx, rr.x + rr.w / 2, rr.y + rr.h / 2, sr.x + sr.w / 2, sr.y + sr.h / 2);
      }
      // Dependents: a small corner mark, so a cell that feeds 1M rows does not flood the view.
      ctx.fillStyle = C.accent;
      for (const d of ins.dep.cells) {
        if (!visible(d.row)) continue;
        const rr = rectOf(d.col, d.row);
        ctx.beginPath();
        ctx.moveTo(rr.x + rr.w - 7, rr.y + 1);
        ctx.lineTo(rr.x + rr.w - 1, rr.y + 1);
        ctx.lineTo(rr.x + rr.w - 1, rr.y + 7);
        ctx.closePath();
        ctx.fill();
      }
    }
    // The selected range: a light fill and a hairline, the active cell keeps its thick border.
    const blockRect = (g: { c0: number; r0: number; c1: number; r1: number }) => {
      if (g.r1 > 0 && g.r1 < first && g.r0 > 0) return null;
      if (g.r0 > 0 && g.r0 >= first + count) return null;
      const x0 = xOf(g.c0), x1 = xOf(g.c1) + COL_W[g.c1];
      const y0 = g.r0 === 0 ? HEAD_H : yOf(Math.max(g.r0, first));
      const y1 = g.r1 === 0 ? HEAD_H + ROW_H : g.r1 >= first + count ? s.h + 4 : yOf(g.r1) + ROW_H;
      return { x0, y0, x1, y1 };
    };
    const g = rangeOf();
    if (g.c0 !== g.c1 || g.r0 !== g.r1) {
      const b = blockRect(g);
      if (b) {
        ctx.fillStyle = tint(s.gridFocused || s.piloting ? 0.08 : 0.05);
        ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        ctx.strokeStyle = s.gridFocused || s.piloting ? C.accent : C.muted;
        ctx.lineWidth = 1;
        ctx.strokeRect(b.x0 + 0.5, b.y0 + 0.5, b.x1 - b.x0 - 1, b.y1 - b.y0 - 1);
      }
    }
    if (s.copied) {
      // The copied block keeps a dashed outline until the next edit or Esc, like Excel.
      const b = blockRect(s.copied);
      if (b) {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = C.accent;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(b.x0 + 1, b.y0 + 1, b.x1 - b.x0 - 2, b.y1 - b.y0 - 2);
        ctx.setLineDash([]);
      }
    }
    // The cell an edit just wrote keeps a fading outline, so the eye can follow it after Return moves down.
    if (s.landed) {
      landA = Math.max(0, 1 - (performance.now() - s.landed.at) / LAND_MS);
      const L = s.landed;
      if (landA <= 0) s.landed = null;
      else if (visible(L.row) && !(L.col === s.sel.col && L.row === s.sel.row)) {
        const lr = rectOf(L.col, L.row);
        ctx.fillStyle = tint(+(0.1 * landA).toFixed(3));
        ctx.fillRect(lr.x, lr.y, lr.w, lr.h);
        ctx.strokeStyle = C.accent;
        ctx.globalAlpha = landA;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(lr.x + 1, lr.y + 1, lr.w - 2, lr.h - 2);
        ctx.globalAlpha = 1;
      }
    }
    if (visible(s.sel.row)) {
      ctx.strokeStyle = s.gridFocused || s.piloting || s.cellEdit ? C.accent : C.muted;
      ctx.lineWidth = 2;
      ctx.strokeRect(sr.x + 1, sr.y + 1, sr.w - 2, sr.h - 2);
    }
    ctx.restore();
    }
    clampBody = false;
    const g = rangeOf(); // the header highlights below read the selected block too

    // Column header.
    ctx.fillStyle = C.headBg;
    ctx.fillRect(0, 0, s.w, HEAD_H);
    ctx.font = FONT_HEAD;
    ctx.textAlign = "center";
    ctx.save();
    ctx.beginPath();
    ctx.rect(RHDR_W, 0, s.w - RHDR_W, HEAD_H);
    ctx.clip();
    for (let c = 0; c < COL_W.length; c++) {
      const x = xOf(c);
      if (x + COL_W[c] < RHDR_W || x > s.w) continue;
      const inCols = c >= g.c0 && c <= g.c1;
      if (inCols) { ctx.fillStyle = tint(0.08); ctx.fillRect(x, 0, COL_W[c], HEAD_H); }
      ctx.fillStyle = inCols ? C.headSel : C.headText;
      ctx.fillText(colName(c), x + COL_W[c] / 2, HEAD_H / 2 + 0.5);
      ctx.fillStyle = C.line;
      ctx.fillRect(Math.round(x) - 0.5, 6, 1, HEAD_H - 12);
    }
    ctx.restore();
    // Row header.
    ctx.fillStyle = C.headBg;
    ctx.fillRect(0, HEAD_H, RHDR_W, s.h);
    ctx.textAlign = "right";
    const rowLabel = (r: number, y: number) => {
      const inRows = r >= g.r0 && r <= g.r1;
      if (inRows) { ctx.fillStyle = tint(0.08); ctx.fillRect(0, y, RHDR_W - 1, ROW_H); }
      ctx.fillStyle = inRows ? C.headSel : C.headText;
      ctx.fillText(fmtInt(r + 1), RHDR_W - 10, y + ROW_H / 2 + 0.5);
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, bodyTop, RHDR_W, s.h);
    ctx.clip();
    for (let i = 0; i < count; i++) if (first + i < s.rows) rowLabel(first + i, bodyTop + i * ROW_H + offY);
    ctx.restore();
    rowLabel(0, HEAD_H);
    ctx.fillStyle = C.frozenLine;
    ctx.fillRect(0, HEAD_H - 1, s.w, 1);
    ctx.fillRect(RHDR_W - 1, 0, 1, s.h);
    ctx.fillRect(0, bodyTop - 1, RHDR_W, 1);

    // Scroll thumbs.
    const vh = viewH();
    const contentH = (s.rows - 1) * ROW_H;
    const vt = vThumbRef.current;
    if (vt) {
      const track = s.h - bodyTop - 8;
      const th = Math.max(32, track * Math.min(1, vh / contentH));
      vt.style.height = `${th}px`;
      vt.style.transform = `translateY(${bodyTop + 4 + (maxY() ? (s.scrollY / maxY()) * (track - th) : 0)}px)`;
    }
    const ht = hThumbRef.current;
    if (ht) {
      const track = s.w - RHDR_W - 16;
      const show = maxX() > 0;
      ht.style.display = show ? "block" : "none";
      if (show) {
        const tw = Math.max(32, track * ((s.w - RHDR_W) / TOTAL_W));
        ht.style.width = `${tw}px`;
        ht.style.transform = `translateX(${RHDR_W + 4 + (s.scrollX / maxX()) * (track - tw)}px)`;
      }
    }

    const ed = editorRef.current;
    if (ed && s.cellEdit) {
      const ce = s.cellEdit;
      const vis = visible(ce.row) && xOf(ce.col) + COL_W[ce.col] > RHDR_W && xOf(ce.col) < s.w;
      ed.style.visibility = vis ? "visible" : "hidden";
      ed.style.transform = `translate(${xOf(ce.col)}px, ${yOf(ce.row)}px)`;
      ed.style.width = `${Math.max(COL_W[ce.col], Math.min(s.w - xOf(ce.col) - 8, textWidth(s.editText) + 20))}px`;
    }
    // The autopilot types into an editor without focus, so the browser draws no caret. Draw one.
    const caret = caretRef.current;
    if (caret) {
      const on = !!(s.piloting && s.cellEdit && visible(s.cellEdit.row));
      caret.classList.toggle("on", on);
      if (on) caret.style.transform = `translate(${xOf(s.cellEdit!.col) + 9 + textWidth(s.editText)}px, ${yOf(s.cellEdit!.row) + 6}px)`;
    }

    s.drawMs = s.drawMs * 0.9 + (performance.now() - t0) * 0.1;
    if (heatA > 0 || landA > 0) s.raf = requestAnimationFrame(draw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const redraw = useCallback(() => { if (!s.raf) s.raf = requestAnimationFrame(draw); }, [draw, s]);

  const scrollTo = useCallback((x: number, y: number) => {
    s.scrollX = Math.min(Math.max(0, x), maxX());
    s.scrollY = Math.min(Math.max(0, y), maxY());
    requestView();
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redraw, requestView]);

  const select = useCallback((col: number, row: number) => {
    col = Math.min(Math.max(0, col), COL_W.length - 1);
    row = Math.min(Math.max(0, row), s.rows - 1);
    s.sel = { col, row };
    s.corner = { col, row };
    scheduleStats();
    s.pendingEdit = false;
    setSel(s.sel);
    setError(null);
    s.editing = false;
    setFormula(s.inspect && s.inspect.col === col && s.inspect.row === row ? s.inspect.input : "");
    // Keep the cell in view. Not before the grid has a size: with a 0x0 viewport the arithmetic
    // below scrolls to nonsense (the hero once opened 156 px right and 78 px down).
    if (s.w > 0 && s.h > 0 && row > 0) {
      const top = (row - 1) * ROW_H, vh = viewH();
      if (top < s.scrollY) scrollTo(s.scrollX, top);
      else if (top + ROW_H > s.scrollY + vh) scrollTo(s.scrollX, top + ROW_H - vh);
    }
    const left = COL_X[col], vw = s.w - RHDR_W;
    if (s.w > 0 && s.h > 0) {
      if (left < s.scrollX) scrollTo(left, s.scrollY);
      else if (left + COL_W[col] > s.scrollX + vw) scrollTo(left + COL_W[col] - vw, s.scrollY);
    }
    workerRef.current?.postMessage({ type: "inspect", id: ++s.inspectId, col, row });
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redraw, scrollTo]);

  // The selected block: from the active cell to the moving corner.
  const rangeOf = () => ({
    c0: Math.min(s.sel.col, s.corner.col), c1: Math.max(s.sel.col, s.corner.col),
    r0: Math.min(s.sel.row, s.corner.row), r1: Math.max(s.sel.row, s.corner.row),
  });

  // Shift-arrows, Shift-click and drags move the corner; the active cell and the formula bar stay.
  const extendTo = (col: number, row: number) => {
    col = Math.min(Math.max(0, col), COL_W.length - 1);
    row = Math.min(Math.max(0, row), s.rows - 1);
    s.corner = { col, row };
    if (s.w > 0 && s.h > 0 && row > 0) {
      const top = (row - 1) * ROW_H, vh = viewH();
      if (top < s.scrollY) scrollTo(s.scrollX, top);
      else if (top + ROW_H > s.scrollY + vh) scrollTo(s.scrollX, top + ROW_H - vh);
    }
    if (s.w > 0) {
      const left = COL_X[col], vw = s.w - RHDR_W;
      if (left < s.scrollX) scrollTo(left, s.scrollY);
      else if (left + COL_W[col] > s.scrollX + vw) scrollTo(left + COL_W[col] - vw, s.scrollY);
    }
    scheduleStats();
    redraw();
  };

  // What a cell shows, read straight from engine memory (shared mode).
  const textAt = (c: number, r: number): string => {
    const col = s.cols[c];
    if (!col) return "";
    const tag = col.t[r], val = col.v[r];
    if (tag === 0) return "";
    if (tag === 1) return formatNumber(val, s.cellFormats.get(c * s.rows + r) ?? s.formats[c] ?? "general");
    if (tag === 2) return s.strs[val] ?? "";
    if (tag === 3) return val ? "TRUE" : "FALSE";
    return ERRS[val] ?? "";
  };

  // Sum, Average and Count for a range, like the Sheets status bar. Read from shared memory on the
  // main thread, debounced so a held Shift-arrow does not add up a million cells on every key.
  function scheduleStats() {
    clearTimeout(s.statsTimer);
    s.statsTimer = setTimeout(() => {
      const g = rangeOf();
      if ((g.c0 === g.c1 && g.r0 === g.r1) || !s.shared) { setRangeStats(null); return; }
      let sum = 0, nums = 0, filled = 0;
      for (let c = g.c0; c <= g.c1; c++) {
        const col = s.cols[c];
        if (!col) continue;
        const t = col.t, v = col.v;
        for (let r = g.r0; r <= g.r1; r++) {
          const tag = t[r];
          if (tag === 0) continue;
          filled++;
          if (tag === 1) { sum += v[r]; nums++; }
        }
      }
      const cells = (g.c1 - g.c0 + 1) * (g.r1 - g.r0 + 1);
      const f = (x: number) => formatNumber(x, Number.isInteger(x) ? "int" : "money");
      setRangeStats(
        `${fmtInt(cells)} cells · ` + (nums ? `Sum ${f(sum)} · Average ${f(sum / nums)} · ` : "") + `Count ${fmtInt(filled)}`,
      );
    }, 90);
  }

  // Worker lifecycle.
  useEffect(() => {
    const w = new Worker(new URL("../engine/worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      switch (m.type) {
        case "column":
          s.cols[m.c] = { v: m.v, t: m.t, f: m.f, st: m.st, stamp: m.stamp };
          break;
        case "strings":
          for (let i = 0; i < m.list.length; i++) s.strs[m.from + i] = m.list[i];
          redraw();
          break;
        case "formats":
          s.formats = m.formats;
          s.cellFormats = new Map(m.cellFormats);
          break;
        case "ready":
          if (variant === "app") requestAnimationFrame(() => wrapRef.current?.focus({ preventScroll: true }));
          s.shared = !!m.shared;
          setColumns(m.widths ?? LEDGER_W);
          setDoc(m.kind === "csv" ? { kind: "csv", name: m.name, dataRows: m.dataRows, dataCols: m.dataCols, bytes: m.bytes, parseMs: m.parseMs } : { kind: "ledger" });
          setLoading(null);
          s.scrollX = 0;
          s.scrollY = 0;
          s.sel = { col: 0, row: 1 };
          s.inspect = null;
          s.body = null;
          s.head = null;
          setLastEdit(null);
          s.rows = m.rows;
          s.wantEpoch = m.epoch;
          setReady(m);
          requestView();
          select(s.sel.col, s.sel.row);
          break;
        case "view": {
          // Test hook: how many views arrived, and how many visible cells were stale in the last one.
          const g = (window as unknown as { __views?: { n: number; stale: number[] } });
          g.__views ??= { n: 0, stale: [] };
          g.__views.n++;
          if (m.id !== -1) { let st = 0; for (let i = 0; i < m.flags.length; i++) if (m.flags[i] & 4) st++; g.__views.stale.push(st); }
        }
          if (m.id === -1) s.head = m;
          else { s.body = m; s.inflight = false; if (s.pending) { s.pending = false; requestView(); } }
          redraw();
          break;
        case "progress":
          // A big edit is running in slices. Pull fresh values so the grid updates in place.
          if (!s.recalcing) { s.recalcing = true; setRecalcing(cellName(m.col, m.row)); }
          s.wantEpoch = m.epoch;
          s.editEpoch = m.epoch;
          s.body = s.body && { ...s.body, epoch: -1 };
          s.head = s.head && { ...s.head, epoch: -1 };
          requestView();
          break;
        case "edited":
          s.recalcing = false;
          setRecalcing(null);
          s.wantEpoch = m.epoch;
          s.editEpoch = m.epoch;
          s.editAt = performance.now();
          setLastEdit({ ...m, name: cellName(m.col, m.row) });
          if (m.kind === "paste" || m.kind === "clear") s.copied = null;
          if (m.kind === "edit") s.landed = { col: m.col, row: m.row, at: performance.now() };
          s.pilotWait?.();
          // An undo or redo shows the cell it changed, like Numbers and Excel.
          if (m.kind === "undo" || m.kind === "redo") select(m.col, m.row);
          s.body = s.body && { ...s.body, epoch: -1 };
          s.head = s.head && { ...s.head, epoch: -1 };
          requestView();
          w.postMessage({ type: "inspect", id: ++s.inspectId, col: s.sel.col, row: s.sel.row });
          break;
        case "editError":
          s.pilotWait?.();
          if (m.quiet) { setError(m.message); break; }
          // Reopen the cell editor with the user's text, so they can fix it.
          select(m.col, m.row);
          startEdit(m.text, "edit");
          setError(`${cellName(m.col, m.row)}: ${m.message}`);
          break;
        case "inspect":
          // Only the latest request counts: an older reply can describe the cell before an edit.
          if (m.id === s.inspectId && m.col === s.sel.col && m.row === s.sel.row) {
            s.inspect = m;
            setInspect(m);
            setAnnounce(`${cellName(m.col, m.row)}, ${m.display || "empty"}${m.input.startsWith("=") ? `, formula ${m.input}` : ""}`);
            if (!s.editing) setFormula(m.input);
            if (s.pendingEdit) { s.pendingEdit = false; startEdit(m.input, "edit"); }
            redraw();
          }
          break;
        case "csvProgress":
          setLoading({ name: m.name, pct: m.total ? m.bytes / m.total : 0, rows: m.rows });
          break;
        case "csvError":
          setLoading(null);
          s.rows = s.prevRows; // the old sheet is still in the worker
          s.cols = s.prevCols;
          s.strs = s.prevStrs;
          setError(`${m.name}: ${m.message}`);
          redraw();
          break;
        case "workerError":
          console.error("worker:", m.message, m.request, m.stack);
          break;
        case "bench":
          setBench(m);
          setBenchBusy(false);
          s.wantEpoch = m.epoch;
          s.body = s.body && { ...s.body, epoch: -1 };
          requestView();
          break;
      }
    };
    // If the worker script is blocked or fails to load (for example a stale cached copy without
    // the COEP header), say so instead of showing "Building…" for ever.
    w.onerror = () => setStartError(true);
    w.postMessage({ type: "init", orders });
    return () => w.terminate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Canvas size.
  useEffect(() => {
    const wrap = wrapRef.current!, cv = canvasRef.current!;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      s.w = wrap.clientWidth;
      s.h = wrap.clientHeight;
      s.dpr = dpr;
      cv.width = Math.round(s.w * dpr);
      cv.height = Math.round(s.h * dpr);
      cv.style.width = `${s.w}px`;
      cv.style.height = `${s.h}px`;
      if (!s.atlas || s.atlas.dpr !== dpr || s.atlas.color !== C.text) s.atlas = buildAtlas(dpr);
      scrollTo(s.scrollX, s.scrollY);
    });
    ro.observe(wrap);
    const id = setInterval(() => setDrawMs(s.drawMs), 300);
    return () => { ro.disconnect(); clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wheel and pointer input.
  useEffect(() => {
    const wrap = wrapRef.current!;
    // Embeds decide per gesture (a run of wheel events less than 160 ms apart), like a map in a page:
    // - the page was at rest for 200 ms when the gesture began: the grid under the pointer scrolls;
    // - the page was still scrolling (or coasting): the page keeps the whole gesture, so a hero
    //   never traps the wheel on the way down.
    // At the top or bottom edge, a vertical gesture passes on to the page, like a nested scroll area.
    // (Pointer-enter is not a usable signal: Chrome fires none when the page scrolls a grid under a
    // still pointer.)
    const onPageScroll = () => { s.pageScrollAt = performance.now(); };
    window.addEventListener("scroll", onPageScroll, { passive: true });
    const onWheel = (e: WheelEvent) => {
      const now = performance.now();
      const fresh = now - s.wheelLast > 160; // a new gesture
      s.wheelLast = now;
      let dx = e.shiftKey ? e.deltaY : e.deltaX;
      let dy = e.shiftKey ? 0 : e.deltaY;
      // Soft axis lock: no sideways drift on a vertical swipe, but a deliberate swipe on the other
      // axis wins within a few events, even through momentum. See axis-lock.ts.
      [dx, dy] = lockAxis(s.axis, dx, dy, fresh);
      if (variant === "embed") {
        if (fresh) s.gridGesture = s.touched || now - s.pageScrollAt > 200;
        if (!s.gridGesture) return;
        if (dx === 0 && ((dy < 0 && s.scrollY <= 0) || (dy > 0 && s.scrollY >= maxY()))) return;
        s.pilotStop?.(); // the visitor scrolls the grid: the autopilot must not scroll it back
      }
      e.preventDefault();
      const k = e.deltaMode === 1 ? ROW_H : e.deltaMode === 2 ? viewH() : 1;
      scrollTo(s.scrollX + dx * k, s.scrollY + dy * k);
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      wrap.removeEventListener("wheel", onWheel);
      window.removeEventListener("scroll", onPageScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cellAt = (clientX: number, clientY: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    if (x < RHDR_W || y < HEAD_H) return null;
    const cx = x - RHDR_W + s.scrollX;
    let col = COL_X.findIndex((x0, i) => cx >= x0 && cx < x0 + COL_W[i]);
    if (col < 0) col = COL_W.length - 1;
    const row = y < HEAD_H + ROW_H ? 0 : 1 + Math.floor((y - HEAD_H - ROW_H + s.scrollY) / ROW_H);
    return { col, row: Math.min(row, s.rows - 1) };
  };

  // ---------- in-cell editing ----------

  const startEdit = (text: string, mode: "enter" | "edit") => {
    s.cellEdit = { ...s.sel };
    s.editMode = mode;
    s.editing = true;
    s.point = null;
    s.pointCell = null;
    setFormula(text);
    setCellEdit(s.cellEdit);
    setError(null);
    // The editor is always mounted, so it takes focus in this same keystroke. Keys typed right
    // after the first one then land in it, not in the grid.
    const ed = editorRef.current!;
    ed.value = text;
    ed.classList.add("open"); // a hidden input cannot take focus, so show it first
    draw(); // places the editor on the cell now, not on the next frame
    ed.focus();
    ed.setSelectionRange(text.length, text.length);
  };

  // Ends the in-cell edit. With `save`, writes the text and moves the selection by (dc, dr).
  const endEdit = (save: boolean, dc = 0, dr = 0) => {
    const ce = s.cellEdit;
    if (!ce) return;
    s.cellEdit = null;
    s.point = null;
    s.pointCell = null;
    setCellEdit(null);
    const ed = editorRef.current;
    if (ed) { ed.classList.remove("open"); ed.style.visibility = ""; }
    s.editing = false;
    if (save) workerRef.current?.postMessage({ type: "edit", col: ce.col, row: ce.row, text: s.editText });
    select(ce.col + dc, ce.row + dr);
    wrapRef.current?.focus();
  };

  // Pointing (clicks and arrow keys insert references) works where a reference can go next:
  // right after "=", "(", ",", an operator, or a reference that pointing just inserted.
  const canPoint = () => {
    const ed = editorRef.current;
    if (!ed || !s.editText.startsWith("=")) return false;
    const caret = ed.selectionStart ?? s.editText.length;
    if (s.point && s.point.end === caret) return true;
    return /[=(,+\-*/^&<>:]\s*$/.test(s.editText.slice(0, caret));
  };

  const insertRef = (ref: string) => {
    const ed = editorRef.current!;
    const caret = ed.selectionStart ?? s.editText.length;
    const [a, b] = s.point && s.point.end === caret ? [s.point.start, s.point.end] : [caret, ed.selectionEnd ?? caret];
    const text = s.editText.slice(0, a) + ref + s.editText.slice(b);
    s.point = { start: a, end: a + ref.length };
    setFormula(text);
    redraw();
    requestAnimationFrame(() => { ed.focus(); ed.setSelectionRange(a + ref.length, a + ref.length); });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.target === editorRef.current) return;
    const cell = cellAt(e.clientX, e.clientY);
    if (!cell) return;
    if (s.cellEdit) {
      if (canPoint()) {
        // Point mode: the click inserts a reference, a drag makes it a range. Focus stays in the editor.
        e.preventDefault();
        const anchor = cell;
        s.pointCell = cell;
        insertRef(cellName(cell.col, cell.row));
        const move = (ev: PointerEvent) => {
          const c2 = cellAt(ev.clientX, ev.clientY);
          if (!c2) return;
          const c0 = Math.min(anchor.col, c2.col), c1 = Math.max(anchor.col, c2.col);
          const r0 = Math.min(anchor.row, c2.row), r1 = Math.max(anchor.row, c2.row);
          const ref = c0 === c1 && r0 === r1 ? cellName(c0, r0) : `${cellName(c0, r0)}:${cellName(c1, r1)}`;
          if (s.point && s.editText.slice(s.point.start, s.point.end) !== ref) insertRef(ref);
        };
        const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        return;
      }
      // A click elsewhere saves the edit, like Excel.
      endEdit(true);
    } else if (s.editing && document.activeElement === inputRef.current) {
      // Text typed in the formula bar is saved before the selection moves, not thrown away.
      workerRef.current?.postMessage({ type: "edit", col: s.sel.col, row: s.sel.row, text: s.editText });
      s.editing = false;
    }
    if (e.shiftKey) { extendTo(cell.col, cell.row); wrapRef.current!.focus(); return; }
    select(cell.col, cell.row);
    wrapRef.current!.focus();
    // A drag from here selects a range.
    const move = (ev: PointerEvent) => {
      const c2 = cellAt(ev.clientX, ev.clientY);
      if (c2 && (c2.col !== s.corner.col || c2.row !== s.corner.row)) extendTo(c2.col, c2.row);
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (s.cellEdit || e.target === editorRef.current) return;
    const cell = cellAt(e.clientX, e.clientY);
    if (!cell) return;
    const ins = s.inspect;
    if (ins && ins.id === s.inspectId && ins.col === cell.col && ins.row === cell.row) startEdit(ins.input, "edit");
    else s.pendingEdit = true; // the input arrives with the inspect reply
  };

  const onEditorKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const k = e.key;
    if (k === "Enter" && !(e.metaKey || e.ctrlKey)) { e.preventDefault(); endEdit(true, 0, e.shiftKey ? -1 : 1); return; }
    if (k === "Tab") { e.preventDefault(); endEdit(true, e.shiftKey ? -1 : 1, 0); return; }
    if (k === "Escape") { e.preventDefault(); endEdit(false); return; }
    if (k === "F2") { e.preventDefault(); s.editMode = s.editMode === "edit" ? "enter" : "edit"; return; }
    if (k === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); endEdit(true); return; }
    if (k === "F4") { e.preventDefault(); anchorAtCaret(e.currentTarget); return; }
    const dir: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const d = dir[k];
    if (!d) return;
    if (canPoint()) {
      // Arrow keys point at a cell, starting from the cell being edited.
      e.preventDefault();
      const from = s.pointCell ?? s.cellEdit!;
      const next = { col: Math.min(Math.max(0, from.col + d[0]), COL_W.length - 1), row: Math.min(Math.max(0, from.row + d[1]), s.rows - 1) };
      s.pointCell = next;
      insertRef(cellName(next.col, next.row));
      return;
    }
    // Typing mode: an arrow saves and moves, like Excel. Edit mode: the arrow moves the caret.
    if (s.editMode === "enter") { e.preventDefault(); endEdit(true, d[0], d[1]); }
  };

  const dragThumb = (axis: "x" | "y") => (e: React.PointerEvent) => {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture(e.pointerId); } catch { /* the pointer is gone: drag without capture */ }
    const start = axis === "y" ? e.clientY : e.clientX;
    const startScroll = axis === "y" ? s.scrollY : s.scrollX;
    const track = axis === "y" ? s.h - HEAD_H - ROW_H - 8 - el.offsetHeight : s.w - RHDR_W - 16 - el.offsetWidth;
    const max = axis === "y" ? maxY() : maxX();
    const move = (ev: PointerEvent) => {
      const d = ((axis === "y" ? ev.clientY : ev.clientX) - start) / Math.max(1, track) * max;
      if (axis === "y") scrollTo(s.scrollX, startScroll + d); else scrollTo(startScroll + d, s.scrollY);
    };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const commit = (move: number) => {
    setError(null);
    if (s.cellEdit) { endEdit(true, 0, move); return; }
    s.editing = false;
    workerRef.current?.postMessage({ type: "edit", col: s.sel.col, row: s.sel.row, text: formula });
    if (move) select(s.sel.col, s.sel.row + move);
    wrapRef.current?.focus();
  };

  const onGridKey = (e: React.KeyboardEvent) => {
    const { col, row } = s.sel;
    const page = Math.floor(viewH() / ROW_H);
    const altGr = e.ctrlKey && e.altKey && !e.metaKey; // Windows AltGr types @, €, {
    const jump = (e.metaKey || e.ctrlKey) && !altGr;
    const go: Record<string, [number, number]> = {
      Home: jump ? [0, 0] : [0, row], End: jump ? [COL_W.length - 1, s.rows - 1] : [COL_W.length - 1, row],
      ArrowUp: [col, jump ? 0 : row - 1], ArrowDown: [col, jump ? s.rows - 1 : row + 1],
      ArrowLeft: [jump ? 0 : col - 1, row], ArrowRight: [jump ? COL_W.length - 1 : col + 1, row],
      PageUp: [col, row - page], PageDown: [col, row + page], Tab: [col + (e.shiftKey ? -1 : 1), row],
    };
    if (e.shiftKey && go[e.key] && e.key !== "Tab") {
      // Shift extends: the same moves, measured from the corner, not the active cell.
      const k = s.corner;
      const ext: Record<string, [number, number]> = {
        ArrowUp: [k.col, jump ? 0 : k.row - 1], ArrowDown: [k.col, jump ? s.rows - 1 : k.row + 1],
        ArrowLeft: [jump ? 0 : k.col - 1, k.row], ArrowRight: [jump ? COL_W.length - 1 : k.col + 1, k.row],
        PageUp: [k.col, k.row - page], PageDown: [k.col, k.row + page],
        Home: jump ? [0, 0] : [0, k.row], End: jump ? [COL_W.length - 1, s.rows - 1] : [COL_W.length - 1, k.row],
      };
      e.preventDefault();
      extendTo(...ext[e.key]);
      return;
    }
    if (go[e.key]) { e.preventDefault(); select(...go[e.key]); return; }
    if (jump && e.key.toLowerCase() === "a") { e.preventDefault(); select(0, 0); extendTo(COL_W.length - 1, s.rows - 1); return; }
    if (e.key === "Escape") {
      // Collapse the range, then drop the copied outline.
      if (s.corner.col !== s.sel.col || s.corner.row !== s.sel.row) { s.corner = { ...s.sel }; scheduleStats(); }
      else s.copied = null;
      redraw();
      return;
    }
    if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); select(col, row - 1); return; } // like Excel
    if (!IS_MAC && e.ctrlKey && e.key.toLowerCase() === "y") { e.preventDefault(); workerRef.current?.postMessage({ type: "redo" }); return; }
    if (jump && e.key.toLowerCase() === "z") {
      e.preventDefault();
      workerRef.current?.postMessage({ type: e.shiftKey ? "redo" : "undo" });
      return;
    }
    if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      const ins = s.inspect;
      if (ins && ins.id === s.inspectId && ins.col === col && ins.row === row) startEdit(ins.input, "edit");
      else s.pendingEdit = true; // the input arrives with the inspect reply
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      const g = rangeOf();
      if (g.c0 !== g.c1 || g.r0 !== g.r1) workerRef.current?.postMessage({ type: "clearRange", ...g });
      else workerRef.current?.postMessage({ type: "edit", col, row, text: "" });
      return;
    }
    if (s.cellEdit && e.key.length === 1 && !jump) {
      // Safety net: a key that reached the grid while an edit is open belongs to the edit.
      e.preventDefault();
      setFormula(s.editText + e.key);
      editorRef.current?.focus();
      return;
    }
    if (e.key.length === 1 && !jump && (!e.altKey || altGr)) {
      // Typing replaces the cell, like Excel. The editor opens with that first character.
      e.preventDefault();
      startEdit(e.key, "enter");
    }
  };

  // F4 in either editor.
  const anchorAtCaret = (el: HTMLInputElement) => {
    const r = cycleAnchor(el.value, el.selectionStart ?? el.value.length);
    if (!r) return;
    s.editing = true;
    s.point = null;
    setFormula(r.text);
    el.value = r.text;
    el.setSelectionRange(r.caret, r.caret);
    redraw();
  };

  // The name box: type a cell and press Return to go there, like Excel's Name Box.
  const goToCell = (text: string) => {
    const c = parseCellRef(text);
    if (!c || c.col >= COL_W.length || c.row >= s.rows) {
      setError(`"${text.trim()}" is not a cell in this sheet. Try something like K5 or A1000000.`);
      return false;
    }
    setNameText(null);
    select(c.col, c.row);
    wrapRef.current?.focus({ preventScroll: true });
    return true;
  };
  const focusNameBox = () => {
    if (s.cellEdit) endEdit(true);
    const el = nameRef.current;
    if (!el) return;
    setNameText(cellName(s.sel.col, s.sel.row));
    el.focus();
    requestAnimationFrame(() => el.select());
  };

  // The formula bar: the same keys as the in-cell editor.
  const onFormulaKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const k = e.key;
    if (k === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(0); return; }
    if (k === "Enter") { e.preventDefault(); commit(e.shiftKey ? -1 : 1); return; }
    if (k === "Tab") {
      e.preventDefault();
      if (s.cellEdit) { endEdit(true, e.shiftKey ? -1 : 1, 0); return; }
      commit(0);
      select(s.sel.col + (e.shiftKey ? -1 : 1), s.sel.row);
      return;
    }
    if (k === "F4") { e.preventDefault(); anchorAtCaret(e.currentTarget); return; }
    if (k === "Escape") {
      e.preventDefault();
      if (s.cellEdit) { endEdit(false); return; } // also close the cell editor the bar was continuing
      s.editing = false;
      setFormula(selInfo?.input ?? "");
      setError(null);
      wrapRef.current?.focus();
    }
  };

  const openPicker = () => { if (ready && !loading) fileRef.current?.click(); };

  // Shortcuts that work anywhere on the page (the app variant only).
  useEffect(() => {
    if (variant !== "app") return;
    const onKey = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "o") { e.preventDefault(); openPicker(); return; }
      if (mod && (k === "/" || e.code === "Slash")) { e.preventDefault(); setKeysOpen((v) => !v); return; }
      if (e.ctrlKey && !e.metaKey && k === "g") { e.preventDefault(); focusNameBox(); return; }
      if (k === "escape") { setKeysOpen(false); setBench(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, ready, loading]);

  // An opened panel takes focus on its Close button, so Esc and Tab start there.
  useEffect(() => { if (keysOpen) keysCloseRef.current?.focus(); }, [keysOpen]);
  useEffect(() => { if (bench) benchCloseRef.current?.focus(); }, [bench]);

  // Copy: tab-separated displayed values, so a block pastes into Excel, Sheets or Numbers. The worker
  // also keeps the formulas, so a paste back into this sheet moves them like Excel does.
  const onCopy = (e: React.ClipboardEvent, cut = false) => {
    if (e.target !== wrapRef.current || !s.shared) return;
    const g = rangeOf();
    const cells = (g.c1 - g.c0 + 1) * (g.r1 - g.r0 + 1);
    if (cells > MAX_COPY) { e.preventDefault(); setError(`That is ${fmtInt(cells)} cells. Copy up to ${fmtInt(MAX_COPY)} at a time.`); return; }
    const rows: string[][] = [];
    for (let r = g.r0; r <= g.r1; r++) { const row: string[] = []; for (let c = g.c0; c <= g.c1; c++) row.push(textAt(c, r)); rows.push(row); }
    const tsv = toTSV(rows);
    e.clipboardData.setData("text/plain", tsv);
    e.preventDefault();
    s.clipText = tsv;
    s.copied = cut ? null : g;
    workerRef.current?.postMessage({ type: "copySnapshot", ...g });
    if (cut) workerRef.current?.postMessage({ type: "clearRange", ...g });
    redraw();
  };

  // Paste: our own copy keeps its formulas (shifted); anything else arrives as values and formulas
  // typed as text. One copied value fills the whole selected range.
  const onPaste = (e: React.ClipboardEvent) => {
    if (e.target !== wrapRef.current) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const g = rangeOf();
    if (text === s.clipText) {
      workerRef.current?.postMessage({ type: "pasteInternal", target: g });
    } else {
      const rows = fromTSV(text);
      const single = rows.length === 1 && rows[0].length === 1;
      const h = single ? g.r1 - g.r0 + 1 : rows.length;
      const w = single ? g.c1 - g.c0 + 1 : Math.max(...rows.map((r) => r.length));
      if (h * w > 1_000_000) { setError(`That is ${fmtInt(h * w)} cells. Paste up to 1,000,000 at a time.`); return; }
      const cells: [number, number, string][] = [];
      for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) cells.push([g.c0 + j, g.r0 + i, single ? rows[0][0] : rows[i][j] ?? ""]);
      workerRef.current?.postMessage({ type: "editRange", cells, at: { col: g.c0, row: g.r0 }, kind: "paste" });
      if (!single) { select(g.c0, g.r0); extendTo(g.c0 + w - 1, g.r0 + h - 1); }
    }
    s.copied = null;
  };

  const toggle = (k: "heat" | "arrows") => {
    const next = { ...toggles, [k]: !toggles[k] };
    setToggles(next);
    s.heat = next.heat;
    s.arrows = next.arrows;
    redraw();
  };

  // Guided demo: one click per idea, so a visitor sees the engine work without knowing what to type.
  const [guide, setGuide] = useState("Every number here is live. Double-click a cell to edit it, or try one:");
  const taxStep = useRef(0);
  const TRY = [
    {
      label: "Change the tax rate",
      run: () => {
        const rates = ["12%", "5%", "8%"];
        const rate = rates[taxStep.current++ % rates.length];
        select(10, 1);
        workerRef.current?.postMessage({ type: "edit", col: 10, row: 1, text: rate });
        setGuide(`Tax rate K2 is now ${rate}. Every Tax, Total and Running total cell reads it, so 3 million cells recompute. The blue flash shows them.`);
      },
    },
    {
      label: "Edit the first order",
      run: () => {
        const units = String(1 + Math.floor(Math.random() * 20));
        select(2, 1);
        workerRef.current?.postMessage({ type: "edit", col: 2, row: 1, text: units });
        setGuide(`Order 100001 now has ${units} units. Its total feeds the running total of every order below it: 1 million cells recompute.`);
      },
    },
    {
      label: "Edit the last order",
      run: () => {
        const units = String(1 + Math.floor(Math.random() * 20));
        select(2, s.rows - 1);
        workerRef.current?.postMessage({ type: "edit", col: 2, row: s.rows - 1, text: units });
        setGuide(`The last order now has ${units} units. Only 12 cells read it, and the totals in column K update without rescanning a million rows.`);
      },
    },
    {
      label: "Trace a formula",
      run: () => {
        select(10, 4);
        setGuide("K5 adds up Total for the North region. The blue bands show what it reads: two whole columns, 2 million cells.");
      },
    },
    {
      label: "Jump to the last order",
      run: () => {
        select(7, s.rows - 1);
        setGuide("This is row 1,000,001. Its running total matches the Grand total in K4. Press ⌘↑ to go back to the top, and ⌘Z to undo an edit.");
      },
    },
  ];

  // Embed autoplay. The hero runs the autopilot (autopilot.ts): a cursor that clicks, types and
  // drags in the real grid. With reduced motion there is no cursor: the tax rate changes in place
  // every few seconds instead. Both pause off screen and in a hidden tab, and stop for good at the
  // visitor's first touch.
  useEffect(() => {
    if (!autoplay || !ready || s.touched) return;
    const root = rootRef.current;
    const io = new IntersectionObserver(([e]) => { s.inView = e.isIntersecting; }, { threshold: 0.35 });
    if (root) io.observe(root);
    const live = () => !document.hidden && s.inView;

    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const rates = ["12%", "5%", "8%"];
      let i = 0;
      const id = setInterval(() => {
        if (s.touched || !live()) return;
        workerRef.current?.postMessage({ type: "edit", col: 10, row: 1, text: rates[i++ % rates.length] });
      }, 3200);
      return () => { clearInterval(id); io.disconnect(); };
    }

    const token = { cancelled: false };
    const cursor = cursorRef.current;
    if (!cursor || !root) return () => io.disconnect();
    const place = (x: number, y: number, ms: number) => {
      cursor.style.transitionDuration = `${ms}ms`;
      cursor.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    };
    let at = { x: 0, y: 0 };
    // Where a cell is, relative to the root, in CSS px. Rows below the header scroll; row 0 does not.
    const cellPoint = (col: number, row: number) => {
      const rr = root!.getBoundingClientRect(), cr = canvasRef.current!.getBoundingClientRect();
      const x = cr.left - rr.left + RHDR_W + COL_X[col] - s.scrollX + Math.min(COL_W[col] * 0.62, 70);
      const y = cr.top - rr.top + HEAD_H + row * ROW_H - s.scrollY + ROW_H * 0.62;
      return { x, y };
    };
    const closeEditor = () => {
      s.cellEdit = null;
      setCellEdit(null);
      const ed = editorRef.current;
      if (ed) { ed.classList.remove("open"); ed.style.visibility = ""; }
    };
    const stop = () => {
      if (token.cancelled) return;
      token.cancelled = true;
      s.touched = true;
      s.piloting = false;
      s.pilotStop = null;
      s.pilotWait?.();
      if (s.cellEdit) { closeEditor(); setFormula(s.inspect && s.inspect.col === s.sel.col && s.inspect.row === s.sel.row ? s.inspect.input : ""); }
      setNameText(null);
      cursor.classList.remove("on");
      redraw();
    };
    s.pilotStop = stop;

    const sleep = (ms: number) => new Promise<void>((resolve, reject) => {
      let left = ms, last = performance.now();
      const tick = () => {
        if (token.cancelled) return reject(new Cancelled());
        const now = performance.now();
        if (live()) left -= now - last; // the clock stops while off screen or hidden
        last = now;
        if (left <= 0) resolve(); else setTimeout(tick, Math.min(left, 100));
      };
      setTimeout(tick, Math.min(ms, 100));
    });
    const engineDone = () => new Promise<void>((resolve) => {
      s.pilotWait = () => { s.pilotWait = null; resolve(); };
    });

    const api: PilotApi = {
      moveTo: (target) => {
        let p: { x: number; y: number };
        if (target === "namebox") {
          const rr = root!.getBoundingClientRect(), nb = nameRef.current!.getBoundingClientRect();
          p = { x: nb.left - rr.left + nb.width * 0.62, y: nb.top - rr.top + nb.height * 0.6 };
        } else {
          // A target outside the view scrolls in first, so the cursor never leaves the grid.
          const { col: c, row: r } = target, vw = s.w - RHDR_W, vh = viewH();
          let x = s.scrollX, y = s.scrollY;
          if (COL_X[c] < x) x = COL_X[c]; else if (COL_X[c] + COL_W[c] > x + vw) x = COL_X[c] + COL_W[c] - vw;
          const top = (r - 1) * ROW_H;
          if (r > 0) { if (top < y) y = top; else if (top + ROW_H > y + vh) y = top + ROW_H - vh; }
          if (x !== s.scrollX || y !== s.scrollY) scrollTo(x, y);
          p = cellPoint(c, r);
        }
        // Longer trips take longer, like a hand: 260 ms up close, 900 ms across the window.
        const ms = Math.round(Math.min(900, 260 + Math.hypot(p.x - at.x, p.y - at.y) * 0.9));
        place(p.x, p.y, ms);
        at = p;
        return ms;
      },
      press: () => {
        cursor.classList.remove("press");
        void cursor.offsetWidth; // restart the animation
        cursor.classList.add("press");
      },
      select: (col, row) => {
        select(col, row);
        // The select may scroll the grid. Keep the cursor on the cell it clicked.
        if (cursor.classList.contains("on")) { const p = cellPoint(col, row); if (p.x !== at.x || p.y !== at.y) { place(p.x, p.y, 0); at = p; } }
      },
      extend: (col, row) => extendTo(col, row),
      type: (text) => {
        if (text === null) { closeEditor(); return; }
        if (!s.cellEdit) {
          s.cellEdit = { ...s.sel };
          s.editMode = "enter";
          s.point = null;
          setCellEdit(s.cellEdit);
          editorRef.current?.classList.add("open");
        }
        setFormula(text);
        redraw();
      },
      typeName: (text) => setNameText(text),
      commit: async () => {
        const ce = s.cellEdit;
        if (!ce) return;
        const done = engineDone();
        workerRef.current?.postMessage({ type: "edit", col: ce.col, row: ce.row, text: s.editText });
        closeEditor();
        api.select(ce.col, ce.row + 1);
        await done;
      },
      write: async (cells) => {
        const done = engineDone();
        workerRef.current?.postMessage({ type: "editRange", cells, at: { col: cells[0][0], row: cells[0][1] }, kind: "edit" });
        await done;
      },
      read: (c, r) => {
        const col = s.cols[c];
        if (!col || col.t[r] !== 1) return textAt(c, r);
        const f = s.cellFormats.get(c * s.rows + r) ?? s.formats[c];
        return f === "percent" ? `${+(col.v[r] * 100).toPrecision(12)}%` : String(col.v[r]);
      },
      show: (on) => {
        s.piloting = on || s.piloting;
        cursor.classList.toggle("on", on);
      },
    };

    // Start from the bottom-right of the grid, out of the way of the cells.
    const rr0 = root!.getBoundingClientRect();
    at = { x: rr0.width * 0.7, y: rr0.height * 0.8 };
    place(at.x, at.y, 0);
    s.piloting = true;
    redraw();
    runPilot(api, sleep).catch((e) => { console.warn("autopilot stopped:", e); stop(); });
    return () => { token.cancelled = true; s.pilotStop = null; s.piloting = false; io.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoplay, ready]);

  // Open a CSV: the file is read in the worker, on this machine. Nothing is uploaded.
  const openFile = (file: File | undefined | null) => {
    if (!file || !workerRef.current) return;
    if (s.cellEdit) endEdit(false);
    setError(null);
    setLoading({ name: file.name, pct: 0, rows: 0 });
    // The new sheet's columns arrive before "ready": keep the old ones aside in case the import fails.
    s.prevRows = s.rows; s.prevCols = s.cols; s.prevStrs = s.strs;
    s.cols = [];
    s.strs = [];
    s.rows = 0;
    s.touched = true; // no autoplay over the user's data
    workerRef.current.postMessage({ type: "loadCsv", file });
  };

  const runBench = () => { setBenchBusy(true); setBench(null); workerRef.current?.postMessage({ type: "bench" }); };

  const selInfo = inspect && inspect.col === sel.col && inspect.row === sel.row ? inspect : null;

  return (
    <div
      onDragOver={(e) => { if (variant !== "app" || !e.dataTransfer.types.includes("Files")) return; e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
      onDrop={(e) => { if (variant !== "app") return; e.preventDefault(); setDragOver(false); openFile(e.dataTransfer.files?.[0]); }}
      ref={rootRef}
      onPointerDownCapture={() => s.pilotStop?.()}
      onKeyDownCapture={() => s.pilotStop?.()}
      onFocusCapture={() => s.pilotStop?.()}
      className={`app ${variant} theme-${theme.name}`}
      style={{
        "--bg": C.bg, "--chrome": C.headBg, "--line": C.line, "--text": C.text, "--muted": C.muted,
        "--accent": C.accent, "--accent-rgb": C.accentRgb, "--on-accent": C.onAccent, "--error": C.error,
        "--font": C.font, "--mono": C.mono,
      } as React.CSSProperties}
    >
      <header className="bar">
        {/* Left: where you are. One line, one strong label. */}
        <div className="barStart">
          {home && variant === "app" && (
            <>
              <a className="home" href={home.href}>{home.label}</a>
              <span className="sep" aria-hidden />
            </>
          )}
          <div className="title" title={doc.kind === "csv" ? `${doc.name}: ${fmtInt(doc.dataRows)} rows, ${fmtInt(doc.dataCols)} columns` : `${title}: ${fmtInt(orders)} orders, ${ready ? fmtInt(ready.formulas) : "…"} formulas`}>
            <MiddleName text={doc.kind === "csv" ? doc.name : title} />
            <span className="meta">
              {doc.kind === "csv"
                ? `${fmtInt(doc.dataRows)} rows · ${fmtInt(doc.dataCols)} cols`
                : ready ? `${fmtInt(ready.formulas)} live formulas` : "Loading"}
            </span>
          </div>
        </div>

        {/* Centre: the formula bar, on the true centre of the window. */}
        <div className="formula">
          <input
            ref={nameRef}
            className="namebox"
            value={nameText ?? cellName(sel.col, sel.row)}
            spellCheck={false}
            autoComplete="off"
            aria-label="Cell reference. Type a cell, like K5, and press Return to go there."
            title={`Go to a cell (⌃G)`}
            onFocus={(e) => { setNameText(e.currentTarget.value); requestAnimationFrame(() => e.currentTarget?.select()); }}
            onChange={(e) => setNameText(e.target.value)}
            onBlur={() => setNameText(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); goToCell(e.currentTarget.value); }
              if (e.key === "Escape") { e.preventDefault(); setNameText(null); setError(null); wrapRef.current?.focus(); }
            }}
          />
          <span className="fx" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7.4 3.3c-.8-.5-2-.2-2.3.9L3.5 12c-.3 1.1-1.4 1.4-2.2.9" />
              <path d="M3.2 6.6h3.9" />
              <path d="M9.4 7l4 5M13.4 7l-4 5" />
            </svg>
          </span>
          <input
            ref={inputRef}
            className="formulaInput"
            value={formula}
            spellCheck={false}
            autoComplete="off"
            aria-label={`Contents of ${cellName(sel.col, sel.row)}`}
            onChange={(e) => { s.editing = true; setFormula(e.target.value); }}
            onKeyDown={onFormulaKey}
            placeholder="Type a value or a formula"
          />
        </div>

        {/* Right: the one document command. */}
        <div className="barEnd">
          {variant === "app" && (
            <>
              <button
                className="ctl open"
                onClick={openPicker}
                disabled={!ready || !!loading}
                title={!ready ? "Available when the engine is ready" : loading ? "A file is loading" : "Open a CSV file. It is read on this machine."}
                aria-keyshortcuts={IS_MAC ? "Meta+O" : "Control+O"}
              >
                Open CSV…<kbd>{MOD}O</kbd>
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
                hidden
                onChange={(e) => { openFile(e.target.files?.[0]); e.target.value = ""; }}
              />
            </>
          )}
        </div>
      </header>

      {variant === "app" && doc.kind === "ledger" && (
        <div className="try">
          <span className="guide">{guide}</span>
          <div className="actions">
            {TRY.map((t) => (
              <button key={t.label} className="ctl" onClick={t.run} disabled={!ready}>{t.label}</button>
            ))}
          </div>
        </div>
      )}
      {variant === "app" && doc.kind === "csv" && (
        <div className="try">
          <span className="guide">
            Your file, read in {fmtDur(doc.parseMs)} on this machine. Nothing was uploaded. Double-click to edit, or add a formula in an
            empty column, like <code>=SUM(B:B)</code>.
          </span>
          <div className="actions">
            <button className="ctl" onClick={() => location.reload()}>Back to the ledger demo</button>
          </div>
        </div>
      )}

      <div
        className="gridwrap"
        ref={wrapRef}
        tabIndex={0}
        role="application"
        aria-roledescription="spreadsheet"
        aria-label={`${doc.kind === "csv" ? doc.name : title}. Arrow keys move, Return edits, ${MOD}/ lists shortcuts.`}
        onFocus={() => { s.gridFocused = true; setGridFocused(true); redraw(); }}
        onBlur={() => { s.gridFocused = false; setGridFocused(false); redraw(); }}
        onKeyDown={(e) => { s.touched = true; if (e.target === wrapRef.current) onGridKey(e); }}
        onPointerDown={(e) => { s.touched = true; onPointerDown(e); }}
        onDoubleClick={onDoubleClick}
        onCopy={(e) => onCopy(e)}
        onCut={(e) => onCopy(e, true)}
        onPaste={onPaste}
      >
        <canvas ref={canvasRef} />
        {(
          <input
            ref={editorRef}
            className={cellEdit ? "celledit open" : "celledit"}
            tabIndex={cellEdit ? 0 : -1}
            value={cellEdit ? formula : ""}
            spellCheck={false}
            autoComplete="off"
            aria-label={cellEdit ? `Edit ${cellName(cellEdit.col, cellEdit.row)}` : undefined}
            aria-hidden={!cellEdit}
            onChange={(e) => {
              s.point = null; // typing ends the pointed reference
              setFormula(e.target.value);
              redraw();
            }}
            onKeyDown={onEditorKey}
            onBlur={(e) => {
              // Moving into the formula bar keeps the edit open. Anywhere else saves it.
              if (s.cellEdit && e.relatedTarget !== inputRef.current) endEdit(true);
            }}
          />
        )}
        {loading && (
          <div className="importing" role="status">
            <div className="importCard">
              <span className="importName">{loading.name}</span>
              <span className="importMeta num">{loading.pct >= 1 ? "Building the sheet…" : `${Math.round(loading.pct * 100)}% · ${fmtInt(loading.rows)} rows`}</span>
              <span className="importBar"><span style={{ transform: `scaleX(${Math.min(1, loading.pct)})` }} /></span>
              <span className="importNote">Read on this machine. Nothing is uploaded.</span>
            </div>
          </div>
        )}
        <div className="sr-only" aria-live="polite">{gridFocused ? announce : ""}</div>
        {dragOver && <div className="dropzone">Drop a CSV to open it. It stays on this machine.</div>}
        <div className="thumb v" ref={vThumbRef} onPointerDown={dragThumb("y")} />
        <div className="thumb h" ref={hThumbRef} onPointerDown={dragThumb("x")} />
        {autoplay && <div className="pilotCaret" ref={caretRef} aria-hidden />}
        {!ready && (
          <div className="loading">
            {startError ? (
              <span>
                The engine could not start. <button className="reload" onClick={() => location.reload()}>Reload the page</button>
              </span>
            ) : (
              <>Building {fmtInt(orders)} orders and {fmtInt(orders * 4)} formulas…</>
            )}
          </div>
        )}
      </div>

      <footer className="status">
        <div className="recalc" role="status" aria-live="polite">
          {recalcing ? (
            <>Recalculating after <b>{recalcing}</b>… the grid stays live</>
          ) : error ? (
            <span className="err" role="alert">{error}</span>
          ) : lastEdit ? (
            <>
              {lastEdit.kind === "undo" ? "Undo: " : lastEdit.kind === "redo" ? "Redo: " : ""}
              {(lastEdit.kind === "undo" || lastEdit.kind === "redo") && (lastEdit.count ?? 1) > 1 ? (
                <><b className="num">{fmtInt(lastEdit.count ?? 0)}</b> cells changed</>
              ) : lastEdit.kind === "paste" || lastEdit.kind === "clear" ? (
                <>{lastEdit.kind === "paste" ? "Pasted" : "Cleared"} <b className="num">{fmtInt(lastEdit.count ?? 0)}</b> {lastEdit.count === 1 ? "cell" : "cells"}</>
              ) : (
                <><b>{lastEdit.name}</b> changed</>
              )}{" "}· <b className="num">{fmtInt(lastEdit.recomputed)}</b> {lastEdit.recomputed === 1 ? "cell" : "cells"} recomputed in{" "}
              <b className="num">{fmtDur(lastEdit.ms)}</b>
              {lastEdit.slices > 1 && <> · {lastEdit.slices} slices, the grid stayed live</>}
            </>
          ) : doc.kind === "csv" ? (
            <>
              Read <b className="num">{(doc.bytes / 1048576).toFixed(1)} MB</b> in <b className="num">{fmtDur(doc.parseMs)}</b> ·{" "}
              <span className="num">{fmtInt(doc.dataRows)}</span> rows on this machine
            </>
          ) : ready ? (
            <>
              Loaded in <b className="num">{fmtDur(ready.buildMs)}</b> · full recalc of {fmtInt(ready.formulas)} formulas in <b className="num">{fmtDur(ready.recalcMs)}</b> ·{" "}
              <span className="num">{Math.round(ready.typedArrayMB)} MB</span>
            </>
          ) : null}
        </div>
        <div className="sel">
          {rangeStats ? (
            <span className="num">{rangeStats}</span>
          ) : selInfo && selInfo.input.startsWith("=") ? (
            <>reads <span className="num">{fmtInt(selInfo.reads)}</span> · feeds <span className="num">{fmtInt(selInfo.dep.count)}</span></>
          ) : selInfo ? (
            <>feeds <span className="num">{fmtInt(selInfo.dep.count)}</span> {selInfo.dep.count === 1 ? "formula" : "formulas"}</>
          ) : null}
        </div>
        {variant === "app" && (
          <div className="right">
            <button className="ctl" aria-pressed={toggles.heat} title="Flash the cells each edit recalculates" onClick={() => toggle("heat")}>Recalc heat</button>
            <button className="ctl" aria-pressed={toggles.arrows} title="Show what the selected formula reads" onClick={() => toggle("arrows")}>Arrows</button>
            {doc.kind === "ledger" && <button className="ctl" onClick={runBench} disabled={!ready || benchBusy}>{benchBusy ? "Running…" : "Benchmark"}</button>}
            <button className="ctl" aria-expanded={keysOpen} aria-keyshortcuts={IS_MAC ? "Meta+/" : "Control+/"} onClick={() => setKeysOpen((v) => !v)}>
              Shortcuts<kbd>{MOD}/</kbd>
            </button>
            <span className="num frame">draw {drawMs.toFixed(1)} ms</span>
          </div>
        )}
      </footer>

      {autoplay && (
        // The autopilot's cursor. Decoration: screen readers skip it, and clicks pass through it.
        <div className="pilotCursor" ref={cursorRef} aria-hidden>
          <svg width="22" height="26" viewBox="0 0 22 26">
            <path d="M2 1.5v18.2l4.6-4.3 3.1 7.1 3.2-1.4-3.1-7h6.4z" fill="#1d1d1f" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
        </div>
      )}

      {bench && (
        <div className="panel" role="dialog" aria-labelledby="bench-title">
          <div className="panelhead">
            <span id="bench-title">Benchmark · this browser</span>
            <button ref={benchCloseRef} className="ctl" onClick={() => setBench(null)}>Close</button>
          </div>
          <table>
            <thead><tr><th>Edit</th><th>Recomputed</th><th>Median</th><th>Best</th></tr></thead>
            <tbody>
              {bench.results.map((r) => (
                <tr key={r.label}><td>{r.label}</td><td className="num">{fmtInt(r.recomputed)}</td><td className="num">{fmtDur(r.median)}</td><td className="num">{fmtDur(r.best)}</td></tr>
              ))}
              <tr><td>Full recalc</td><td className="num">{fmtInt(bench.full.recomputed)}</td><td className="num">{fmtDur(bench.full.ms)}</td><td /></tr>
            </tbody>
          </table>
        </div>
      )}

      {keysOpen && (
        <div className="panel keys" role="dialog" aria-labelledby="keys-title">
          <div className="panelhead">
            <span id="keys-title">Keyboard shortcuts</span>
            <button ref={keysCloseRef} className="ctl" onClick={() => setKeysOpen(false)}>Close<kbd>esc</kbd></button>
          </div>
          <table>
            <tbody>
              {SHORTCUTS.map((row, i) =>
                "group" in row ? (
                  <tr key={i} className="group"><td colSpan={2}>{row.group}</td></tr>
                ) : (
                  <tr key={i}>
                    <td>{row.label}</td>
                    <td>{row.keys.map((k) => <kbd key={k}>{k.replace("MOD", IS_MAC ? "⌘" : "Ctrl")}</kbd>).reduce<React.ReactNode[]>((a, el, j) => (j ? [...a, " ", el] : [el]), [])}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const SHORTCUTS: ({ group: string } | { label: string; keys: string[] })[] = [
  { group: "Move" },
  { label: "Move one cell", keys: ["←", "→", "↑", "↓"] },
  { label: "Next cell / previous cell", keys: ["Tab", "⇧ Tab"] },
  { label: "Start or end of the row", keys: ["Home", "End"] },
  { label: "Edge of the sheet", keys: ["MOD ↑ ↓ ← →"] },
  { label: "First cell / last cell", keys: ["MOD Home", "MOD End"] },
  { label: "Go to a cell", keys: ["⌃ G"] },
  { group: "Edit" },
  { label: "Edit the cell", keys: ["Return", "F2"] },
  { label: "Replace the cell", keys: ["Type"] },
  { label: "Save and move down / up", keys: ["Return", "⇧ Return"] },
  { label: "Save and stay", keys: ["MOD Return"] },
  { label: "Cancel the edit", keys: ["esc"] },
  { label: "Absolute reference ($A$1)", keys: ["F4"] },
  { label: "Clear the cell", keys: ["⌫"] },
  { label: "Undo / redo", keys: ["MOD Z", "⇧ MOD Z"] },
  { group: "File" },
  { label: "Open a CSV", keys: ["MOD O"] },
  { label: "This list", keys: ["MOD /"] },
];

function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 4) return;
  const ux = dx / len, uy = dy / len;
  const ex = x1 - ux * 4, ey = y1 - uy * 4;
  ctx.strokeStyle = C.accent;
  ctx.fillStyle = C.accent;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.arc(x0, y0, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(ex - ux * 5, ey - uy * 5);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - ux * 7 - uy * 3.5, ey - uy * 7 + ux * 3.5);
  ctx.lineTo(ex - ux * 7 + uy * 3.5, ey - uy * 7 - ux * 3.5);
  ctx.closePath();
  ctx.fill();
}
