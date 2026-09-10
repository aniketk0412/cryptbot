import type { Candle } from "./types.js";

/** Exponential moving average — full series. */
export function emaSeries(values: number[], period: number): number[] {
  const out: number[] = [];
  if (values.length === 0) return out;
  const k = 2 / (period + 1);
  let e = values[0]!;
  out.push(e);
  for (let i = 1; i < values.length; i++) {
    e = values[i]! * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

export function emaLast(values: number[], period: number): number {
  const s = emaSeries(values, period);
  return s.length ? s[s.length - 1]! : NaN;
}

/** Wilder RSI — full series (NaN until enough data). */
export function rsiSeries(closes: number[], period = 14): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

/** Cumulative volume delta (aggressive buy − sell), running series. */
export function cvdSeries(candles: Candle[]): number[] {
  let c = 0;
  return candles.map((k) => {
    c += 2 * k.takerBuyVolume - k.volume;
    return c;
  });
}

/** Average True Range (Wilder). */
export function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return NaN;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i]!.high;
    const l = candles[i]!.low;
    const pc = candles[i - 1]!.close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]!) / period;
  return a;
}

/** Volume-weighted average price over the given candles. */
export function vwap(candles: Candle[]): number {
  let pv = 0;
  let v = 0;
  for (const k of candles) {
    const tp = (k.high + k.low + k.close) / 3;
    pv += tp * k.volume;
    v += k.volume;
  }
  return v > 0 ? pv / v : NaN;
}

/** Simple moving average of the last `period` values. */
export function sma(values: number[], period: number): number {
  const w = values.slice(-period);
  if (w.length === 0) return NaN;
  return w.reduce((a, b) => a + b, 0) / w.length;
}

/** Population standard deviation of the last `period` values. */
export function stdev(values: number[], period: number): number {
  const w = values.slice(-period);
  if (w.length === 0) return NaN;
  const m = w.reduce((a, b) => a + b, 0) / w.length;
  const v = w.reduce((a, b) => a + (b - m) * (b - m), 0) / w.length;
  return Math.sqrt(v);
}

/** Indices of pivot highs (a bar higher than `left` before and `right` after). */
export function pivotHighs(vals: number[], left = 2, right = 2): number[] {
  const idx: number[] = [];
  for (let i = left; i < vals.length - right; i++) {
    let ok = true;
    for (let j = 1; j <= left && ok; j++) if (vals[i - j]! >= vals[i]!) ok = false;
    for (let j = 1; j <= right && ok; j++) if (vals[i + j]! > vals[i]!) ok = false;
    if (ok) idx.push(i);
  }
  return idx;
}

/** Indices of pivot lows. */
export function pivotLows(vals: number[], left = 2, right = 2): number[] {
  const idx: number[] = [];
  for (let i = left; i < vals.length - right; i++) {
    let ok = true;
    for (let j = 1; j <= left && ok; j++) if (vals[i - j]! <= vals[i]!) ok = false;
    for (let j = 1; j <= right && ok; j++) if (vals[i + j]! < vals[i]!) ok = false;
    if (ok) idx.push(i);
  }
  return idx;
}
