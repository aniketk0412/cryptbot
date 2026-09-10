import { config } from "./config.js";
import type { Candle, Range } from "./types.js";

/**
 * Measure the consolidation range from the last `lookback` CLOSED candles.
 * Resistance = the window's highest high; support = its lowest low. It only
 * counts as consolidating when that band is tight enough (and not dead-flat).
 */
/** Build a range from fixed, user-supplied levels (manual mode). */
export function manualRange(resistance: number, support: number): Range {
  const mid = (resistance + support) / 2;
  const widthPct = mid > 0 ? ((resistance - support) / mid) * 100 : 0;
  return {
    high: resistance,
    low: support,
    mid,
    widthPct,
    consolidating: resistance > support, // manual levels are always "in play"
    candlesUsed: 0,
  };
}

export function detectRange(candles: Candle[]): Range {
  const closed = candles.filter((c) => c.closed);
  const window = closed.slice(-config.lookback);

  if (window.length === 0) {
    return { high: 0, low: 0, mid: 0, widthPct: 0, consolidating: false, candlesUsed: 0 };
  }

  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  const mid = (high + low) / 2;
  const widthPct = mid > 0 ? ((high - low) / mid) * 100 : 0;

  const consolidating =
    window.length >= config.lookback &&
    widthPct <= config.maxRangeWidthPct &&
    widthPct >= config.minRangeWidthPct;

  return { high, low, mid, widthPct, consolidating, candlesUsed: window.length };
}
