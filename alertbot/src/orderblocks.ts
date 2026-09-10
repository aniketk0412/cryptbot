import { config } from "./config.js";
import type { Candle } from "./types.js";

export interface OrderBlock {
  type: "bull" | "bear";
  high: number;
  avg: number; // equilibrium
  low: number;
  barsAgo: number;
}

/**
 * Order Block Finder — faithful port of wugamlo's TradingView indicator.
 *   Bullish OB = the last DOWN candle before `periods` consecutive UP candles
 *                (a buy zone; range = open→low, or high→low with useWicks).
 *   Bearish OB = the last UP candle before `periods` consecutive DOWN candles
 *                (a sell zone; range = high→open, or high→low with useWicks).
 * A minimum % move from the OB candle's close to the end of the sequence
 * (thresholdPct) validates the block. Returns the LATEST block of each type.
 *
 * Institutions often revisit these levels — good places for limit orders.
 */
export function findOrderBlocks(candles: Candle[]): { bull: OrderBlock | null; bear: OrderBlock | null } {
  const c = candles.filter((x) => x.closed);
  const n = c.length;
  const p = config.orderblocks.periods;
  const thr = config.orderblocks.thresholdPct;
  const wicks = config.orderblocks.useWicks;

  let bull: OrderBlock | null = null;
  let bear: OrderBlock | null = null;

  // Scan detection bars from most recent backward; keep the latest of each type.
  for (let d = n - 1; d >= p + 1 && (!bull || !bear); d--) {
    const ob = c[d - p - 1]!; // the order-block candle ([periods+1] back)
    const lastSeq = c[d - 1]!; // last candle of the sequence ([1] back)
    if (ob.close === 0) continue;
    const absmove = (Math.abs(ob.close - lastSeq.close) / ob.close) * 100;
    if (absmove < thr) continue;

    let up = 0;
    let down = 0;
    for (let i = d - p; i <= d - 1; i++) {
      if (c[i]!.close > c[i]!.open) up++;
      else if (c[i]!.close < c[i]!.open) down++;
    }
    const barsAgo = n - 1 - (d - p - 1);

    if (!bull && ob.close < ob.open && up === p) {
      const high = wicks ? ob.high : ob.open;
      const low = ob.low;
      bull = { type: "bull", high, low, avg: (high + low) / 2, barsAgo };
    }
    if (!bear && ob.close > ob.open && down === p) {
      const high = ob.high;
      const low = wicks ? ob.low : ob.open;
      bear = { type: "bear", high, low, avg: (high + low) / 2, barsAgo };
    }
  }
  return { bull, bear };
}
