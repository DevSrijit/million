"use client";

// Engine harness for the spike. The grid is one canvas. Scrolling is our own (no 26M px spacer div),
// the worker sends only the visible window, and numbers draw from a tabular glyph atlas.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewReply } from "@/engine/worker";

const ORDERS = 1_000_000;
const ROW_H = 26;
const HEAD_H = 26;
const RHDR_W = 76;
const COL_W = [80, 76, 62, 92, 116, 100, 116, 136, 24, 112, 140, 40];
const COL_X = COL_W.reduce<number[]>((xs, w, i) => (xs.push(i ? xs[i - 1] + COL_W[i - 1] : 0), xs), []);
const TOTAL_W = COL_X[COL_X.length - 1] + COL_W[COL_W.length - 1];
const OVERSCAN = 48;
const FADE_MS = 1100;

// Themes. The canvas reads C; the bars read the same values as CSS variables.
export type GridTheme = {
  name: string;
  bg: string; line: string; headBg: string; headText: string; headSel: string;
  text: string; muted: string; accent: string; accentRgb: string; onAccent: string;
  error: string; frozenLine: string; skeleton: string; font: string; mono: string;
};
const SF = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
export const THEMES: Record<"numbers" | "ink" | "paper", GridTheme> = {
  numbers: {
    name: "numbers", bg: "#ffffff", line: "#ebebed", headBg: "#f9f9fa", headText: "#8a8a8e", headSel: "#1d1d1f",
    text: "#1d1d1f", muted: "#8a8a8e", accent: "#0a6cff", accentRgb: "10,108,255", onAccent: "#ffffff",
    error: "#d70015", frozenLine: "#d2d2d7", skeleton: "#f2f2f4", font: SF, mono: 'ui-monospace, "SF Mono", Menlo, monospace',
  },
  ink: {
    name: "ink", bg: "#0a0a0b", line: "#1c1c1f", headBg: "#0e0e10", headText: "#636366", headSel: "#f5f5f7",
    text: "#ededf0", muted: "#7c7c80", accent: "#f5f5f7", accentRgb: "245,245,247", onAccent: "#0a0a0b",
    error: "#ff453a", frozenLine: "#2c2c30", skeleton: "#161618", font: SF, mono: 'ui-monospace, "SF Mono", Menlo, monospace',
  },
  paper: {
    name: "paper", bg: "#fbfaf6", line: "#ebe7dc", headBg: "#f5f2ea", headText: "#9a9285", headSel: "#1c1a17",
    text: "#1c1a17", muted: "#8f877a", accent: "#1f6f50", accentRgb: "31,111,80", onAccent: "#fbfaf6",
    error: "#b3261e", frozenLine: "#ddd6c7", skeleton: "#f0ece2", font: SF, mono: 'ui-monospace, "SF Mono", Menlo, monospace',
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

const colName = (c: number) => String.fromCharCode(65 + c);
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
type Edited = { col: number; row: number; recomputed: number; ms: number; computeMs: number; slices: number; epoch: number; cycles: number; kind: "edit" | "undo" | "redo" };
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
};

export default function Grid({ theme = THEMES.numbers, orders = ORDERS, variant = "app", autoplay = false, title = "Sales ledger" }: GridProps) {
  applyTheme(theme);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const vThumbRef = useRef<HTMLDivElement>(null);
  const hThumbRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);
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
    inspectId: 0,
  }).current;

  const [ready, setReady] = useState<Ready | null>(null);
  const [lastEdit, setLastEdit] = useState<(Edited & { name: string }) | null>(null);
  const [recalcing, setRecalcing] = useState<string | null>(null);
  const [startError, setStartError] = useState(false);
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
    const yOf = (r: number) => (r === 0 ? HEAD_H : bodyTop + (r - first) * ROW_H + offY);
    if (!s.atlas || s.atlas.color !== C.text) s.atlas = buildAtlas(s.dpr);
    const atlas = s.atlas;
    s.frames++;
    if (!s.body || s.body.r0 > first || s.body.r1 < Math.min(s.rows, first + count)) s.missFrames++;
    (window as unknown as { __grid: object }).__grid = { frames: s.frames, missFrames: s.missFrames, drawMs: s.drawMs };

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

    const drawRow = (v: ViewReply | null, r: number, y: number, bold: boolean) => {
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
    ctx.save();
    ctx.beginPath();
    ctx.rect(RHDR_W, HEAD_H, s.w - RHDR_W, s.h - HEAD_H);
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
    } else if (s.arrows && ins && ins.col === s.sel.col && ins.row === s.sel.row) {
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
    if (visible(s.sel.row)) {
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(sr.x + 1, sr.y + 1, sr.w - 2, sr.h - 2);
    }
    ctx.restore();

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
      ctx.fillStyle = c === s.sel.col ? C.headSel : C.headText;
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
      ctx.fillStyle = r === s.sel.row ? C.headSel : C.headText;
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

    s.drawMs = s.drawMs * 0.9 + (performance.now() - t0) * 0.1;
    if (heatA > 0) s.raf = requestAnimationFrame(draw);
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
    s.pendingEdit = false;
    setSel(s.sel);
    setError(null);
    s.editing = false;
    setFormula(s.inspect && s.inspect.col === col && s.inspect.row === row ? s.inspect.input : "");
    // Keep the cell in view.
    if (row > 0) {
      const top = (row - 1) * ROW_H, vh = viewH();
      if (top < s.scrollY) scrollTo(s.scrollX, top);
      else if (top + ROW_H > s.scrollY + vh) scrollTo(s.scrollX, top + ROW_H - vh);
    }
    const left = COL_X[col], vw = s.w - RHDR_W;
    if (left < s.scrollX) scrollTo(left, s.scrollY);
    else if (left + COL_W[col] > s.scrollX + vw) scrollTo(left + COL_W[col] - vw, s.scrollY);
    workerRef.current?.postMessage({ type: "inspect", id: ++s.inspectId, col, row });
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redraw, scrollTo]);

  // Worker lifecycle.
  useEffect(() => {
    const w = new Worker(new URL("../engine/worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      switch (m.type) {
        case "ready":
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
          // An undo or redo shows the cell it changed, like Numbers and Excel.
          if (m.kind !== "edit") select(m.col, m.row);
          s.body = s.body && { ...s.body, epoch: -1 };
          s.head = s.head && { ...s.head, epoch: -1 };
          requestView();
          w.postMessage({ type: "inspect", id: ++s.inspectId, col: s.sel.col, row: s.sel.row });
          break;
        case "editError":
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
            if (!s.editing) setFormula(m.input);
            if (s.pendingEdit) { s.pendingEdit = false; startEdit(m.input, "edit"); }
            redraw();
          }
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
    const onWheel = (e: WheelEvent) => {
      // In an embed, the page scrolls until the visitor clicks into the grid. Otherwise a hero
      // would trap the wheel on the way down the landing page.
      if (variant === "embed" && !s.touched) return;
      e.preventDefault();
      const k = e.deltaMode === 1 ? ROW_H : e.deltaMode === 2 ? viewH() : 1;
      scrollTo(s.scrollX + (e.shiftKey ? e.deltaY : e.deltaX) * k, s.scrollY + (e.shiftKey ? 0 : e.deltaY) * k);
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
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
    }
    select(cell.col, cell.row);
    wrapRef.current!.focus();
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
    if (k === "Enter") { e.preventDefault(); endEdit(true, 0, e.shiftKey ? -1 : 1); return; }
    if (k === "Tab") { e.preventDefault(); endEdit(true, e.shiftKey ? -1 : 1, 0); return; }
    if (k === "Escape") { e.preventDefault(); endEdit(false); return; }
    if (k === "F2") { e.preventDefault(); s.editMode = s.editMode === "edit" ? "enter" : "edit"; return; }
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
    el.setPointerCapture(e.pointerId);
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
    const jump = e.metaKey || e.ctrlKey;
    const go: Record<string, [number, number]> = {
      ArrowUp: [col, jump ? 0 : row - 1], ArrowDown: [col, jump ? s.rows - 1 : row + 1],
      ArrowLeft: [jump ? 0 : col - 1, row], ArrowRight: [jump ? COL_W.length - 1 : col + 1, row],
      PageUp: [col, row - page], PageDown: [col, row + page], Tab: [col + (e.shiftKey ? -1 : 1), row],
    };
    if (go[e.key]) { e.preventDefault(); select(...go[e.key]); return; }
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
      workerRef.current?.postMessage({ type: "edit", col, row, text: "" });
      return;
    }
    if (s.cellEdit && e.key.length === 1 && !jump) {
      // Safety net: a key that reached the grid while an edit is open belongs to the edit.
      e.preventDefault();
      setFormula(s.editText + e.key);
      editorRef.current?.focus();
      return;
    }
    if (e.key.length === 1 && !jump && !e.altKey) {
      // Typing replaces the cell, like Excel. The editor opens with that first character.
      e.preventDefault();
      startEdit(e.key, "enter");
    }
  };

  const toggle = (k: "heat" | "arrows") => {
    const next = { ...toggles, [k]: !toggles[k] };
    setToggles(next);
    s.heat = next.heat;
    s.arrows = next.arrows;
    redraw();
  };

  // Guided demo: one click per idea, so a visitor sees the engine work without knowing what to type.
  const [guide, setGuide] = useState("Every number here is live. Double-click a cell to edit it, or just start typing. In a formula, click cells to add them. Or try one:");
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

  // Embed autoplay: the hero changes the tax rate every few seconds, so a visitor sees 3M cells
  // recompute before they touch anything. It stops for good at the first click or key press.
  useEffect(() => {
    if (!autoplay || !ready) return;
    const rates = ["12%", "5%", "8%"];
    let i = 0;
    const id = setInterval(() => {
      if (s.touched || document.hidden) return;
      workerRef.current?.postMessage({ type: "edit", col: 10, row: 1, text: rates[i++ % rates.length] });
    }, 3200);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoplay, ready]);

  const runBench = () => { setBenchBusy(true); setBench(null); workerRef.current?.postMessage({ type: "bench" }); };

  const selInfo = inspect && inspect.col === sel.col && inspect.row === sel.row ? inspect : null;

  return (
    <div
      className={`app ${variant} theme-${theme.name}`}
      style={{
        "--bg": C.bg, "--chrome": C.headBg, "--line": C.line, "--text": C.text, "--muted": C.muted,
        "--accent": C.accent, "--accent-rgb": C.accentRgb, "--on-accent": C.onAccent, "--error": C.error,
        "--font": C.font, "--mono": C.mono,
      } as React.CSSProperties}
    >
      <header className="bar">
        <div className="title">
          <span className="name">{title}</span>
          <span className="meta">{ready ? `${fmtInt(orders)} orders · ${fmtInt(ready.formulas)} formulas` : "Loading"}</span>
        </div>
        <div className="formula">
          <span className="namebox">{cellName(sel.col, sel.row)}</span>
          <span className="fx">ƒ</span>
          <input
            ref={inputRef}
            value={formula}
            spellCheck={false}
            onChange={(e) => { s.editing = true; setFormula(e.target.value); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commit(e.shiftKey ? -1 : 1); }
              if (e.key === "Escape") { s.editing = false; setFormula(selInfo?.input ?? ""); setError(null); wrapRef.current?.focus(); }
            }}
            placeholder="Type a value or a formula, then press Return"
          />
        </div>
      </header>

      {variant === "app" && (
        <div className="try">
          <span className="guide">{guide}</span>
          <div className="actions">
            {TRY.map((t) => (
              <button key={t.label} onClick={t.run} disabled={!ready}>{t.label}</button>
            ))}
          </div>
        </div>
      )}

      <div
        className="gridwrap"
        ref={wrapRef}
        tabIndex={0}
        onKeyDown={(e) => { s.touched = true; if (e.target === wrapRef.current) onGridKey(e); }}
        onPointerDown={(e) => { s.touched = true; onPointerDown(e); }}
        onDoubleClick={onDoubleClick}
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
        <div className="thumb v" ref={vThumbRef} onPointerDown={dragThumb("y")} />
        <div className="thumb h" ref={hThumbRef} onPointerDown={dragThumb("x")} />
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
        <div className="recalc">
          {recalcing ? (
            <>Recalculating after <b>{recalcing}</b>… the grid stays live</>
          ) : error ? (
            <span className="err">{error}</span>
          ) : lastEdit ? (
            <>
              {lastEdit.kind === "undo" ? "Undo: " : lastEdit.kind === "redo" ? "Redo: " : ""}<b>{lastEdit.name}</b> changed · <b className="num">{fmtInt(lastEdit.recomputed)}</b> {lastEdit.recomputed === 1 ? "cell" : "cells"} recomputed in{" "}
              <b className="num">{fmtDur(lastEdit.ms)}</b>
              {lastEdit.slices > 1 && <> · {lastEdit.slices} slices, the grid stayed live</>}
            </>
          ) : ready ? (
            <>
              Loaded in <b className="num">{fmtDur(ready.buildMs)}</b> · full recalc of {fmtInt(ready.formulas)} formulas in <b className="num">{fmtDur(ready.recalcMs)}</b> ·{" "}
              <span className="num">{Math.round(ready.typedArrayMB)} MB</span>
            </>
          ) : null}
        </div>
        <div className="sel">
          {selInfo && selInfo.input.startsWith("=") ? (
            <>reads <span className="num">{fmtInt(selInfo.reads)}</span> · feeds <span className="num">{fmtInt(selInfo.dep.count)}</span></>
          ) : selInfo ? (
            <>feeds <span className="num">{fmtInt(selInfo.dep.count)}</span> {selInfo.dep.count === 1 ? "formula" : "formulas"}</>
          ) : null}
        </div>
        {variant === "app" && (
          <div className="right">
            <button className={toggles.heat ? "on" : ""} onClick={() => toggle("heat")}>Recalc heat</button>
            <button className={toggles.arrows ? "on" : ""} onClick={() => toggle("arrows")}>Arrows</button>
            <button onClick={runBench} disabled={!ready || benchBusy}>{benchBusy ? "Running…" : "Benchmark"}</button>
            <span className="num frame">draw {drawMs.toFixed(1)} ms</span>
          </div>
        )}
      </footer>

      {bench && (
        <div className="bench" role="dialog">
          <div className="benchhead">
            <span>Benchmark · this browser</span>
            <button onClick={() => setBench(null)} aria-label="Close">Close</button>
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
    </div>
  );
}

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
