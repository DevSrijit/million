"use client";

import Grid, { THEMES } from "@/components/Grid";
import { FACTS, NAME } from "../facts";
import css from "./ink.module.css";

// Direction B, "Ink": black and white, in the Vercel / Evil Rabbit tradition. Left-aligned,
// terse, monospace figures. The live ledger runs full width; the proof is a plain table.
export default function Ink() {
  return (
    <main className={css.page}>
      <nav className={css.nav}>
        <span className={css.mark}>
          <span className={css.glyph} aria-hidden>▦</span> {NAME.toLowerCase()}
        </span>
        <div className={css.links}>
          <a href="#numbers">numbers</a>
          <a href="#how">engine</a>
          <a href="/" className={css.navCta}>open demo ↗</a>
        </div>
      </nav>

      <header className={css.hero}>
        <p className={css.kicker}>spreadsheet engine · browser · from scratch</p>
        <h1>
          {FACTS.formulas} live formulas.
          <br />
          <span className={css.dim}>One edit: {FACTS.smallEdit}.</span>
        </h1>
        <div className={css.row}>
          <p className={css.lede}>
            Change a cell and only its dependents run. Totals over a million rows update by delta, not by rescan. Big edits run in 8
            ms slices on a worker, so the grid never stops drawing.
          </p>
          <a href="/" className={css.primary}>open the demo</a>
        </div>
      </header>

      <section className={css.live} aria-label="The live ledger">
        <div className={css.label}>
          <span>fig. 1</span>
          <span>sales ledger — {FACTS.rows} rows — live</span>
        </div>
        <div className={css.grid}>
          <Grid theme={THEMES.ink} variant="embed" autoplay />
        </div>
      </section>

      <section className={css.table} id="numbers">
        <div className={css.label}>
          <span>fig. 2</span>
          <span>same ledger, same machine</span>
        </div>
        <table>
          <thead>
            <tr><th>operation</th><th>cells</th><th>{NAME.toLowerCase()}</th><th>hyperformula 3.5</th></tr>
          </thead>
          <tbody>
            <tr><td>build + calculate</td><td>{FACTS.formulas}</td><td>{FACTS.load}</td><td>{FACTS.hfLoad}</td></tr>
            <tr><td>edit one order</td><td>{FACTS.smallCells}</td><td>{FACTS.smallEditBun}</td><td>{FACTS.hfSmall}</td></tr>
            <tr><td>peak memory</td><td>—</td><td>{FACTS.mem}</td><td>{FACTS.hfMem}</td></tr>
          </tbody>
        </table>
        <p className={css.note}>Both engines in Bun on an M5 MacBook Air. In Chrome the same edit takes {FACTS.smallEdit}. Methods in the repository.</p>
      </section>

      <section className={css.how} id="how">
        <div className={css.label}>
          <span>fig. 3</span>
          <span>how</span>
        </div>
        <ol>
          <li><b>templates</b> one compiled function per fill-down, not per cell</li>
          <li><b>reverse index</b> dependents found by arithmetic; a range is one entry</li>
          <li><b>watchers</b> sums, SUMIF groups and lookups update in O(1) per write</li>
          <li><b>slices</b> a resumable recalc that yields every 8 ms</li>
        </ol>
      </section>

      <footer className={css.footer}>
        <span>{NAME.toLowerCase()} — an engine study by srijit ghosh</span>
        <span>nothing leaves your machine</span>
      </footer>
    </main>
  );
}
