import { config } from "./config.js";
import type { Candle } from "./types.js";

/**
 * Fetch recent candles from Binance USDⓈ-M futures. The LAST element is the
 * currently-forming candle (its high/low update live); earlier ones are closed.
 * Returns null on any network/API error (caller retries next poll).
 */
export async function getKlines(
  limit = 60,
  interval: string = config.interval,
  symbol: string = config.symbol,
): Promise<Candle[] | null> {
  const url =
    `${config.binanceBaseUrl}/fapi/v1/klines` +
    `?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const raw = (await res.json()) as unknown[];
    if (!Array.isArray(raw)) return null;
    const now = Date.now();
    return raw.map((k) => {
      const a = k as (string | number)[];
      const closeTime = Number(a[6]);
      return {
        openTime: Number(a[0]),
        open: Number(a[1]),
        high: Number(a[2]),
        low: Number(a[3]),
        close: Number(a[4]),
        volume: Number(a[5]),
        takerBuyVolume: Number(a[9]),
        closeTime,
        closed: now > closeTime,
      } satisfies Candle;
    });
  } catch {
    return null;
  }
}

/** Small helper for other futures endpoints (depth, open interest, funding…). */
export async function fapiJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${config.binanceBaseUrl}${path}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
