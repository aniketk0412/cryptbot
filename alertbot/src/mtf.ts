import { getKlines } from "./binance.js";
import { emaLast } from "./indicators.js";
import type { Candle } from "./types.js";

/**
 * MULTI-TIMEFRAME TREND CONTEXT — the "zoom in / zoom out" a trader glances at.
 * For each symbol we report the trend on 15m · 1h · 4h · 1d. The 4h and 1d bars are RESAMPLED from the
 * 1h candles the bot already fetches each cycle (zero extra requests, no lookahead); the 15m ("zoom in")
 * is a light cached fetch. Trend = EMA20 vs EMA50 with a small flat band. This is CONTEXT for the screen
 * (and, measured by `npm run mtfedge`, higher-TF agreement genuinely lifts the short edge).
 */
export type MtfDir = "up" | "down" | "flat";
export interface MtfTf {
  tf: string;
  dir: MtfDir;
}

function trendOf(closes: number[]): MtfDir {
  if (closes.length < 55) return "flat";
  const e20 = emaLast(closes, 20);
  const e50 = emaLast(closes, 50);
  if (!Number.isFinite(e20) || !Number.isFinite(e50) || e50 === 0) return "flat";
  const sep = (e20 - e50) / e50;
  if (sep > 0.001) return "up";
  if (sep < -0.001) return "down";
  return "flat";
}

/** Group every `n` closed candles into one higher-timeframe candle (e.g. 1h→4h at n=4, 1h→1d at n=24). */
function resample(c: Candle[], n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + n <= c.length; i += n) {
    const g = c.slice(i, i + n);
    out.push({
      ...g[n - 1]!,
      openTime: g[0]!.openTime,
      closeTime: g[n - 1]!.closeTime,
      open: g[0]!.open,
      high: Math.max(...g.map((x) => x.high)),
      low: Math.min(...g.map((x) => x.low)),
      close: g[n - 1]!.close,
      volume: g.reduce((s, x) => s + x.volume, 0),
      closed: true,
    });
  }
  return out;
}

// Small TTL cache for the 15m ("zoom in") fetch so we don't re-request every 20s cycle.
const cache = new Map<string, { at: number; c: Candle[] }>();
async function get15m(symbol: string, nowMs: number): Promise<Candle[] | null> {
  const key = `${symbol}|15m`;
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < 45_000) return hit.c;
  const c = await getKlines(180, "15m", symbol).catch(() => null);
  if (c) cache.set(key, { at: nowMs, c });
  return c ?? hit?.c ?? null;
}

/** Multi-timeframe trend for a symbol. 1h/4h/1d are derived from `candles1h` (no extra fetch); 15m is cached-fetched. */
export async function mtfTrends(symbol: string, candles1h: Candle[]): Promise<MtfTf[]> {
  const c1h = candles1h.filter((c) => c.closed);
  const closes1h = c1h.map((c) => c.close);
  const out: MtfTf[] = [];
  const c15 = await get15m(symbol, Date.now());
  if (c15) out.push({ tf: "15m", dir: trendOf(c15.filter((c) => c.closed).map((c) => c.close)) });
  out.push({ tf: "1h", dir: trendOf(closes1h) });
  out.push({ tf: "4h", dir: trendOf(resample(c1h, 4).map((c) => c.close)) });
  out.push({ tf: "1d", dir: trendOf(resample(c1h, 24).map((c) => c.close)) });
  return out;
}
