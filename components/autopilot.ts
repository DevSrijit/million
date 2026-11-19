// The hero autopilot: a script that uses the real grid the way a person would. A cursor moves to a
// cell, clicks, types a value character by character, and presses Return. The engine does the real
// work. The first touch from the visitor cancels the script, and the half-typed text is discarded.
//
// The grid supplies the actions (PilotApi). The runner owns only the order and the timing, so a
// test can drive it with a fake clock.

export class Cancelled extends Error {}

export type Cell = { col: number; row: number };

export interface PilotApi {
  /** Moves the cursor to a cell, or to the name box. Returns the travel time in ms. */
  moveTo(target: Cell | "namebox"): number;
  /** The click animation. It changes nothing in the sheet. */
  press(): void;
  select(col: number, row: number): void;
  extend(col: number, row: number): void;
  /** Shows text in the cell editor of the selected cell, without focus. Null closes it unsaved. */
  type(text: string | null): void;
  /** Shows text in the name box. Null shows the selected cell again. */
  typeName(text: string | null): void;
  /** Saves the editor text, then moves the selection one row down. Resolves when the engine is done. */
  commit(): Promise<void>;
  /** Writes cells without the cursor, in one batch. Resolves when the engine is done. */
  write(cells: [number, number, string][]): Promise<void>;
  /** What a cell holds now, as the user would type it. */
  read(col: number, row: number): string;
  show(visible: boolean): void;
}

/** Waits for `ms` of visible time. It throws Cancelled when the visitor takes over. */
export type Sleep = (ms: number) => Promise<void>;

// The ledger: C is Units, K2 the tax rate, K5:K8 the region totals. K15 is empty.
export const UNITS: Cell = { col: 2, row: 2 };
export const RATE: Cell = { col: 10, row: 1 };
export const REGIONS: [Cell, Cell] = [{ col: 10, row: 4 }, { col: 10, row: 7 }];
export const SCRATCH: Cell = { col: 10, row: 14 };
const RATES = ["12%", "5%", "15%"];
const UNIT_VALUES = ["18", "40", "3"];

// A person types at about 6 to 9 characters a second, with uneven gaps.
const keyGap = (i: number) => 95 + ((i * 37) % 70);

async function typeOut(api: PilotApi, sleep: Sleep, text: string, into: "cell" | "name") {
  for (let i = 1; i <= text.length; i++) {
    if (into === "cell") api.type(text.slice(0, i)); else api.typeName(text.slice(0, i));
    await sleep(keyGap(i));
  }
}

async function go(api: PilotApi, sleep: Sleep, target: Cell | "namebox") {
  await sleep(api.moveTo(target) + 60);
}

/** One cycle of the script. It ends with the sheet as it started. */
export async function cycle(api: PilotApi, sleep: Sleep, n: number) {
  const units0 = api.read(UNITS.col, UNITS.row);
  const rate0 = api.read(RATE.col, RATE.row);
  const scratch0 = api.read(SCRATCH.col, SCRATCH.row);
  api.show(true);

  // 1. Change one order's units: its row and a million running totals recompute.
  await go(api, sleep, UNITS);
  api.press();
  api.select(UNITS.col, UNITS.row);
  await sleep(380);
  await typeOut(api, sleep, UNIT_VALUES[n % UNIT_VALUES.length], "cell");
  await sleep(420);
  await api.commit();
  await sleep(1500);

  // 2. Go to the tax rate with the name box, then change it: every row reads it.
  await go(api, sleep, "namebox");
  api.press();
  api.typeName("");
  await sleep(260);
  await typeOut(api, sleep, "K2", "name");
  await sleep(320);
  api.typeName(null);
  api.select(RATE.col, RATE.row);
  await sleep(520);
  await go(api, sleep, RATE);
  await typeOut(api, sleep, RATES[n % RATES.length], "cell");
  await sleep(420);
  await api.commit();
  await sleep(1900);

  // 3. Drag across the region totals: the status bar shows their sum and average.
  await go(api, sleep, REGIONS[0]);
  api.press();
  api.select(REGIONS[0].col, REGIONS[0].row);
  for (let r = REGIONS[0].row + 1; r <= REGIONS[1].row; r++) {
    await sleep(api.moveTo({ col: REGIONS[0].col, row: r }) * 0.6);
    api.extend(REGIONS[0].col, r);
  }
  await sleep(2400);

  // 4. Write a formula that reads them.
  await go(api, sleep, SCRATCH);
  api.press();
  api.select(SCRATCH.col, SCRATCH.row);
  await sleep(380);
  await typeOut(api, sleep, "=MAX(K5:K8)", "cell");
  await sleep(480);
  await api.commit();
  await sleep(2600);

  // 5. Put the sheet back, then rest.
  api.show(false);
  await api.write([[UNITS.col, UNITS.row, units0], [RATE.col, RATE.row, rate0], [SCRATCH.col, SCRATCH.row, scratch0]]);
  api.select(0, 1);
  await sleep(2400);
}

/** Runs cycles until Sleep throws Cancelled. Any other error ends the pilot too. */
export async function runPilot(api: PilotApi, sleep: Sleep, startDelay = 1200) {
  try {
    await sleep(startDelay);
    for (let n = 0; ; n++) await cycle(api, sleep, n);
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
  }
}
