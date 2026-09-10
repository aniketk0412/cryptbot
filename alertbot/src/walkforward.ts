import "./env.js";
import { getKlines } from "./binance.js";
import { config } from "./config.js";
import { STRATEGIES } from "./strategies.js";
import type { Candle } from "./types.js";

/**
 * `npm run walkforward` — does the measured edge HOLD across time, or is it regime-lucky?
 *
 * The audit measures each strategy's expectancy over ONE window, and we enabled/disabled
 * strategies based on that. That risks a selection effect: a strategy that looks good on a
 * lucky window may bleed on another. This splits history into chronological folds and reports
 * each enabled strategy's expectancy (avg R/trade, fixed target) per fold. A trustworthy edge
 * is POSITIVE and STABLE across folds; one that flips sign fold-to-fold is fragile/regime-
 * dependent and shouldn't be trusted. No lookahead within a fold. (Small per-fold samples are
 * noisy — read the trend, not the third decimal.)
 */

const SYMBOLS = config.watchlist;
const HISTORY = 1500;
const HORIZON = 48; // candles a trade is held before mark-to-market
const START = 60;
const FOLDS = 3;

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

async function main() {
  const bySym: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    const c = await getKlines(HISTORY, config.interval, s);
    if (c) bySym[s] = c.filter((x) => x.closed);
  }
  const strats = STRATEGIES.filter((s) => s.enabled());
  const buckets: Record<string, number[][]> = {};
  for (const s of strats) buckets[s.name] = Array.from({ length: FOLDS }, () => []);

  for (const sym of SYMBOLS) {
    const closed = bySym[sym];
    if (!closed) continue;
    const foldSize = Math.max(1, Math.floor(closed.length / FOLDS));
    const busy: Record<string, number> = {};
    for (let i = START; i < closed.length - 1; i++) {
      const ctx = { symbol: sym, closed: closed.slice(0, i + 1), price: closed[i]!.close };
      for (const strat of strats) {
        if ((busy[strat.name] ?? -1) >= i) continue;
        const sig = strat.detect(ctx);
        if (!sig || Math.abs(sig.entry - sig.stop) <= 0) continue;
        const long = sig.direction === "LONG";
        const future = closed.slice(i + 1, i + 1 + HORIZON);
        let gate = i + HORIZON;
        for (let j = 0; j < future.length; j++) {
          const c = future[j]!;
          if (long ? c.low <= sig.stop || c.high >= sig.target : c.high >= sig.stop || c.low <= sig.target) { gate = i + 1 + j; break; }
        }
        busy[strat.name] = gate;
        const fold = Math.min(FOLDS - 1, Math.floor(i / foldSize));
        buckets[strat.name]![fold]!.push(fixedR(long, sig.entry, sig.stop, sig.target, future));
      }
    }
  }

  const exp = (rs: number[]) => (rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN);
  console.log(`WALK-FORWARD — enabled strategies, ${SYMBOLS.join("/")} @ ${config.interval}, ${HISTORY} candles in ${FOLDS} chronological folds (~${Math.floor(HISTORY / FOLDS / 24)}d each)`);
  console.log(`Expectancy = avg R/trade (fixed target). Robust edge = positive & stable across folds; small per-fold n is noisy.\n`);
  console.log(`  strategy              ${Array.from({ length: FOLDS }, (_, f) => `fold${f + 1} expR/n`).map((h) => h.padStart(14)).join("")}   verdict`);
  for (const s of strats) {
    const cells = buckets[s.name]!.map((rs) => {
      const e = exp(rs);
      return `${Number.isFinite(e) ? (e >= 0 ? "+" : "") + e.toFixed(3) : "—"}/${rs.length}`;
    });
    const exps = buckets[s.name]!.map(exp);
    const finite = exps.filter((e) => Number.isFinite(e));
    const verdict = finite.length === FOLDS && finite.every((e) => e > 0)
      ? "ROBUST (positive every fold)"
      : finite.every((e) => e > -0.05)
        ? "ok (never badly negative)"
        : "FRAGILE (flips negative)";
    console.log(`  ${s.name.padEnd(20)} ${cells.map((c) => c.padStart(14)).join("")}   ${verdict}`);
  }
}

main().catch((e) => {
  console.error(`walkforward failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
