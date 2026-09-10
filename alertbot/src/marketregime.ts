import { getKlines } from "./binance.js";
import { config } from "./config.js";
import type { MarketRegime } from "./paper.js";

/**
 * Causal broad-market regime for the opt-in `marketRegimeFilter` (paper engine). Builds an equal-weight
 * SOL/BTC/ETH basket PRICE INDEX from recent closes (rebalanced each bar, exactly as `npm run
 * regimeoverlay` measures it) and classifies its trailing `marketRegimeLookback`-bar return:
 * downtrend below −band → "bear" (the only regime where the bot has a measured edge), uptrend → "bull",
 * else "flat". Returns null if history is unavailable (→ filter no-ops that cycle). No lookahead: uses
 * only closed candles up to now.
 */
export async function computeMarketRegime(): Promise<{ regime: MarketRegime; trendPct: number; efficiency: number } | null> {
  const lookback = config.strategies.marketRegimeLookback;
  const band = config.strategies.marketRegimeBandPct / 100;
  const erLb = config.strategies.erLookback;
  const symbols = config.strategies.regimeSymbols; // crypto-only basket (decoupled from watchlist — see config)
  // Fetch enough history for whichever engine is active (trailing lookback vs the shorter ER window).
  const need = Math.max(lookback, erLb) + 5;
  const closes: number[][] = [];
  for (const s of symbols) {
    const c = await getKlines(need, config.interval, s);
    if (!c) return null;
    const cl = c.filter((x) => x.closed).map((x) => x.close);
    if (cl.length < Math.max(lookback, erLb) + 1) return null;
    closes.push(cl);
  }
  // Equal-weight, per-bar-rebalanced basket PRICE INDEX series (same construction the backtests use).
  const n = Math.min(...closes.map((c) => c.length));
  const index: number[] = [1];
  for (let k = 1; k < n; k++) {
    let r = 0;
    for (let i = 0; i < symbols.length; i++) r += closes[i]![k]! / closes[i]![k - 1]! - 1;
    index.push(index[k - 1]! * (1 + r / symbols.length));
  }
  const efficiency = efficiencyRatio(index, erLb);

  if (config.strategies.regimeMode === "er") {
    // Faster classifier: net move over the ER window sets DIRECTION; the ER magnitude sets conviction. Below `band`
    // net move OR low efficiency (< ~0.3, choppy) → flat. NB: UNMEASURED — see config note; validate before trusting.
    const window = index.slice(-(erLb + 1));
    const net = window.length > 1 ? window[window.length - 1]! / window[0]! - 1 : 0;
    const regime: MarketRegime = efficiency < 0.3 || Math.abs(net) < band ? "flat" : net > 0 ? "bull" : "bear";
    return { regime, trendPct: net * 100, efficiency };
  }
  // Default "trail": trailing basket return over the (long) lookback — the measured classifier.
  const trail = index[n - 1]! / index[n - 1 - lookback]! - 1;
  return { regime: classifyRegime(trail, band), trendPct: trail * 100, efficiency };
}

/** Pure classifier (exposed for tests): trailing basket return → regime, given `band` as a fraction. */
export function classifyRegime(trailReturn: number, band: number): MarketRegime {
  return trailReturn > band ? "bull" : trailReturn < -band ? "bear" : "flat";
}

/**
 * Kaufman Efficiency Ratio over the last `lookback` values (pure, exposed for tests): the net directional move
 * divided by the total path length (sum of absolute step-to-step moves). 1 = a perfectly straight/efficient trend,
 * ~0 = pure chop with no net progress. Used by the "er" regime mode and (opt-in) efficiency-scaled sizing.
 */
export function efficiencyRatio(values: number[], lookback: number): number {
  if (lookback < 1 || values.length < lookback + 1) return 0;
  const seg = values.slice(-(lookback + 1));
  const net = Math.abs(seg[seg.length - 1]! - seg[0]!);
  let path = 0;
  for (let i = 1; i < seg.length; i++) path += Math.abs(seg[i]! - seg[i - 1]!);
  return path > 0 ? net / path : 0;
}
