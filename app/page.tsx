"use client";

import Grid, { THEMES } from "@/components/Grid";
import { FACTS, NAME } from "./facts";
import css from "./landing.module.css";

// The landing page, in the "Numbers" direction: a light Apple product page. One centred idea,
// the live product in a window, measured numbers, then how it works. Colour appears only in the
// grid's recalc flash, the links, and the window's traffic lights.

const IDEAS = [
  {
    title: "One function per column",
    body: "A filled-down column is compiled once into a JavaScript function. Every row shares it, so 4,000,009 formulas need eleven functions.",
    code: "=C2*D2  →  (r) => C[r] * D[r]",
  },
  {
    title: "Dependents by arithmetic",
    body: "No cell stores who reads it. The engine works it out from each formula's shape, so a range of a million cells is one index entry, not a million edges.",
    code: "G5 changes  →  H5 = H4 + G5",
  },
  {
    title: "Totals that keep themselves",
    body: "Sums, SUMIF groups and lookups watch every write and adjust by the difference. Changing one order never adds up a million rows again.",
    code: "SUM(G:G) += new − old",
  },
  {
    title: "Work in slices",
    body: "A big edit runs on a worker in 8 ms slices. Between slices the grid keeps scrolling, and cells update in place as they finish.",
    code: "run 8 ms → yield → repeat",
  },
];

// Same ledger, same machine (Bun, M5 MacBook Air). Values in a common unit, so the bars are linear.
const COMPARE = [
  { label: `Build and calculate ${FACTS.formulas} formulas`, ours: 0.2, theirs: 84.6, oursText: FACTS.load, theirsText: FACTS.hfLoad },
  { label: `Edit one order (${FACTS.smallCells} cells)`, ours: 0.005, theirs: 2062, oursText: FACTS.smallEditBun, theirsText: FACTS.hfSmall },
  { label: "Peak memory", ours: 0.187, theirs: 7.4, oursText: FACTS.mem, theirsText: FACTS.hfMem },
];

export default function Landing() {
  return (
    <main className={css.page}>
      <nav className={css.nav}>
        <span className={css.mark}>{NAME}</span>
        <div className={css.links}>
          <a href="#how">How it works</a>
          <a href="#compare">Compare</a>
          <a href="/sheet" className={css.navCta}>Open the demo</a>
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
          <a href="/sheet" className={css.primary}>Open the demo</a>
          <a href="#how" className={css.secondary}>How it works →</a>
        </div>
      </header>

      <section className={css.window} aria-label="The live ledger">
        <div className={css.chrome}>
          <span className={css.lights} aria-hidden>
            <span className={css.light} />
            <span className={css.light} />
            <span className={css.light} />
          </span>
          <span className={css.file}>Sales ledger <span>{FACTS.rows} rows</span></span>
        </div>
        <div className={css.grid}>
          <Grid theme={THEMES.numbers} variant="embed" autoplay />
        </div>
      </section>
      <p className={css.caption}>Live, not a video. The cursor is a script that drives the real engine. Click anywhere in the sheet and it is yours.</p>

      <section className={css.stats}>
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
          <span>to build and calculate {FACTS.formulas} formulas when the page opens.</span>
        </div>
      </section>

      <section className={css.section} id="how">
        <h2>Four ideas, no shortcuts.</h2>
        <div className={css.ideas}>
          {IDEAS.map((idea) => (
            <article key={idea.title} className={css.idea}>
              <h3>{idea.title}</h3>
              <p>{idea.body}</p>
              <code>{idea.code}</code>
            </article>
          ))}
        </div>
      </section>

      <section className={css.section} id="compare">
        <h2>The same ledger in HyperFormula.</h2>
        <p className={css.sectionLede}>
          HyperFormula is the strongest open-source JavaScript formula engine. Both engines ran the same million-order ledger on the
          same machine. The bars share one linear scale per row.
        </p>
        <div className={css.compare}>
          {COMPARE.map((row) => (
            <div key={row.label} className={css.compareRow}>
              <span className={css.compareLabel}>{row.label}</span>
              <div className={css.bars}>
                <div className={css.barLine}>
                  <span className={css.barName}>{NAME}</span>
                  <span className={css.track}>
                    <span className={`${css.bar} ${css.ours}`} style={{ width: `${Math.max(0.4, (row.ours / row.theirs) * 100)}%` }} />
                  </span>
                  <span className={css.barValue}>{row.oursText}</span>
                </div>
                <div className={css.barLine}>
                  <span className={css.barName}>HyperFormula</span>
                  <span className={css.track}>
                    <span className={css.bar} style={{ width: "100%" }} />
                  </span>
                  <span className={css.barValue}>{row.theirsText}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
        <p className={css.fine}>
          Bun 1.4 on an M5 MacBook Air, 16 GB. A {NAME} bar shorter than 0.4% of the row is drawn at 0.4% so it stays visible. In
          Chrome, the same small edit takes {FACTS.smallEdit}. Methods and raw numbers are in the repository.
        </p>
      </section>

      <section className={css.closing}>
        <h2>Try to slow it down.</h2>
        <p>Edit the first order, change the tax rate, write your own SUMIF over a million rows. Or drop in your own CSV: it is read on your machine and never uploaded.</p>
        <a href="/sheet" className={css.primary}>Open the demo</a>
      </section>

      <footer className={css.footer}>
        <span>{NAME} · an engine study by Srijit Ghosh</span>
        <span>Measured on an M5 MacBook Air. Nothing leaves your machine.</span>
      </footer>
    </main>
  );
}
