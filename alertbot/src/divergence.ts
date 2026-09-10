import { cvdSeries, pivotHighs, pivotLows, rsiSeries } from "./indicators.js";
import type { Candle } from "./types.js";

export interface Divergence {
  indicator: "RSI" | "CVD";
  type: "bullish" | "bearish";
  note: string;
}

/**
 * Regular divergence between price and an oscillator/flow series, from the last
 * two confirmed price pivots:
 *   bearish → price higher high, indicator lower high  (momentum fading up)
 *   bullish → price lower low,   indicator higher low  (selling exhausting)
 * Checked for both RSI and CVD.
 */
export function detectDivergences(candles: Candle[]): Divergence[] {
  const closed = candles.filter((c) => c.closed);
  if (closed.length < 30) return [];

  const highs = closed.map((c) => c.high);
  const lows = closed.map((c) => c.low);
  const series: Record<"RSI" | "CVD", number[]> = {
    RSI: rsiSeries(closed.map((c) => c.close)),
    CVD: cvdSeries(closed),
  };

  const out: Divergence[] = [];
  for (const name of ["RSI", "CVD"] as const) {
    const ind = series[name];

    const ph = pivotHighs(highs).slice(-2);
    if (ph.length === 2) {
      const [a, b] = ph as [number, number];
      if (highs[b]! > highs[a]! && Number.isFinite(ind[a]!) && Number.isFinite(ind[b]!) && ind[b]! < ind[a]!) {
        out.push({ indicator: name, type: "bearish", note: `price HH · ${name} LH` });
      }
    }

    const pl = pivotLows(lows).slice(-2);
    if (pl.length === 2) {
      const [a, b] = pl as [number, number];
      if (lows[b]! < lows[a]! && Number.isFinite(ind[a]!) && Number.isFinite(ind[b]!) && ind[b]! > ind[a]!) {
        out.push({ indicator: name, type: "bullish", note: `price LL · ${name} HL` });
      }
    }
  }
  return out;
}
