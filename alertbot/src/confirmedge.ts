import "./env.js";
import { getKlines } from "./binance.js";
import { config } from "./config.js";
import { buildPlan } from "./plan.js";
import { detectRange } from "./range.js";
import { confirmsResistance, confirmsSupport } from "./signals.js";
import type { Candle, Level } from "./types.js";

/**
 * `npm run confirmedge` — are the S/R CONFIRMATION trades actually +EV with their REAL plan?
 *
 * The founding feature (touch → confirmation → trade) paper-trades confirmations using
 * `buildPlan`: entry at the level, a TIGHT stop (stopBufferPct, ~0.3%), and target at the
 * OPPOSITE range level — often ~9:1 reward:risk. But the backtest only ever validated
 * confirmations at a FIXED 1.5%/1.0% target/stop — a totally different geometry. So the live
 * confirmation edge was never measured. This does: it replays confirmations with the ACTUAL
 * buildPlan geometry (fixed-target expectancy in R, first-touch, no lookahead), and compares it
 * against closer targets (2R, 3R same stop) to see whether a far target quietly bleeds and a
 * nearer one would be +EV. If the real geometry is negative, that's a concrete fix: nearer target.
 */

const SYMBOLS = config.watchlist;
const HISTORY = 1500;
const HORIZON = 48;
const FILL_WINDOW = 12; // candles a limit at the level waits for a retest before it's stale (realistic-fill model)

function fixedR(long: boolean, entry: number, stop: number, target: number, future: Candle[]): number {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return 0;
  for (const c of future) {
    if (long) {
      if (c.low <= stop) return -1;
      if (c.high >= target) return (target - entry) / risk;
    } else {
      if (c.high >= stop) return -1;
      if (c.low <= target) return (entry - target) / risk;
    }
  }
  const last = future[future.length - 1];
  return last ? (long ? last.close - entry : entry - last.close) / risk : 0;
}

/**
 * Realistic fill: a confirmation books a limit at the level, but the rejection candle already
 * closed the other side of it — so the fill only happens if price RETESTS the level within
 * FILL_WINDOW candles. Returns the trade's R if it filled (evaluated from after the fill), or
 * null if it never filled (in reality you'd simply have no trade). The assume-fill model instead
 * counts every signal as filled at the level — inflating results with "missed limit" winners.
 */
function realisticR(long: boolean, entry: number, stop: number, target: number, future: Candle[]): number | null {
  let fillIdx = -1;
  for (let j = 0; j < Math.min(FILL_WINDOW, future.length); j++) {
    const c = future[j]!;
    if (long ? c.low <= entry : c.high >= entry) { fillIdx = j; break; }
  }
  if (fillIdx < 0) return null; // limit never filled → no trade
  return fixedR(long, entry, stop, target, future.slice(fillIdx + 1));
}

function agg(rs: number[]) {
  const n = rs.length;
  const w = rs.filter((r) => r > 0).length;
  const tot = rs.reduce((a, b) => a + b, 0);
  const gp = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const gl = Math.abs(rs.filter((r) => r <= 0).reduce((a, b) => a + b, 0));
  return { n, win: n ? (w / n) * 100 : 0, exp: n ? tot / n : 0, pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0 };
}

