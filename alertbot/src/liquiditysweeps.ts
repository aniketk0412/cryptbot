import { config } from "./config.js";
import { pivotHighs, pivotLows } from "./indicators.js";
import type { Candle } from "./types.js";

export interface Sweep {
  type: "bull" | "bear";
  level: number; // the swept pivot price
  time: number; // closeTime of the sweeping candle
  barsAgo: number;
}

/**
 * Liquidity Sweeps — port of LuxAlgo's indicator ("Only Wicks" mode).
 *   Bearish sweep: a candle's HIGH pokes above a pivot high but it CLOSES below
 *                  it → buy-side liquidity grabbed, rejection (bearish).
 *   Bullish sweep: a candle's LOW pokes below a pivot low but it CLOSES back
 *                  above it → sell-side liquidity grabbed, rejection (bullish).
 * Pivots use swing length `len` (needs `len` bars either side to confirm).
 */
export function findSweeps(candles: Candle[]): Sweep[] {
  const c = candles.filter((x) => x.closed);
  const n = c.length;
  const len = config.sweeps.len;
  if (n < len * 2 + 2) return [];

  const highs = c.map((x) => x.high);
  const lows = c.map((x) => x.low);
  const out: Sweep[] = [];

  for (const pi of pivotHighs(highs, len, len)) {
    const p = highs[pi]!;
    for (let j = pi + len + 1; j < n; j++) {
      if (c[j]!.close > p) break; // pivot broken/mitigated before a wick-sweep
      if (c[j]!.high > p && c[j]!.close < p) {
        out.push({ type: "bear", level: p, time: c[j]!.closeTime, barsAgo: n - 1 - j });
        break;
      }
    }
  }
  for (const pi of pivotLows(lows, len, len)) {
    const p = lows[pi]!;
    for (let j = pi + len + 1; j < n; j++) {
      if (c[j]!.close < p) break;
      if (c[j]!.low < p && c[j]!.close > p) {
        out.push({ type: "bull", level: p, time: c[j]!.closeTime, barsAgo: n - 1 - j });
        break;
      }
    }
  }

  out.sort((a, b) => b.time - a.time);
  return out.slice(0, 20);
}

// ---- Stateful wrapper: track the latest sweep per symbol + a timestamped log ----
const lastTime = new Map<string, number>();
const primed = new Set<string>();
const sweepLog: (Sweep & { symbol: string })[] = [];

export function checkSweeps(symbol: string, candles: Candle[]): { latest: Sweep | null; isNew: boolean } {
  const sweeps = findSweeps(candles);
  const latest = sweeps[0] ?? null;
  let isNew = false;

  if (!primed.has(symbol)) {
    // Seed history for the dashboard on first run; don't notify for old sweeps.
    for (const s of sweeps) sweepLog.push({ ...s, symbol });
    if (sweepLog.length > 100) sweepLog.length = 100;
    if (latest) lastTime.set(symbol, latest.time);
    primed.add(symbol);
  } else if (latest && latest.time > (lastTime.get(symbol) ?? 0)) {
    isNew = true;
    lastTime.set(symbol, latest.time);
    sweepLog.unshift({ ...latest, symbol });
    if (sweepLog.length > 100) sweepLog.length = 100;
  }
  return { latest, isNew };
}

export function getSweepLog(): (Sweep & { symbol: string })[] {
  return [...sweepLog].sort((a, b) => b.time - a.time).slice(0, 40);
}
