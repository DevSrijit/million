"use client";

import Grid, { THEMES } from "@/components/Grid";
import { FACTS, NAME } from "../facts";
import css from "./paper.module.css";

// Direction C, "Paper": an editorial ledger book. A serif headline (Apple's New York), warm paper,
// numbered figures with captions, and margin notes. One ink-green accent, used for the recalc flash.
export default function Paper() {
  return (
    <main className={css.page}>
      <nav className={css.nav}>
        <span className={css.mark}>{NAME}</span>
        <span className={css.issue}>An engine study · No. 1</span>
        <a href="/" className={css.navCta}>Open the ledger</a>
      </nav>

      <header className={css.hero}>
        <h1>The ledger that keeps its own books.</h1>
        <div className={css.columns}>
          <p className={css.lede}>
            A million orders, four million formulas, and a spreadsheet engine written from scratch to hold them. Change one figure and
            only what depends on it is worked out again — in {FACTS.smallEdit}.
          </p>
          <aside className={css.margin}>
            <span>Margin note</span>
            Nothing is uploaded. The whole book lives in your browser tab, on your machine.
          </aside>
        </div>
        <a href="/" className={css.primary}>Open the ledger</a>
      </header>

      <figure className={css.figure}>
        <div className={css.grid}>
          <Grid theme={THEMES.paper} variant="embed" autoplay />
        </div>
        <figcaption>
          <b>Fig. 1</b> The sales ledger, live. Every few seconds the tax rate in K2 changes, and {FACTS.bigCells} figures are
          worked out again in {FACTS.bigEdit}, in slices, without stopping the page. Click to take over.
        </figcaption>
      </figure>

      <section className={css.essay} id="how">
        <h2>How the book is kept</h2>
        <div className={css.essayCols}>
          <p>
            <b>One formula, a million rows.</b> A filled-down column is compiled once. Every row shares the same small function, so
            four million formulas need only eleven compiled functions.
          </p>
          <p>
            <b>Dependents by arithmetic.</b> The engine never stores who reads whom per cell. It works the answer out from the
            formula&apos;s shape, so a range of a million cells is one entry.
          </p>
          <p>
            <b>Totals that keep themselves.</b> Sums, regional subtotals and lookups watch every write and adjust by the difference.
            A small change never adds up a million rows again.
          </p>
        </div>
      </section>

      <section className={css.ledger}>
        <h2>Fig. 2 · The same ledger, two engines</h2>
        <table>
          <thead>
            <tr><th />
              <th>{NAME}</th>
              <th>HyperFormula 3.5</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Open the book ({FACTS.formulas} formulas)</td><td>{FACTS.load}</td><td>{FACTS.hfLoad}</td></tr>
            <tr><td>Correct one order ({FACTS.smallCells} figures)</td><td>{FACTS.smallEditBun}</td><td>{FACTS.hfSmall}</td></tr>
            <tr><td>Memory at its peak</td><td>{FACTS.mem}</td><td>{FACTS.hfMem}</td></tr>
          </tbody>
        </table>
        <p className={css.small}>Both engines run in Bun on an M5 MacBook Air. Methods and raw figures are in the repository.</p>
      </section>

      <footer className={css.footer}>
        <span>{NAME}, kept by Srijit Ghosh</span>
        <span>Set in New York and SF Pro</span>
      </footer>
    </main>
  );
}
