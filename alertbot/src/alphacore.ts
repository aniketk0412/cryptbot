import { getKlines } from "./binance.js";
import { config } from "./config.js";
import { buildConfirmPlan } from "./plan.js";
import { detectRange } from "./range.js";
import { confirmsResistance, confirmsSupport } from "./signals.js";
import { STRATEGIES } from "./strategies.js";
import { correlatedCapReached, resolveExit } from "./paperexit.js";
import type { Candle } from "./types.js";

/**
 * Shared engine for the alpha/beta tools (`npm run alpha`, `npm run regimealpha`): signal generation,
 * an instrumented portfolio simulation that records a per-bar mark-to-market equity + exposure, plain-OLS
 * regression, and deep-history fetch. Kept in one place so the single-window and sliding-window tools
 * can't drift apart. All logic mirrors portfolio.ts (cap off) so returns reconcile with `npm run portfolio`.
 */

export const WARMUP = 60; // strategies need up to ~60 candles of lookback before they emit signals

export interface Signal { symbol: string; long: boolean; entry: number; stop: number; target: number; source: string }
interface Position extends Signal { openI: number; sizeUnits: number }

/** Signals at the newest candle of `window` — mirrors portfolio.ts (strategies + honest-close S/R confirmations). */
export function signalsAt(symbol: string, window: Candle[]): Signal[] {
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
      out.push({ symbol, long: s.direction === "LONG", entry: s.entry, stop: s.stop, target: s.target, source: s.strategy });
    }
  }
  if (config.paper.takeConfirmations) {
    const range = detectRange(window);
    if (range.consolidating) {
      let level: "support" | "resistance" | null = null;
      if (confirmsSupport(last, range)) level = "support";
      else if (confirmsResistance(last, range)) level = "resistance";
      if (level) {
        const p = buildConfirmPlan(level, range, last.close, true); // honest close fill (see npm run confirmedge)
        const risk = Math.abs(p.entry - p.stop);
        const reward = Math.abs(p.target - p.entry);
        if (risk > 0 && reward / risk >= config.paper.minRR) {
          out.push({ symbol, long: p.direction === "LONG", entry: p.entry, stop: p.stop, target: p.target, source: level });
        }
      }
    }
  }
  return out;
}

/** Precompute signals at every candle (index i uses only candles 0..i) for a symbol's full series. */
export function precomputeSignals(symbol: string, candles: Candle[]): Signal[][] {
  const arr: Signal[][] = [];
  for (let i = 0; i < candles.length; i++) arr[i] = i >= WARMUP ? signalsAt(symbol, candles.slice(0, i + 1)) : [];
  return arr;
}

export interface SimResult {
  rBot: number[]; // per-bar bot return (mark-to-market equity)
  rMkt: number[]; // per-bar equal-weight basket return, same bars
  active: boolean[]; // was the bot carrying a position INTO this bar?
  netExp: number[]; // signed net notional / equity (+long, -short)
  grossExp: number[]; // gross notional / equity
  equityStart: number;
  equityEnd: number;
  maxDD: number;
  trades: number;
  bars: number;
}

/**
 * Replay the portfolio sim (correlation cap OFF) over candle indices [a..b] inclusive, starting fresh at
 * `startBalance`, recording a per-candle mark-to-market equity + exposure. `sigAt[symbol][i]` are signals
 * precomputed with full lookback. Positions still open at `b` are marked-to-market (not force-closed).
 */
