"use client";

import Grid, { THEMES } from "@/components/Grid";
import { FACTS, NAME } from "../facts";
import css from "./numbers.module.css";

// Direction A, "Numbers": a light Apple product page. One centred idea, the live product in a
// window, three measured numbers. Colour appears only in the grid's recalc flash.
export default function Numbers() {
  return (
    <main className={css.page}>
      <nav className={css.nav}>
        <span className={css.mark}>{NAME}</span>
        <div className={css.links}>
          <a href="#how">How it works</a>
          <a href="/" className={css.navCta}>Open the demo</a>
        </div>
      </nav>

      <header className={css.hero}>
        <h1>
          A million rows.
          <br />
          Every formula live.
        </h1>
        <p className={css.lede}>
          A spreadsheet engine written from scratch for the browser. Change one cell and only what depends on it recalculates, in
          microseconds. Nothing leaves your machine.
        </p>
        <div className={css.ctas}>
          <a href="/" className={css.primary}>Open the demo</a>
          <a href="#how" className={css.secondary}>How it works →</a>
        </div>
      </header>

      <section className={css.window} aria-label="The live ledger">
        <div className={css.chrome}>
          <span className={css.dot} />
          <span className={css.dot} />
          <span className={css.dot} />
          <span className={css.file}>Sales ledger — {FACTS.rows} rows</span>
        </div>
        <div className={css.grid}>
          <Grid theme={THEMES.numbers} variant="embed" autoplay />
        </div>
      </section>
      <p className={css.caption}>Live, not a video. The tax rate changes every few seconds until you click. Then it is yours.</p>

      <section className={css.stats} id="how">
        <div>
          <strong>{FACTS.smallEdit}</strong>
          <span>to recalculate a {FACTS.smallCells}-cell edit. The totals over a million rows update without a rescan.</span>
        </div>
        <div>
          <strong>{FACTS.bigEdit}</strong>
          <span>for {FACTS.bigCells} cells, in 8 ms slices, so scrolling never stops.</span>
        </div>
        <div>
          <strong>{FACTS.load}</strong>
          <span>to build and calculate {FACTS.formulas} formulas. HyperFormula takes {FACTS.hfLoad}.</span>
        </div>
      </section>

      <footer className={css.footer}>
        <span>{NAME} · an engine study by Srijit Ghosh</span>
        <span>Numbers measured on an M5 MacBook Air. Methods in the repository.</span>
      </footer>
    </main>
  );
}
