import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getKlines } from "./binance.js";
import { config } from "./config.js";
import { emaLast } from "./indicators.js";
import { detectRange } from "./range.js";
import { confirmsResistance, confirmsSupport } from "./signals.js";
import { fvgFactor, premiumDiscountFactor, structureFactor, sweepFactor } from "./structure.js";
import type { Candle, Level } from "./types.js";

/**
 * Replay history: at every candle, using ONLY past data, detect a confirmation at
 * a consolidation range's support/resistance, record which confluence factors
 * were present, then judge the outcome over the next `horizon` candles (did price
 * move `targetPct` in favor before `stopPct` against). Aggregate win rates overall,
 * by score, and PER FACTOR — so we can see which factors actually help.
 *
 * Honest limits: the live "order-book wall" factor uses real-time depth, which has
 * no historical feed, so it's excluded here (7 backtestable factors, not 8). This
 * uses AUTO range detection (manual levels are a single snapshot).
 */

const FACTORS = ["rejection", "flow", "fvg", "sweep", "premium/discount", "structure", "HTF"] as const;
type FactorName = (typeof FACTORS)[number];

interface Signal {
  time: string;
  level: Level;
  entry: number;
  score: number;
  present: Record<FactorName, boolean>;
  outcome: "win" | "loss" | "timeout";
  maxR: number; // max favorable excursion in R before the stop was hit
}

function htfBiasAt(level: Level, timeMs: number, htfClosed: Candle[]): boolean {
  const avail = htfClosed.filter((c) => c.closeTime <= timeMs);
  if (avail.length < config.structure.htfEmaPeriod) return false;
  const closes = avail.map((c) => c.close);
  const up = closes[closes.length - 1]! > emaLast(closes, config.structure.htfEmaPeriod);
  return level === "support" ? up : !up;
}

function outcome(level: Level, entry: number, future: Candle[]): Signal["outcome"] {
  const b = config.backtest;
  const target = level === "support" ? entry * (1 + b.targetPct / 100) : entry * (1 - b.targetPct / 100);
  const stop = level === "support" ? entry * (1 - b.stopPct / 100) : entry * (1 + b.stopPct / 100);
  for (const c of future) {
    if (level === "support") {
      if (c.low <= stop) return "loss"; // check stop first (conservative on same-candle ties)
      if (c.high >= target) return "win";
    } else {
      if (c.high >= stop) return "loss";
      if (c.low <= target) return "win";
    }
  }
  return "timeout";
}

/** Max favorable move in R-multiples reached before the stop was hit. */
function maxFavorableR(level: Level, entry: number, future: Candle[]): number {
  const b = config.backtest;
  const stop = level === "support" ? entry * (1 - b.stopPct / 100) : entry * (1 + b.stopPct / 100);
  const R = Math.abs(entry - stop);
  if (R <= 0) return 0;
  let best = 0;
  for (const c of future) {
    if (level === "support") {
      if (c.low <= stop) break;
      best = Math.max(best, (c.high - entry) / R);
    } else {
      if (c.high >= stop) break;
      best = Math.max(best, (entry - c.low) / R);
    }
  }
  return best;
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—";
}

