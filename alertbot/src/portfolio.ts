import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getKlines } from "./binance.js";
import { config } from "./config.js";
import { buildConfirmPlan } from "./plan.js";
import { detectRange } from "./range.js";
import { confirmsResistance, confirmsSupport } from "./signals.js";
import { STRATEGIES } from "./strategies.js";
import { correlatedCapReached, resolveExit } from "./paperexit.js";
import type { Candle } from "./types.js";

/**
 * `npm run portfolio` — PORTFOLIO-LEVEL backtest.
 *
 * backtest.ts is one symbol; audit.ts is one position per strategy. Neither models what
 * actually happens live: several symbols trading AT ONCE against ONE shared, compounding
 * balance. This replays the whole watchlist in lockstep with the paper engine's real
 * open/close/sizing rules, so it can measure the effect of holding correlated positions
 * simultaneously — and TUNE config.paper.maxSameDirection (the correlation cap) with data
 * instead of a guess. It runs the sim for several cap values and ranks them by risk-adjusted
 * return (return / max-drawdown = a Calmar-style ratio).
 *
 * Sources modeled: enabled strategy setups + S/R confirmations (what the paper engine takes).
 * Reversal/failed-breakout is stateful and excluded (v1). NO lookahead: signals at candle i
 * use only candles 0..i; a position opened at i is judged on candles > i; stop-first on ties.
 */

const SYMBOLS = config.watchlist;
const HISTORY = 1500;
const START = 60; // warm-up: strategies need up to ~60 candles

interface Signal { symbol: string; source: string; long: boolean; entry: number; stop: number; target: number }
interface Position extends Signal { openI: number; sizeUnits: number; riskUsd: number }
interface Trade { pnl: number; win: boolean }

/** Signals fired at the newest candle of `window` (strategies + S/R confirmation), mirroring checkSymbol. */
function signalsAt(symbol: string, window: Candle[]): Signal[] {
  const out: Signal[] = [];
  const last = window[window.length - 1]!;
  if (config.paper.takeStrategies) {
    const ctx = { symbol, closed: window, price: last.close };
    for (const strat of STRATEGIES) {
      if (!strat.enabled()) continue;
      const s = strat.detect(ctx);
      if (!s) continue;
      const risk = Math.abs(s.entry - s.stop);
      const reward = Math.abs(s.target - s.entry);
      if (risk <= 0 || reward / risk < config.paper.minRR) continue;
      out.push({ symbol, source: s.strategy, long: s.direction === "LONG", entry: s.entry, stop: s.stop, target: s.target });
    }
  }
  if (config.paper.takeConfirmations) {
    const range = detectRange(window);
    if (range.consolidating) {
      let level: "support" | "resistance" | null = null;
      if (confirmsSupport(last, range)) level = "support";
      else if (confirmsResistance(last, range)) level = "resistance";
      if (level) {
        // Honest fill: confirmations enter at the candle CLOSE (not the level's phantom limit),
        // so the portfolio number reflects fills you'd actually get — see `npm run confirmedge`.
        const p = buildConfirmPlan(level, range, last.close, true);
        const risk = Math.abs(p.entry - p.stop);
        const reward = Math.abs(p.target - p.entry);
        if (risk > 0 && reward / risk >= config.paper.minRR) {
          out.push({ symbol, source: level, long: p.direction === "LONG", entry: p.entry, stop: p.stop, target: p.target });
        }
      }
    }
  }
  return out;
}

