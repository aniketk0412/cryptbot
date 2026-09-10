import { getKlines } from "./binance.js";
import { config } from "./config.js";
import { emaLast } from "./indicators.js";
import type { ConfluenceFactor, Level } from "./types.js";

/**
 * Higher-timeframe bias: is the HTF trending the same way the trade wants to go?
 * Buying support wants HTF up; selling resistance wants HTF down. Trend = price
 * vs an EMA on the higher timeframe. Usually the single biggest probability tilt.
 */
export async function htfFactor(level: Level, symbol: string = config.symbol): Promise<ConfluenceFactor> {
  const tf = config.structure.htfInterval;
  const candles = await getKlines(config.structure.htfEmaPeriod * 3, tf, symbol);
  const closed = (candles ?? []).filter((c) => c.closed);
  if (closed.length < config.structure.htfEmaPeriod) return { ok: false, label: `HTF ${tf} n/a` };

  const closes = closed.map((c) => c.close);
  const ema = emaLast(closes, config.structure.htfEmaPeriod);
  const price = closes[closes.length - 1]!;
  const up = price > ema;
  const ok = level === "support" ? up : !up;
  return { ok, label: `HTF ${tf} ${up ? "up" : "down"}` };
}
