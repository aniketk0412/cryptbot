import "./env.js";
import { getKlines } from "./binance.js";
import { config } from "./config.js";
import { buildConfirmPlan } from "./plan.js";
import { detectRegime } from "./regime.js";
import { detectRange } from "./range.js";
import { confirmsResistance, confirmsSupport } from "./signals.js";
import { STRATEGIES } from "./strategies.js";
import type { Candle, Level } from "./types.js";

/**
 * `npm run regimeedge` — does each strategy's edge depend on the REGIME it fires in?
 *
 * The walk-forward showed TSMOM decays "in choppy markets" and bollinger flips sign — classic
 * signs of a strategy run in the WRONG regime (momentum needs trends; mean-reversion needs
 * ranges). This buckets each strategy's trades by the regime at entry (trend / range / volatile)
 * and reports expectancy (avg R/trade, fixed target) per regime. If TSMOM is clearly +EV in
 * trends and −EV in ranges (and bollinger the opposite), that VALIDATES regime-gating: run each
 * strategy only where it has a measured edge — turning fragile strategies into regime specialists
 * instead of disabling them. No lookahead. Small per-cell samples are noisy — read the pattern.
 */

const SYMBOLS = config.watchlist;
const HISTORY = 1500;
const HORIZON = 48;
const START = 60;
const REGIMES = ["trend", "range", "volatile"] as const;
type RegimeClass = (typeof REGIMES)[number];

function classify(r: string): RegimeClass {
  return r === "uptrend" || r === "downtrend" ? "trend" : r === "ranging" ? "range" : "volatile";
}

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
  const sourceNames = [...strats.map((s) => s.name), "S/R-confirmation"];
  const buckets: Record<string, Record<RegimeClass, number[]>> = {};
  for (const name of sourceNames) buckets[name] = { trend: [], range: [], volatile: [] };

  for (const sym of SYMBOLS) {
    const closed = bySym[sym];
    if (!closed) continue;
    const busy: Record<string, number> = {};
    for (let i = START; i < closed.length - 1; i++) {
      const window = closed.slice(0, i + 1);
      const reg = classify(detectRegime(window).regime);
      const ctx = { symbol: sym, closed: window, price: closed[i]!.close };
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
        buckets[strat.name]![reg].push(fixedR(long, sig.entry, sig.stop, sig.target, future));
      }
      // S/R confirmations (the founding feature) by regime, honest close entry.
      const range = detectRange(window);
      if (range.consolidating) {
        const candle = closed[i]!;
        let lvl: Level | null = null;
        if (confirmsSupport(candle, range)) lvl = "support";
        else if (confirmsResistance(candle, range)) lvl = "resistance";
        if (lvl) {
          const p = buildConfirmPlan(lvl, range, candle.close, true);
          if (Math.abs(p.entry - p.stop) > 0) {
            buckets["S/R-confirmation"]![reg].push(fixedR(p.direction === "LONG", p.entry, p.stop, p.target, closed.slice(i + 1, i + 1 + HORIZON)));
          }
        }
      }
    }
  }

  const exp = (rs: number[]) => (rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN);
  console.log(`REGIME EDGE — enabled strategies × market regime, ${SYMBOLS.join("/")} @ ${config.interval}, ${HISTORY} candles`);
  console.log(`Expectancy (avg R/trade, fixed target) split by the regime at entry. Gate a strategy to the regimes where it's +EV.\n`);
  console.log(`  strategy              ${REGIMES.map((r) => (r + " expR/n").padStart(15)).join("")}   suggestion`);
  for (const name of sourceNames) {
    const cells = REGIMES.map((r) => {
      const rs = buckets[name]![r];
      const e = exp(rs);
      return `${Number.isFinite(e) ? (e >= 0 ? "+" : "") + e.toFixed(3) : "—"}/${rs.length}`;
    });
    const good = REGIMES.filter((r) => { const e = exp(buckets[name]![r]); return Number.isFinite(e) && e > 0 && buckets[name]![r].length >= 8; });
    const suggestion = good.length && good.length < REGIMES.length ? `gate → ${good.join("+")}` : good.length === REGIMES.length ? "keep (all regimes +)" : "weak everywhere — review";
    console.log(`  ${name.padEnd(20)} ${cells.map((c) => c.padStart(15)).join("")}   ${suggestion}`);
  }
  console.log(`\n(“gate → X” = the strategy is only +EV in regime X on this window, so running it only there should lift its edge. Validate on the portfolio harness before wiring in; small n is noisy.)`);
}

main().catch((e) => {
  console.error(`regimeedge failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