function simulate(bySym: Record<string, Candle[]>, sigAt: Record<string, Signal[][]>, maxSameDir: number) {
  const feeRate = config.paper.feeBps / 10000;
  const slip = config.paper.slippageBps / 10000;
  const start: number = config.paper.startBalanceUsd;
  let balance = start;
  const open: Position[] = [];
  const trades: Trade[] = [];
  const curve: number[] = [start];
  const n = Math.min(...SYMBOLS.map((s) => bySym[s]?.length ?? 0));

  for (let i = START; i < n; i++) {
    // 1) Exits — each open position vs ITS symbol's candle i (it was opened earlier).
    for (let k = open.length - 1; k >= 0; k--) {
      const p = open[k]!;
      if (i <= p.openI) continue;
      const c = bySym[p.symbol]![i]!;
      const hit = resolveExit(p.long, p.stop, p.target, c.low, c.high, slip);
      if (hit) {
        const fees = feeRate * p.sizeUnits * (p.entry + hit.exit);
        const pnl = (p.long ? 1 : -1) * (hit.exit - p.entry) * p.sizeUnits - fees;
        balance += pnl;
        trades.push({ pnl, win: pnl > 0 });
        curve.push(balance);
        open.splice(k, 1);
      }
    }
    // 2) Entries — signals at candle i, respecting maxOpenPerSymbol + the correlation cap.
    for (const sym of SYMBOLS) {
      for (const sig of sigAt[sym]![i]!) {
        if (open.filter((o) => o.symbol === sym).length >= config.paper.maxOpenPerSymbol) continue;
        const dir = sig.long ? "LONG" : "SHORT";
        if (correlatedCapReached(open.map((o) => ({ direction: o.long ? "LONG" : "SHORT" })), dir, maxSameDir)) continue;
        const risk = Math.abs(sig.entry - sig.stop);
        if (risk <= 0) continue;
        const riskUsd = (balance * config.paper.riskPct) / 100;
        open.push({ ...sig, openI: i, sizeUnits: riskUsd / risk, riskUsd });
      }
    }
  }

  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  let peak = start;
  let maxDD = 0;
  for (const b of curve) {
    if (b > peak) peak = b;
    const dd = peak > 0 ? ((peak - b) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }
  const returnPct = ((balance - start) / start) * 100;
  return {
    maxSameDir,
    trades: trades.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    returnPct,
    maxDrawdownPct: maxDD,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    calmar: maxDD > 0 ? returnPct / maxDD : returnPct > 0 ? Infinity : 0, // return per unit of drawdown
    endBalance: balance,
  };
}

async function main() {
  console.log(`PORTFOLIO BACKTEST — ${SYMBOLS.join("/")} @ ${config.interval}, ${HISTORY} candles, one shared $${config.paper.startBalanceUsd} balance\n`);
  const bySym: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    const c = await getKlines(HISTORY, config.interval, s);
    if (c) bySym[s] = c.filter((x) => x.closed);
  }
  if (SYMBOLS.some((s) => !bySym[s])) {
    console.error("failed to fetch history for some symbols");
    process.exit(1);
  }

  // Pre-generate signals ONCE (they don't depend on the cap) so each cap sim is cheap.
  const sigAt: Record<string, Signal[][]> = {};
  for (const sym of SYMBOLS) {
    const c = bySym[sym]!;
    const arr: Signal[][] = [];
    for (let i = 0; i < c.length; i++) arr[i] = i >= START ? signalsAt(sym, c.slice(0, i + 1)) : [];
    sigAt[sym] = arr;
  }

  const caps = [1, 2, SYMBOLS.length]; // 1, 2, and effectively-unlimited (= watchlist size)
  const results = caps.map((cap) => simulate(bySym, sigAt, cap));

  console.log("  cap        trades  win    return    maxDD    PF      ret/DD   endBal");
  for (const r of results) {
    const cap = r.maxSameDir >= SYMBOLS.length ? `${r.maxSameDir} (off)` : `${r.maxSameDir}`;
    const pf = r.profitFactor === Infinity ? "inf" : r.profitFactor.toFixed(2);
    const cal = r.calmar === Infinity ? "inf" : r.calmar.toFixed(2);
    console.log(
      `  ${cap.padEnd(9)} ${String(r.trades).padStart(5)}  ${(r.winRate.toFixed(0) + "%").padStart(4)}  ` +
        `${((r.returnPct >= 0 ? "+" : "") + r.returnPct.toFixed(1) + "%").padStart(7)}  ${(r.maxDrawdownPct.toFixed(1) + "%").padStart(6)}  ` +
        `${pf.padStart(5)}  ${cal.padStart(6)}   $${r.endBalance.toFixed(0)}`,
    );
  }
  const best = [...results].sort((a, b) => b.calmar - a.calmar)[0]!;
  console.log(`\nBest risk-adjusted (return / maxDD): maxSameDirection = ${best.maxSameDir >= SYMBOLS.length ? "off (no cap)" : best.maxSameDir}`);
  console.log("(Higher ret/DD = more return per unit of drawdown. A tiny sample is still noisy — re-run as history grows.)");

  const out = { generatedAt: new Date().toISOString(), symbols: SYMBOLS, interval: config.interval, historyCandles: HISTORY, results };
  await mkdir(dirname("data/portfolio.json"), { recursive: true });
  await writeFile("data/portfolio.json", JSON.stringify(out, null, 2), "utf8");
  console.log("\nSaved → data/portfolio.json");
}

main().catch((e) => {
  console.error(`portfolio failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