export function simulateWindow(
  bySym: Record<string, Candle[]>,
  sigAt: Record<string, Signal[][]>,
  symbols: string[],
  a: number,
  b: number,
  startBalance: number = config.paper.startBalanceUsd,
  allowEntry?: (i: number, long: boolean, source: string) => boolean, // optional causal gate; default = allow all
): SimResult {
  const feeRate = config.paper.feeBps / 10000;
  const slip = config.paper.slippageBps / 10000;
  const cap = symbols.length; // cap OFF (matches portfolio.ts "off" row → the headline number)
  let balance = startBalance;
  const open: Position[] = [];

  const rBot: number[] = [], rMkt: number[] = [], netExp: number[] = [], grossExp: number[] = [];
  const active: boolean[] = [];
  const equityCurve: number[] = [];
  let prevEquity = startBalance;
  let trades = 0;

  for (let i = a; i <= b; i++) {
    const carriedIn = open.length > 0;

    // 1) Exits — each open position (opened earlier) vs ITS symbol's candle i.
    for (let k = open.length - 1; k >= 0; k--) {
      const p = open[k]!;
      if (i <= p.openI) continue;
      const c = bySym[p.symbol]![i]!;
      const hit = resolveExit(p.long, p.stop, p.target, c.low, c.high, slip);
      if (hit) {
        const fees = feeRate * p.sizeUnits * (p.entry + hit.exit);
        balance += (p.long ? 1 : -1) * (hit.exit - p.entry) * p.sizeUnits - fees;
        trades++;
        open.splice(k, 1);
      }
    }

    // 2) Entries — signals at candle i (maxOpenPerSymbol + correlation cap, cap off here).
    for (const sym of symbols) {
      for (const sig of sigAt[sym]![i]!) {
        if (allowEntry && !allowEntry(i, sig.long, sig.source)) continue;
        if (open.filter((o) => o.symbol === sym).length >= config.paper.maxOpenPerSymbol) continue;
        const dir = sig.long ? "LONG" : "SHORT";
        if (correlatedCapReached(open.map((o) => ({ direction: o.long ? "LONG" : "SHORT" })), dir, cap)) continue;
        const risk = Math.abs(sig.entry - sig.stop);
        if (risk <= 0) continue;
        const riskUsd = (balance * config.paper.riskPct) / 100;
        open.push({ ...sig, openI: i, sizeUnits: riskUsd / risk });
      }
    }

    // 3) Mark to market at candle i's close.
    let unreal = 0, net = 0, gross = 0;
    for (const p of open) {
      const px = bySym[p.symbol]![i]!.close;
      unreal += (p.long ? 1 : -1) * (px - p.entry) * p.sizeUnits;
      const notional = p.sizeUnits * px;
      net += (p.long ? 1 : -1) * notional;
      gross += notional;
    }
    const equity = balance + unreal;
    equityCurve.push(equity);

    // 4) Per-bar returns.
    let mkt = 0;
    for (const s of symbols) { const c = bySym[s]!; mkt += c[i]!.close / c[i - 1]!.close - 1; }
    mkt /= symbols.length;
    rBot.push(prevEquity > 0 ? equity / prevEquity - 1 : 0);
    rMkt.push(mkt);
    active.push(carriedIn);
    netExp.push(equity > 0 ? net / equity : 0);
    grossExp.push(equity > 0 ? gross / equity : 0);
    prevEquity = equity;
  }

  let peak = startBalance, maxDD = 0;
  for (const e of equityCurve) {
    if (e > peak) peak = e;
    const dd = peak > 0 ? ((peak - e) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return {
    rBot, rMkt, active, netExp, grossExp,
    equityStart: startBalance,
    equityEnd: equityCurve[equityCurve.length - 1] ?? startBalance,
    maxDD, trades, bars: rBot.length,
  };
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Align several symbols onto their common openTimes (Binance candles are synced, but be safe). */
export function alignByTime(bySymRaw: Record<string, Candle[]>, symbols: string[]): Record<string, Candle[]> {
  const times = symbols.map((s) => new Set(bySymRaw[s]!.map((c) => c.openTime)));
  const common = [...times[0]!].filter((t) => times.every((set) => set.has(t))).sort((a, b) => a - b);
  const out: Record<string, Candle[]> = {};
  for (const s of symbols) {
    const map = new Map(bySymRaw[s]!.map((c) => [c.openTime, c]));
    out[s] = common.map((t) => map.get(t)!);
  }
  return out;
}

export interface Ols { n: number; alpha: number; beta: number; r2: number; corr: number; seAlpha: number; tAlpha: number; tBeta: number }

/** Plain-code OLS of y on x:  y = alpha + beta·x + ε.  SEs via residual variance (normal-approx t). */
export function ols(y: number[], x: number[]): Ols {
  const n = Math.min(y.length, x.length);
  const mx = mean(x), my = mean(y);
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx, dy = y[i]! - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const beta = sxx > 0 ? sxy / sxx : 0;
  const alpha = my - beta * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) { const e = y[i]! - (alpha + beta * x[i]!); sse += e * e; }
  const r2 = syy > 0 ? Math.max(0, Math.min(1, 1 - sse / syy)) : 0;
  const corr = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
  const s2 = n > 2 ? sse / (n - 2) : 0;
  const seBeta = sxx > 0 ? Math.sqrt(s2 / sxx) : 0;
  const seAlpha = sxx > 0 ? Math.sqrt(s2 * (1 / n + (mx * mx) / sxx)) : 0;
  return { n, alpha, beta, r2, corr, seAlpha, tAlpha: seAlpha > 0 ? alpha / seAlpha : 0, tBeta: seBeta > 0 ? beta / seBeta : 0 };
}

/**
 * Fetch up to `target` recent CLOSED candles by paging backward with endTime (Binance caps 1500/req).
 * Returns oldest→newest. Null if the first request fails.
 */
export async function fetchDeepHistory(symbol: string, interval: string, target: number): Promise<Candle[] | null> {
  const first = await getKlines(1500, interval, symbol);
  if (!first) return null;
  let all = first.filter((c) => c.closed);
  while (all.length < target && all[0]) {
    const endTime = all[0].openTime - 1;
    const url =
      `${config.binanceBaseUrl}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}` +
      `&interval=${encodeURIComponent(interval)}&limit=1500&endTime=${endTime}`;
    let batch: Candle[] = [];
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) break;
      const raw = (await res.json()) as unknown[];
      if (!Array.isArray(raw) || raw.length === 0) break;
      batch = raw.map((k) => {
        const arr = k as (string | number)[];
        return {
          openTime: Number(arr[0]), open: Number(arr[1]), high: Number(arr[2]), low: Number(arr[3]),
          close: Number(arr[4]), volume: Number(arr[5]), takerBuyVolume: Number(arr[9]),
          closeTime: Number(arr[6]), closed: true,
        } satisfies Candle;
      });
    } catch {
      break;
    }
    if (batch.length === 0) break;
    all = [...batch, ...all];
  }
  return all;
}
