import type { Candle } from "./types.js";

export interface VolProfile {
  poc: number; // Point of Control — the price level with the most traded volume
  vah: number; // Value Area High
  val: number; // Value Area Low
}

/**
 * Volume Profile over a window of candles. Each candle's volume is spread evenly
 * across its high–low range into price bins; the fullest bin is the Point of
 * Control, and the Value Area is the contiguous ~70% of volume around it. POC/VAH/VAL
 * are where price actually did business — higher-quality S/R than raw swing highs/lows.
 */
export function volumeProfile(candles: Candle[], bins = 50, valueAreaPct = 0.7): VolProfile | null {
  if (candles.length < 10) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) {
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
  }
  if (!(hi > lo)) return null;

  const width = (hi - lo) / bins;
  const vol: number[] = new Array(bins).fill(0);
  for (const c of candles) {
    const range = Math.max(c.high - c.low, width * 0.001);
    const perUnit = c.volume / range; // volume per price unit for this candle
    const b0 = Math.max(0, Math.floor((c.low - lo) / width));
    const b1 = Math.min(bins - 1, Math.floor((c.high - lo) / width));
    for (let b = b0; b <= b1; b++) {
      const binLo = lo + b * width;
      const overlap = Math.min(c.high, binLo + width) - Math.max(c.low, binLo);
      if (overlap > 0) vol[b]! += perUnit * overlap;
    }
  }

  let pocBin = 0;
  for (let b = 1; b < bins; b++) if (vol[b]! > vol[pocBin]!) pocBin = b;

  const total = vol.reduce((a, b) => a + b, 0);
  const target = total * valueAreaPct;
  let loB = pocBin;
  let hiB = pocBin;
  let acc = vol[pocBin]!;
  while (acc < target && (loB > 0 || hiB < bins - 1)) {
    const below = loB > 0 ? vol[loB - 1]! : -1;
    const above = hiB < bins - 1 ? vol[hiB + 1]! : -1;
    if (above >= below) { hiB++; acc += Math.max(0, above); }
    else { loB--; acc += Math.max(0, below); }
  }

  const price = (b: number) => lo + (b + 0.5) * width;
  return { poc: price(pocBin), vah: price(hiB), val: price(loB) };
}