async function main() {
  const b = config.backtest;
  console.log(`Backtesting ${config.symbol} ${config.interval} over ${b.historyCandles} candles…`);
  console.log(`win = +${b.targetPct}% before -${b.stopPct}% within ${b.horizon} candles\n`);

  const candles = await getKlines(b.historyCandles);
  if (!candles) {
    console.error("failed to fetch history");
    process.exit(1);
  }
  const closed = candles.filter((c) => c.closed);
  const htf = (await getKlines(400, config.structure.htfInterval)) ?? [];
  const htfClosed = htf.filter((c) => c.closed);

  const signals: Signal[] = [];
  for (let i = config.lookback; i < closed.length - b.horizon; i++) {
    const window = closed.slice(0, i + 1);
    const range = detectRange(window);
    if (!range.consolidating) continue;

    const candle = closed[i]!;
    let level: Level | null = null;
    if (confirmsSupport(candle, range)) level = "support";
    else if (confirmsResistance(candle, range)) level = "resistance";
    if (!level) continue;

    const price = candle.close;
    const delta = 2 * candle.takerBuyVolume - candle.volume;
    const present: Record<FactorName, boolean> = {
      rejection: true,
      flow: level === "support" ? delta > 0 : delta < 0,
      fvg: fvgFactor(level, price, window).ok,
      sweep: sweepFactor(level, window).ok,
      "premium/discount": premiumDiscountFactor(level, price, window).ok,
      structure: structureFactor(level, window).ok,
      HTF: htfBiasAt(level, candle.closeTime, htfClosed),
    };
    const score = FACTORS.filter((f) => present[f]).length;
    const future = closed.slice(i + 1, i + 1 + b.horizon);
    signals.push({
      time: new Date(candle.closeTime).toISOString().slice(0, 16),
      level,
      entry: price,
      score,
      present,
      outcome: outcome(level, price, future),
      maxR: maxFavorableR(level, price, future),
    });
  }

  // ---- Aggregate ----
  const wins = signals.filter((s) => s.outcome === "win").length;
  const losses = signals.filter((s) => s.outcome === "loss").length;
  const timeouts = signals.filter((s) => s.outcome === "timeout").length;

  console.log(`Signals: ${signals.length}   win ${wins}   loss ${losses}   timeout ${timeouts}`);
  console.log(`Decisive win rate: ${pct(wins, wins + losses)}   (of all: ${pct(wins, signals.length)})\n`);

  // By score bucket
  console.log("By confluence score (decisive win rate):");
  for (let sc = 0; sc <= FACTORS.length; sc++) {
    const g = signals.filter((s) => s.score === sc);
    if (g.length === 0) continue;
    const w = g.filter((s) => s.outcome === "win").length;
    const l = g.filter((s) => s.outcome === "loss").length;
    console.log(`  score ${sc}:  n=${String(g.length).padStart(3)}  win ${pct(w, w + l).padStart(6)}`);
  }

  // Per factor: win rate when present vs absent (does the factor add edge?)
  console.log("\nPer-factor edge (decisive win rate present vs absent):");
  console.log("  factor              present        absent        edge");
  const decisive = signals.filter((s) => s.outcome !== "timeout");
  for (const f of FACTORS) {
    if (f === "rejection") continue; // always present
    const withF = decisive.filter((s) => s.present[f]);
    const woF = decisive.filter((s) => !s.present[f]);
    const wr = (arr: Signal[]) => arr.filter((s) => s.outcome === "win").length / (arr.length || 1);
    const edge = withF.length && woF.length ? (wr(withF) - wr(woF)) * 100 : NaN;
    const p = withF.length ? `${(wr(withF) * 100).toFixed(1)}% (n=${withF.length})` : "—";
    const a = woF.length ? `${(wr(woF) * 100).toFixed(1)}% (n=${woF.length})` : "—";
    const e = Number.isFinite(edge) ? `${edge >= 0 ? "+" : ""}${edge.toFixed(1)}pp` : "—";
    console.log(`  ${f.padEnd(18)} ${p.padStart(12)}  ${a.padStart(12)}  ${e.padStart(8)}`);
  }

  const n = signals.length || 1;
  const tp = {
    r1: signals.filter((s) => s.maxR >= 1).length / n,
    r2: signals.filter((s) => s.maxR >= 2).length / n,
    r3: signals.filter((s) => s.maxR >= 3).length / n,
  };
  console.log(
    `\nTP reached before stop:  1R ${pct(signals.filter((s) => s.maxR >= 1).length, n)}` +
      `   2R ${pct(signals.filter((s) => s.maxR >= 2).length, n)}   3R ${pct(signals.filter((s) => s.maxR >= 3).length, n)}`,
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    symbol: config.symbol,
    interval: config.interval,
    params: { ...b },
    totals: { signals: signals.length, wins, losses, timeouts, winRate: wins / (wins + losses || 1) },
    tp,
    signals,
  };
  await mkdir(dirname(b.outFile), { recursive: true });
  await writeFile(b.outFile, JSON.stringify(summary, null, 2), "utf8");
  console.log(`\nSaved ${signals.length} signals → ${b.outFile}`);
}

main().catch((e) => {
  console.error(`backtest failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
