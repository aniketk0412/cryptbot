import { config } from "./config.js";
import type { Candle, Range } from "./types.js";

const tol = () => config.touchTolerancePct / 100;

/** Did price come within tolerance of (or exceed) resistance? */
export function touchedResistance(high: number, range: Range): boolean {
  return high >= range.high * (1 - tol());
}

/** Did price come within tolerance of (or drop below) support? */
export function touchedSupport(low: number, range: Range): boolean {
  return low <= range.low * (1 + tol());
}

/**
 * Confirmation at resistance: a CLOSED candle that poked the level but was
 * rejected — closed back below resistance AND closed bearish (red). That's the
 * "the level held, sellers stepped in" signal.
 */
export function confirmsResistance(c: Candle, range: Range): boolean {
  const touched = c.high >= range.high * (1 - tol());
  const rejected = c.close < range.high;
  const bearish = c.close < c.open;
  return touched && rejected && bearish;
}

/** Confirmation at support: poked below, closed back above, closed bullish (green). */
export function confirmsSupport(c: Candle, range: Range): boolean {
  const touched = c.low <= range.low * (1 + tol());
  const rejected = c.close > range.low;
  const bullish = c.close > c.open;
  return touched && rejected && bullish;
}

/** Breakout up: a candle CLOSED above resistance by the breakout margin. */
export function brokeUp(c: Candle, range: Range): boolean {
  return c.close > range.high * (1 + config.breakoutMarginPct / 100);
}

/** Breakdown: a candle CLOSED below support by the breakout margin. */
export function brokeDown(c: Candle, range: Range): boolean {
  return c.close < range.low * (1 - config.breakoutMarginPct / 100);
}