async function main() {
  const bySym: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    const c = await getKlines(HISTORY, config.interval, s);
    if (c) bySym[s] = c.filter((x) => x.closed);
  }
  const farR: number[] = [];
  const r2: number[] = [];
  const r3: number[] = [];
  const rrs: number[] = [];
  const realR: number[] = []; // realistic-fill (retest required) far-target outcomes
  const mktR: number[] = []; // realistic: enter at market on the confirmation close (fills immediately, no phantom limit)

  for (const sym of SYMBOLS) {
    const closed = bySym[sym];
    if (!closed) continue;
    for (let i = config.lookback; i < closed.length - HORIZON; i++) {
      const window = closed.slice(0, i + 1);
      const range = detectRange(window);
      if (!range.consolidating) continue;
      const candle = closed[i]!;
      let level: Level | null = null;
      if (confirmsSupport(candle, range)) level = "support";
      else if (confirmsResistance(candle, range)) level = "resistance";
      if (!level) continue;
      const plan = buildPlan(level, range);
      const risk = Math.abs(plan.entry - plan.stop);
      if (risk <= 0) continue;
      const long = plan.direction === "LONG";
      const sign = long ? 1 : -1;
      const future = closed.slice(i + 1, i + 1 + HORIZON);
      rrs.push(plan.rr);
      farR.push(fixedR(long, plan.entry, plan.stop, plan.target, future)); // real buildPlan far target (assume-fill)
      const rReal = realisticR(long, plan.entry, plan.stop, plan.target, future);
      if (rReal !== null) realR.push(rReal); // only counts if the limit actually retested/filled
      mktR.push(fixedR(long, candle.close, plan.stop, plan.target, future)); // enter at the close (worse entry, bigger risk, but a REAL fill)
      r2.push(fixedR(long, plan.entry, plan.stop, plan.entry + sign * 2 * risk, future));
      r3.push(fixedR(long, plan.entry, plan.stop, plan.entry + sign * 3 * risk, future));
    }
  }

  const avgRR = rrs.length ? rrs.reduce((a, b) => a + b, 0) / rrs.length : 0;
  console.log(`CONFIRMATION EDGE — S/R confirmations with their REAL plan, ${SYMBOLS.join("/")} @ ${config.interval}, ${HISTORY} candles`);
  console.log(`Live plan: entry at level, ${config.plan.stopBufferPct}% stop, target = opposite range level (avg R:R ${avgRR.toFixed(1)}).\n`);
  console.log("  target geometry     trades  win     expR      PF");
  const row = (name: string, rs: number[]) => {
    const a = agg(rs);
    console.log(`  ${name.padEnd(18)} ${String(a.n).padStart(5)}   ${(a.win.toFixed(0) + "%").padStart(4)}   ${((a.exp >= 0 ? "+" : "") + a.exp.toFixed(3) + "R").padStart(8)}   ${(a.pf === Infinity ? "inf" : a.pf.toFixed(2)).padStart(5)}`);
  };
  row(`far (real, ~${avgRR.toFixed(0)}R)`, farR);
  row("2R target", r2);
  row("3R target", r3);
  row("far, REALISTIC fill", realR);
  row("market @ close", mktR);
  const fillRate = farR.length ? (realR.length / farR.length) * 100 : 0;
  console.log(`\n  assume-fill = paper account (limit fills at the level even if price never retested — optimistic).`);
  console.log(`  REALISTIC fill = only the ${fillRate.toFixed(0)}% of limits that actually retested within ${FILL_WINDOW} candles.`);
  console.log(`  market @ close = enter at the confirmation candle's close (fills immediately, a REAL entry — the honest fix candidate).`);

  const far = agg(farR), real = agg(realR), mkt = agg(mktR);
  console.log(`\nVERDICT: paper books +${far.exp.toFixed(2)}R (mirage). Honest models: retest-limit ${real.exp >= 0 ? "+" : ""}${real.exp.toFixed(3)}R, market-at-close ${mkt.exp >= 0 ? "+" : ""}${mkt.exp.toFixed(3)}R (${mkt.win.toFixed(0)}% win, PF ${mkt.pf === Infinity ? "inf" : mkt.pf.toFixed(2)}). ` +
    `${mkt.exp > 0.02 ? "→ MARKET-AT-CLOSE is +EV: change buildPlan to enter confirmations at the close (honest AND profitable), then the paper account stops lying." : mkt.exp > -0.02 ? "→ market-at-close is ~break-even: confirmations aren't a real money-maker once fills are honest — lean on breakout-retest." : "→ confirmations are NEGATIVE with any honest fill — the paper account's confirmation edge is pure artifact; lean on breakout-retest."} In-sample; validate before changing money code.`);
}

main().catch((e) => {
  console.error(`confirmedge failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
